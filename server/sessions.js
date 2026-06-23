import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { config, childEnv } from "./config.js";
import { buildClaudeArgs } from "./claude-args.js";

const STATE_FILE = resolve(config.workspaceRoot, ".coding-ui-sessions.json");

/** @type {Map<string, Session>} */
const sessions = new Map();

// Status bus: emits "change" whenever a session's busy/ended state transitions
// (send → busy, result/exit/error → idle/ended, plus start/rename). ws.js
// listens and broadcasts a fresh `sessions` list to every connected client, so
// a session running in the BACKGROUND (one the current page isn't subscribed
// to) still shows an accurate working/idle state in everyone's sidebar —
// without this, only the actively-subscribed session's busy is ever visible.
export const statusBus = new EventEmitter();
function emitStatus() {
  statusBus.emit("change");
}

// Claude Code stores each session's full transcript as JSONL under
// ~/.claude/projects/<cwd-with-slashes-as-dashes>/<sessionId>.jsonl. We read it
// to show prior conversation when a session is resumed (--resume does NOT replay
// history in stream-json print mode, so without this the main area stays empty).
// sessionId is joined into a path, so reject anything outside a safe charset
// (defense in depth — the HTTP caller is also validated upstream).
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
function sessionLogPath(cwd, sessionId) {
  const sid = String(sessionId || "");
  if (!ID_RE.test(sid)) return null; // caller treats null as "no transcript"
  const enc = String(cwd).replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", enc, `${sid}.jsonl`);
}

// Build a message list in the shape the web frontend already uses internally
// ({role:"user",text} and {role:"assistant",id,blocks,streaming}), matching
// tool_result records back onto their tool_use blocks so tool cards render
// with results. Non-user/assistant records (queue ops, attachments, system,
// ai-title, sidechain) are skipped.
function loadHistory(cwd, sessionId) {
  let raw;
  try {
    raw = readFileSync(sessionLogPath(cwd, sessionId), "utf8");
  } catch {
    return [];
  }
  const messages = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    let r;
    try {
      r = JSON.parse(text);
    } catch {
      continue;
    }
    if (r.isSidechain) continue;
    const content = r.message?.content;
    if (r.type === "user") {
      const blocks = Array.isArray(content) ? content : [];
      const hasToolResult = blocks.some((b) => b && b.type === "tool_result");
      if (hasToolResult) {
        for (const tr of blocks) {
          if (!tr || tr.type !== "tool_result") continue;
          for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m.role !== "assistant") continue;
            const bi = m.blocks.findIndex((b) => b.type === "tool_use" && b.id === tr.tool_use_id);
            if (bi >= 0) {
              m.blocks[bi] = { ...m.blocks[bi], result: tr.content, isError: !!tr.is_error, pending: false };
              break;
            }
          }
        }
      } else {
        const userText = blocks
          .filter((b) => b && b.type === "text")
          .map((b) => b.text || "")
          .join("");
        // Reference image blocks by URL (served lazily by GET /api/transcript/image)
        // rather than embedding base64 — keeps the history WS payload + DOM small.
        const images = [];
        blocks.forEach((b, i) => {
          if (b && b.type === "image" && b.source) {
            images.push({
              mediaType: b.source.media_type || "image/png",
              url: `/api/transcript/image?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sessionId)}&uuid=${encodeURIComponent(r.uuid)}&idx=${i}`,
            });
          }
        });
        if (userText) {
          const m = { role: "user", text: userText };
          if (images.length) m.images = images;
          messages.push(m);
        } else if (images.length) {
          messages.push({ role: "user", text: "", images });
        } else if (typeof content === "string" && content) {
          messages.push({ role: "user", text: content });
        }
      }
    } else if (r.type === "assistant") {
      const msg = r.message || {};
      const blocks = (Array.isArray(msg.content) ? msg.content : []).map((c) => {
        if (c.type === "text") return { type: "text", text: c.text || "" };
        if (c.type === "tool_use")
          return { type: "tool_use", id: c.id, name: c.name, input: c.input, pending: true };
        if (c.type === "thinking") return { type: "thinking", thinking: c.thinking || "" };
        return { type: "other", raw: c };
      });
      messages.push({ role: "assistant", id: msg.id || r.uuid, blocks, streaming: false });
    }
  }
  return messages;
}

