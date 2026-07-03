import { WebSocketServer } from "ws";
import { SessionManager, statusBus } from "./sessions.js";
import { config } from "./config.js";
import { confineCwd } from "./util.js";

// sessionId values are joined into filesystem paths and passed to `claude
// --resume/--session-id`; only accept a safe charset from clients.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * @type {Map<string, {ws: WebSocket, fn: (evt:any)=>void, sess: object}>}
 * keyed by the sessionId the listener was attached under. We store the Session
 * reference (not just the id) so detaching works even after a rename rewrites
 * the SessionManager's map key — without this the old id no longer resolves and
 * `.off` becomes a no-op, leaving a stale listener that double-delivers every
 * event on the next subscribe.
 */
const listeners = new Map();

// noServer mode: index.js owns the single 'upgrade' dispatcher that routes
// /ws and /term to their respective WSS instances (two {server,path} WSS would
// each abort the other's path with a 400 handshake).
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set();

  // Broadcast the session list to every connected client whenever a session's
  // busy/ended state changes (see sessions.js statusBus). This is what makes a
  // BACKGROUND session's working/idle status visible to clients that aren't
  // subscribed to it — e.g. you switched to another chat while one kept running.
  function broadcastSessions() {
    const payload = JSON.stringify({ type: "sessions", items: SessionManager.list() });
    for (const c of clients) {
      if (c.readyState === c.OPEN) c.send(payload);
    }
  }
  statusBus.on("change", broadcastSessions);

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        config: { workspaceRoot: config.workspaceRoot, confirmTools: config.confirmTools, visionModels: config.visionModels },
      }),
    );

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.send(JSON.stringify({ type: "error", message: "bad json" }));
      }
      handle(ws, msg).catch((e) =>
        ws.send(JSON.stringify({ type: "error", message: e.message || String(e) })),
      );
    });

    ws.on("close", () => {
      clients.delete(ws);
      // drop this connection's listener but keep the subprocess alive for resume
      for (const [id, entry] of listeners) {
        if (entry.ws === ws) {
          entry.sess.off("event", entry.fn);
          listeners.delete(id);
        }
      }
    });
  });
  return wss;
}

