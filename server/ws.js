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
    ws.send(JSON.stringify({ type: "hello", config: { workspaceRoot: config.workspaceRoot } }));

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
      const id = SessionManager.start({ cwd, sessionId: msg.sessionId, model: msg.model });
      subscribe(ws, id);
      const sess = SessionManager.get(id);
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: id,
          cwd,
          model: sess?.model,
          resumed: !!msg.sessionId,
        }),
      );
      // On resume, Claude doesn't replay the prior transcript, so load it from
      // the on-disk JSONL log and ship it to the client to populate the view.
      if (msg.sessionId) {
        const messages = SessionManager.history(id);
        ws.send(JSON.stringify({ type: "history", sessionId: id, messages }));
      }
      return;
    }

    case "send": {
      if (!msg.sessionId) return ws.send(JSON.stringify({ type: "error", message: "no sessionId" }));
      if (!ID_RE.test(msg.sessionId)) return ws.send(JSON.stringify({ type: "error", message: "invalid sessionId" }));
      const text = typeof msg.text === "string" ? msg.text : "";
      // Normalize + validate inline base64 image attachments. Each entry must
      // be {mediaType:"image/*", data:"<base64 no data: prefix>"}. Cap total
      // payload so a huge paste can't blow up the WS frame / spawn stdin.
      const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB of base64 chars
      const images = [];
      let total = 0;
      if (Array.isArray(msg.images)) {
        for (const im of msg.images) {
          if (!im || typeof im.data !== "string") continue;
          const mediaType = String(im.mediaType || "");
          if (!mediaType.startsWith("image/")) continue;
          // Tolerate a stray data: URL prefix by stripping it.
          const data = im.data.startsWith("data:") ? im.data.split(",", 2)[1] : im.data;
          if (!data) continue;
          total += data.length;
          if (total > MAX_IMAGE_BYTES) {
            return ws.send(
              JSON.stringify({ type: "error", message: "image attachments exceed 20 MB total" }),
            );
          }
          images.push({ mediaType, data });
        }
      }
      const ok = SessionManager.send(msg.sessionId, text, images);
      if (!ok) ws.send(JSON.stringify({ type: "error", message: "send failed" }));
      return;
    }

    case "stop": {
      if (msg.sessionId && ID_RE.test(msg.sessionId)) SessionManager.stop(msg.sessionId);
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
      const sess = SessionManager.get(msg.sessionId);
      if (!sess) return ws.send(JSON.stringify({ type: "error", message: "no such session" }));
      subscribe(ws, msg.sessionId);
      ws.send(
        JSON.stringify({
          type: "session",
          sessionId: msg.sessionId,
          cwd: sess.cwd,
          model: sess.model,
          resumed: true,
          busy: !!sess.busy,
        }),
      );
      const messages = SessionManager.history(msg.sessionId);
      ws.send(JSON.stringify({ type: "history", sessionId: msg.sessionId, messages }));
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
}