// Serve a single image block from a session transcript as decoded bytes. Used by
// GET /api/transcript/image so resumed conversations can <img> past images
// without embedding multi-hundred-KB base64 in the history WS payload.
export function readTranscriptImage(cwd, sessionId, uuid, idx) {
  let raw;
  try {
    raw = readFileSync(sessionLogPath(cwd, sessionId), "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try {
      r = JSON.parse(t);
    } catch {
      continue;
    }
    if (r.uuid !== uuid) continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) return null;
    const block = content[idx];
    if (!block || block.type !== "image" || !block.source || !block.source.data) return null;
    try {
      return {
        mediaType: block.source.media_type || "image/png",
        buffer: Buffer.from(block.source.data, "base64"),
      };
    } catch {
      return null;
    }
  }
  return null;
}

function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const arr = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      for (const s of arr) {
        // Drop sessions whose transcript no longer exists. Resuming one of
        // these makes claude print "No conversation found" and exit, so every
        // follow-up send fails with "send failed" — prune them so the sidebar
        // only shows sessions that can actually be resumed.
        if (!existsSync(sessionLogPath(s.cwd, s.id) || "")) continue;
        // Restore as real Session instances (not plain objects) so the methods
        // used on resume — stop(), send() — exist. proc stays null: these are
        // not running, so stop() is a no-op until the session is re-picked and
        // SessionManager.start() spawns a fresh claude process for it.
        const sess = new Session({ id: s.id, cwd: s.cwd, resume: s.id, model: s.model });
        sess.title = s.title;
        sess.createdAt = s.createdAt;
        sessions.set(s.id, sess);
      }
      // Rewrite the file without the pruned entries.
      saveState();
    }
  } catch {
    /* ignore corrupt state */
  }
}
// Debounced state persistence. saveState() was called on every start/send/
// rename and did a synchronous full rewrite of the sessions file — coalesce a
// burst of calls into one trailing write so a streaming turn doesn't block the
// event loop repeatedly. saveStateNow() forces an immediate write (used on
// shutdown-sensitive paths if needed).
let saveTimer = null;
function saveStateNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const arr = [...sessions.values()].map(({ id, cwd, title, createdAt, model }) => ({
    id,
    cwd,
    title,
    createdAt,
    model,
  }));
  try {
    mkdirSync(config.workspaceRoot, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(arr, null, 2));
  } catch {
    /* non-fatal */
  }
}
function saveState() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveStateNow();
  }, 300).unref();
}
// NOTE: loadState() is invoked after the Session class below — class
// declarations are not hoisted, so it can't run before Session is defined.

class Session extends EventEmitter {
  constructor({ id, cwd, resume, model }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.resume = resume;
    this.model = model || config.anthropicModel;
    this.proc = null;
    this.bufChunks = [];
    this.bufLen = 0;
    this.busy = false;
    this.ended = false;
  }

  // Child env with this session's model overriding the global default. All four
  // model aliases are set so background/haiku calls hit a model that resolves on
  // the gateway (matches childEnv()'s single-model behavior).
  env() {
    return {
      ...childEnv(),
      ANTHROPIC_MODEL: this.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: this.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: this.model,
    };
  }