async function handle(ws, msg) {
  switch (msg.type) {
    case "list":
      return ws.send(JSON.stringify({ type: "sessions", items: SessionManager.list() }));

    case "start": {
      // Confine cwd to WORKSPACE_ROOT so an authed client can't spawn claude
      // with its working directory (and --add-dir) set to /, /etc, etc.
      const cwd = confineCwd(msg.cwd || config.workspaceRoot);
      if (!cwd) return ws.send(JSON.stringify({ type: "error", message: "workspace outside WORKSPACE_ROOT" }));
      if (msg.sessionId && !ID_RE.test(msg.sessionId))
        return ws.send(JSON.stringify({ type: "error", message: "invalid sessionId" }));
      const id = SessionManager.start({ cwd, sessionId: msg.sessionId, model: msg.model, confirm: msg.confirm });
      subscribe(ws, id);
      const sess = SessionManager.get(id);
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: id,
          cwd,
          model: sess?.model,
          confirm: !!sess?.confirm,
          resumed: !!msg.sessionId,
        }),
      );
      // On resume, Claude doesn't replay the prior transcript, so load it from
      // the on-disk JSONL log and ship it to the client to populate the view.
      // Ship only the recent tail (paginated) to keep the WS payload + DOM
      // small for long sessions; older messages load via `historyMore`.
      if (msg.sessionId) {
        const h = SessionManager.history(id, { limit: config.historyInitialSize });
        ws.send(
          JSON.stringify({
            type: "history",
            sessionId: id,
            messages: h.messages,
            oldestIndex: h.oldestIndex,
            hasMore: h.hasMore,
          }),
        );
      }
      return;
    }

    case "send": {
      if (!msg.sessionId) return ws.send(JSON.stringify({ type: "error", message: "no sessionId" }));
      if (!ID_RE.test(msg.sessionId)) return ws.send(JSON.stringify({ type: "error", message: "invalid sessionId" }));
      const text = typeof msg.text === "string" ? msg.text : "";
      // Normalize + validate inline base64 attachments. Each entry is
      // {mediaType, data:"<base64 no data: prefix>", name?}. image/* entries are
      // delivered to the model as image content blocks; anything else is read
      // by Session.send and inlined as a text block (text files) or a note
      // (binary), so non-image files work even on text-only models. Cap total
      // payload so a huge paste can't blow up the WS frame / spawn stdin.
      const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // 20 MB of base64 chars
      const attachments = [];
      let total = 0;
      if (Array.isArray(msg.attachments)) {
        for (const att of msg.attachments) {
          if (!att || typeof att.data !== "string") continue;
          const mediaType = String(att.mediaType || "");
          // Tolerate a stray data: URL prefix by stripping it.
          const data = att.data.startsWith("data:") ? att.data.split(",", 2)[1] : att.data;
          if (!data) continue;
          total += data.length;
          if (total > MAX_ATTACH_BYTES) {
            return ws.send(
              JSON.stringify({ type: "error", message: "attachments exceed 20 MB total" }),
            );
          }
          attachments.push({ mediaType, data, name: String(att.name || "") });
        }
      }
      const ok = await SessionManager.send(msg.sessionId, text, attachments);
      if (!ok) ws.send(JSON.stringify({ type: "error", message: "send failed" }));
      return;
    }

    case "stop": {
      if (msg.sessionId && ID_RE.test(msg.sessionId)) SessionManager.stop(msg.sessionId);
      return;
    }

    case "answer": {
      // Answer an in-flight control_request (a permission / AskUserQuestion
      // prompt claude streamed). `response` is the PermissionResult (or
      // request_user_dialog result) to forward as a control_response on stdin.
      if (!msg.sessionId || !ID_RE.test(msg.sessionId))
        return ws.send(JSON.stringify({ type: "error", message: "invalid sessionId" }));
      if (typeof msg.requestId !== "string" || !msg.requestId)
        return ws.send(JSON.stringify({ type: "error", message: "answer requires a requestId" }));
      if (!msg.response || typeof msg.response !== "object")
        return ws.send(JSON.stringify({ type: "error", message: "answer requires a response object" }));
      const ok = SessionManager.answerControl(msg.sessionId, msg.requestId, msg.response);
      if (!ok) ws.send(JSON.stringify({ type: "error", message: "answer failed" }));
      return;
    }

    case "remove": {
      // Permanently delete a session (stop its process, drop it from the list +
      // state, and delete its transcript). SessionManager.remove() emits a status
      // change that re-broadcasts the session list to every client, so all
      // sidebars drop the row without needing a separate ack.
      if (!msg.sessionId || !ID_RE.test(msg.sessionId))
        return ws.send(JSON.stringify({ type: "error", message: "invalid sessionId" }));
      SessionManager.remove(msg.sessionId);
      return;
    }

    case "subscribe": {
      // Re-attach to a session WITHOUT (re)spawning claude. Used when re-picking
      // a session that is already running in the background: the `start` action
      // would stop()+restart it and kill the in-flight turn, so the client sends
      // `subscribe` instead to re-attach the listener and replay on-disk history.
      if (!msg.sessionId || !ID_RE.test(msg.sessionId))
        return ws.send(JSON.stringify({ type: "error", message: "invalid sessionId" }));
      let sess = SessionManager.get(msg.sessionId);
      if (!sess) return ws.send(JSON.stringify({ type: "error", message: "no such session" }));
      // If the process isn't running (never started this boot, or ended/stopped),
      // (re)start it so the user can continue the conversation. A running background
      // process is left alone — we only re-attach the listener so its in-flight turn
      // keeps going (the whole point of background mode). Reusing the instance keeps
      // the just-attached listener valid for the new process's events.
      if (!sess.proc || sess.ended) {
        sess.ended = false;
        sess.busy = false;
        sess.bufChunks = [];
        sess.bufLen = 0;
        sess.pendingControl = [];
        sess.start();
        statusBus.emit("change");
      }
      subscribe(ws, msg.sessionId);
      sess = SessionManager.get(msg.sessionId) || sess;
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: msg.sessionId,
          cwd: sess.cwd,
          model: sess.model,
          confirm: !!sess.confirm,
          resumed: true,
          busy: !!sess.busy,
        }),
      );
      const h = SessionManager.history(msg.sessionId, { limit: config.historyInitialSize });
      ws.send(
        JSON.stringify({
          type: "history",
          sessionId: msg.sessionId,
          messages: h.messages,
          oldestIndex: h.oldestIndex,
          hasMore: h.hasMore,
        }),
      );
      return;
    }

    case "historyMore": {
      // Fetch an older page of a session's transcript (preceded by the "Load
      // older" button). `beforeIndex` is the front-indexed cursor of the
      // oldest message the client currently holds; we return up to
      // historyPageSize messages ending just before it.
      if (!msg.sessionId || !ID_RE.test(msg.sessionId))
        return ws.send(JSON.stringify({ type: "error", message: "invalid sessionId" }));
      const beforeIndex = Number(msg.beforeIndex);
      if (!Number.isFinite(beforeIndex) || beforeIndex < 0)
        return ws.send(JSON.stringify({ type: "error", message: "invalid beforeIndex" }));
      const h = SessionManager.history(msg.sessionId, {
        limit: config.historyPageSize,
        beforeIndex,
      });
      ws.send(
        JSON.stringify({
          type: "historyMore",
          sessionId: msg.sessionId,
          messages: h.messages,
          oldestIndex: h.oldestIndex,
          hasMore: h.hasMore,
        }),
      );
      return;
    }

    default:
      ws.send(JSON.stringify({ type: "error", message: `unknown type: ${msg.type}` }));
  }
}

function subscribe(ws, sessionId) {
  // remove old listener for this ws if any (detach from the actual Session
  // instance, which may have been re-keyed by a rename since we subscribed).
  for (const [id, entry] of listeners) {
    if (entry.ws === ws) {
      entry.sess.off("event", entry.fn);
      listeners.delete(id);
    }
  }
  const sess = SessionManager.get(sessionId);
  if (!sess) return;
  let key = sessionId;
  const entry = { ws, fn: null, sess };
  const fn = (evt) => {
    // If claude renamed this session (init reported a new id), follow it so the
    // listeners map stays keyed by the id the SessionManager now uses — a later
    // unsubscribe by the old id would otherwise miss and leak a stale listener
    // that double-delivers every event on the next subscribe.
    if (evt.type === "rename" && evt.oldId === key && evt.sessionId) {
      listeners.delete(evt.oldId);
      key = evt.sessionId;
      listeners.set(key, entry);
    }
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(evt));
  };
  entry.fn = fn;
  sess.on("event", fn);
  listeners.set(key, entry);
  // Replay any control_request (permission / AskUserQuestion) prompts that were
  // emitted while no listener was attached — e.g. a background confirm-mode
  // session that hit a Write tool while you were viewing another chat. Without
  // this replay the background claude deadlocks waiting for a control_response
  // that the user never sees, and re-subscribing wouldn't resurface the prompt
  // (history only covers completed messages). Use the post-rename `key`.
  for (const p of sess.pendingControl || []) {
    if (ws.readyState !== ws.OPEN) break;
    ws.send(
      JSON.stringify({
        type: "claude",
        data: { type: "control_request", request_id: p.request_id, request: p.request },
        sessionId: key,
      }),
    );
  }
}