  start() {
    const args = buildClaudeArgs({ cwd: this.cwd, resume: this.resume, id: this.id });
    let proc;
    try {
      proc = spawn("claude", args, {
        cwd: this.cwd,
        env: this.env(),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      this.ended = true;
      this.busy = false;
      this.emit("event", { type: "error", message: `failed to start claude: ${e.message}` });
      return this.id;
    }
    this.proc = proc;

    // spawn()'s 'error' event fires async if the binary is missing or spawn
    // otherwise fails. Without a listener Node raises an uncaughtException
    // that crashes the whole server. Treat it as a terminal session error.
    proc.on("error", (e) => {
      this.ended = true;
      this.busy = false;
      this.emit("event", { type: "error", message: `claude process error: ${e.message}` });
      this.emit("event", { type: "exit", code: -1, signal: null });
      emitStatus();
    });
    // stdin/stdout errors (e.g. writing to a just-died pipe) must not become
    // uncaughtExceptions either.
    proc.stdin.on("error", () => {});
    proc.stdout.on("error", () => {});

    proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      // Claude Code writes progress/debug to stderr; surface only lines that
      // look like real errors. Keep the bar high so benign debug noise doesn't
      // spam the client's error toast.
      if (/\b(error|exception|cannot|failed|enoent|not found)\b/i.test(text)) {
        this.emit("event", { type: "error", message: text.trim().split("\n").slice(-3).join("\n") });
      } else {
        process.stderr.write(`[claude:${this.id.slice(0, 8)}] ${text}`);
      }
    });
    proc.on("exit", (code, signal) => {
      this.ended = true;
      this.busy = false;
      this.emit("event", {
        type: "exit",
        code,
        signal,
      });
      emitStatus();
    });

    return this.id;
  }

  _onStdout(chunk) {
    // Accumulate raw bytes and split on the newline *byte index*, decoding
    // only complete lines to utf8. The previous string accumulation
    // (`buffer += chunk.toString()`) corrupted multi-byte UTF-8 split across
    // chunks → garbled lines / silent JSON.parse drops for non-ASCII content.
    this.bufChunks.push(chunk);
    this.bufLen += chunk.length;
    // Process one complete line at a time, from the FIRST newline onward, so
    // multiple stream-json lines in a single chunk are each parsed separately
    // (concatenating them into one JSON.parse would drop them all).
    for (;;) {
      const nl = this._findFirstNewline();
      if (nl < 0) break;
      const all = Buffer.concat(this.bufChunks);
      const lineBuf = all.subarray(0, nl);
      const rest = all.subarray(nl + 1);
      this.bufChunks = rest.length ? [rest] : [];
      this.bufLen = rest.length;
      const line = lineBuf.toString("utf8").trim();
      if (line) {
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue; // non-JSON noise
        }
        this._dispatch(evt);
      }
    }
  }

  // Absolute byte index of the first '\n' across buffered chunks, or -1 if none
  // (the trailing partial line — kept for the next chunk).
  _findFirstNewline() {
    if (this.bufLen === 0) return -1;
    let consumed = 0;
    for (let i = 0; i < this.bufChunks.length; i++) {
      const c = this.bufChunks[i];
      const r = c.indexOf(0x0a);
      if (r >= 0) return consumed + r;
      consumed += c.length;
    }
    return -1;
  }

  _dispatch(evt) {
    // Track busy state from result events so the UI can disable the composer.
    if (evt.type === "result") {
      this.busy = false;
      emitStatus();
    }
    // Remember the real session id once init fires (for fresh sessions).
    if (evt.type === "system" && evt.subtype === "init" && evt.session_id) {
      if (sessions.has(this.id) && this.id !== evt.session_id) {
        // migrate map key to the real id reported by claude
        const oldId = this.id;
        sessions.delete(this.id);
        this.id = evt.session_id;
        sessions.set(this.id, this);
        saveState();
        // Tell the client to follow the rename: it holds oldId (from the
        // `session` event at start), so without this its activeId stays stale
        // and the streamed answer lands in a session it isn't rendering.
        this.emit("event", { type: "rename", oldId, sessionId: this.id });
        emitStatus();
      }
    }
    this.emit("event", { type: "claude", data: evt, sessionId: this.id });
  }

  send(text, images = []) {
    if (!this.proc || this.ended) {
      this.emit("event", { type: "error", message: "session is not running" });
      return false;
    }
    // Build the Anthropic content array. Text block first (if any), then one
    // image block per attached image. Content must be non-empty — a turn with
    // only images and no text is allowed (the prompt can live in a prior turn).
    const content = [];
    if (typeof text === "string" && text.length > 0) content.push({ type: "text", text });
    for (const img of images) {
      if (!img || typeof img.data !== "string" || !img.data) continue;
      const mediaType = String(img.mediaType || "image/png");
      if (!mediaType.startsWith("image/")) continue;
      content.push({
        type: "image",
        source: { type: "base64", media_type: mediaType, data: img.data },
      });
    }
    if (content.length === 0) {
      this.emit("event", { type: "error", message: "empty message (no text or images)" });
      return false;
    }
    this.busy = true;
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    const ok = this.proc.stdin.write(line + "\n");
    emitStatus();
    return ok;
  }

  stop() {
    const proc = this.proc;
    if (!proc || this.ended) return;
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    // SIGKILL fallback so a claude that ignores SIGTERM (stuck, bad hook) can't
    // linger as a zombie and get orphaned when start() overwrites the map entry.
    setTimeout(() => {
      if (!this.ended) {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 800).unref();
  }
}

// Restore persisted sessions now that the Session class is defined.
loadState();

export const SessionManager = {
  /** Start a new session or resume an existing one. Returns sessionId. */
  start({ cwd, sessionId, model }) {
    mkdirSync(cwd, { recursive: true });
    if (sessionId && sessions.has(sessionId)) {
      const s = sessions.get(sessionId);
      // Stop the prior process before replacing it. Without this, re-picking a
      // running session (or switching its model) would overwrite the map entry
      // and orphan the old claude subprocess.
      s.stop();
      // A passed model switches the session's model (restart-with-resume under
      // the new model); otherwise keep the model it was already using.
      const nextModel = model || s.model;
      const resume = existsSync(sessionLogPath(s.cwd, sessionId) || "") ? sessionId : undefined;
      const sess = new Session({ id: sessionId, cwd: s.cwd, resume, model: nextModel });
      sessions.set(sessionId, sess);
      if (nextModel !== s.model) saveState();
      sess.start();
      emitStatus();
      return sessionId;
    }
    const id = sessionId || crypto.randomUUID();
    // If the caller passed an id whose transcript is gone (e.g. a stale entry
    // the client still had cached), start a fresh conversation under that id
    // instead of --resume-ing into nothing.
    const resume = sessionId && existsSync(sessionLogPath(cwd, sessionId) || "") ? sessionId : undefined;
    const sess = new Session({ id, cwd, resume, model: model || config.anthropicModel });
    sessions.set(id, sess);
    saveState();
    sess.start();
    emitStatus();
    return id;
  },

  send(sessionId, text, images = []) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.title === undefined) {
      const t = typeof text === "string" ? text.trim() : "";
      const n = Array.isArray(images) ? images.length : 0;
      s.title = t ? t.slice(0, 60) : n ? `[${n} image${n > 1 ? "s" : ""}]` : "(empty)";
      saveState();
    }
    return s.send(text, images);
  },

  stop(sessionId) {
    const s = sessions.get(sessionId);
    if (s) s.stop();
  },

  // Permanently remove a session: stop any running claude process, drop it from
  // the in-memory map + persisted state file, and delete its on-disk transcript
  // so the chat is truly gone (not merely hidden). Best-effort on the transcript
  // unlink — a missing file is fine. emitStatus() re-broadcasts the session list
  // to every client so the sidebar updates everywhere.
  remove(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    s.stop();
    sessions.delete(sessionId);
    saveStateNow();
    const logPath = sessionLogPath(s.cwd, sessionId);
    if (logPath) {
      try {
        unlinkSync(logPath);
      } catch {
        /* transcript already gone — fine */
      }
    }
    emitStatus();
    return true;
  },

  list() {
    return [...sessions.values()].map(({ id, cwd, title, createdAt, model, busy, ended }) => ({
      id,
      cwd,
      title,
      createdAt,
      model,
      busy: !!busy,
      ended: !!ended,
    }));
  },

  get(sessionId) {
    return sessions.get(sessionId);
  },

  // Prior transcript for a session, in the frontend's message shape (empty if
  // the JSONL log doesn't exist yet, e.g. a brand-new session).
  history(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return [];
    return loadHistory(s.cwd, sessionId);
  },
};

// ws.js attaches its own `sess.on('event', ...)` listener after start(), via
// SessionManager.get(id). Each Session is itself an EventEmitter, so no global
// bus is needed.