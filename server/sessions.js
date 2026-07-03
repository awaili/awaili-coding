import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { config, childEnv } from "./config.js";
import { buildClaudeArgs } from "./claude-args.js";
import { availableSkillsForCwd, pickSkill } from "./skills.js";

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
//
// `opts` enables pagination so we don't ship the whole transcript at once:
//   - { limit }                       → return the last `limit` messages (tail)
//   - { limit, beforeIndex }          → return up to `limit` messages ending
//                                       just before `beforeIndex` (older page)
// Both forms return { messages, oldestIndex, hasMore }, where `oldestIndex` is
// the front-indexed position of the oldest returned message (stable across
// appends, so the client can use it as the cursor for the next older page).
// Without `opts` the full chronological array is returned (backward compat).
function loadHistory(cwd, sessionId, opts) {
  let raw;
  try {
    raw = readFileSync(sessionLogPath(cwd, sessionId), "utf8");
  } catch {
    return opts ? { messages: [], oldestIndex: 0, hasMore: false } : [];
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
        const userText = stripSkillInjection(
          blocks
            .filter((b) => b && b.type === "text")
            .map((b) => b.text || "")
            .join(""),
        );
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
          messages.push({ role: "user", text: stripSkillInjection(content) });
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
  // No opts → full chronological array (backward compat).
  if (!opts) return messages;
  // Paginated: slice a tail (no beforeIndex) or an older page ending before
  // beforeIndex. `oldestIndex` is the front-indexed start of the returned
  // slice — stable under appends, so the client uses it as the next cursor.
  const limit = opts.limit > 0 ? opts.limit : messages.length;
  let start;
  if (opts.beforeIndex != null && Number.isFinite(opts.beforeIndex)) {
    const end = Math.min(opts.beforeIndex, messages.length);
    start = Math.max(0, end - limit);
    return { messages: messages.slice(start, end), oldestIndex: start, hasMore: start > 0 };
  }
  start = Math.max(0, messages.length - limit);
  return { messages: messages.slice(start), oldestIndex: start, hasMore: start > 0 };
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
        const sess = new Session({ id: s.id, cwd: s.cwd, resume: s.id, model: s.model, confirm: s.confirm });
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
  const arr = [...sessions.values()].map(({ id, cwd, title, createdAt, model, confirm }) => ({
    id,
    cwd,
    title,
    createdAt,
    model,
    confirm,
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
  constructor({ id, cwd, resume, model, confirm }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.resume = resume;
    this.model = model || config.anthropicModel;
    // Whether this session runs in interactive confirmation mode (emits
    // control_request permission/AskUserQuestion prompts the UI answers). See
    // claude-args.js. Persists across restarts so a re-picked confirm session
    // stays in confirm mode.
    this.confirm = !!confirm;
    this.proc = null;
    this.bufChunks = [];
    this.bufLen = 0;
    this.busy = false;
    this.ended = false;
    // Last user activity timestamp (ms): bumped on start, send, and turn
    // result. The idle reaper (below) uses this to stop() a claude process
    // that's been sitting idle past config.idleTimeoutMs, freeing its ~300MB
    // of RSS without killing the session — subscribe() restarts it on demand.
    this.lastActivity = Date.now();
    // In-flight control_request prompts (permission / AskUserQuestion / dialog)
    // the UI must answer. Tracked so a session that emits a prompt while no client
    // is subscribed (the user switched to another chat) can replay it when the
    // client re-subscribes — otherwise the background claude deadlocks waiting on a
    // control_response that will never come. Cleared on result (turn done) and
    // when a specific request is answered/cancelled.
    this.pendingControl = [];
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
    const args = buildClaudeArgs({ cwd: this.cwd, resume: this.resume, id: this.id, confirm: this.confirm });
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
      this.emit("event", { type: "error", sessionId: this.id, message: `failed to start claude: ${e.message}` });
      return this.id;
    }
    this.proc = proc;
    this.lastActivity = Date.now();

    // spawn()'s 'error' event fires async if the binary is missing or spawn
    // otherwise fails. Without a listener Node raises an uncaughtException
    // that crashes the whole server. Treat it as a terminal session error.
    proc.on("error", (e) => {
      this.ended = true;
      this.busy = false;
      this.emit("event", { type: "error", sessionId: this.id, message: `claude process error: ${e.message}` });
      this.emit("event", { type: "exit", sessionId: this.id, code: -1, signal: null });
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
        this.emit("event", { type: "error", sessionId: this.id, message: text.trim().split("\n").slice(-3).join("\n") });
      } else {
        process.stderr.write(`[claude:${this.id.slice(0, 8)}] ${text}`);
      }
    });
    proc.on("exit", (code, signal) => {
      this.ended = true;
      this.busy = false;
      this.emit("event", {
        type: "exit",
        sessionId: this.id,
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
      this.pendingControl = [];
      this.lastActivity = Date.now();
      emitStatus();
    }
    // Track in-flight control requests so they can be replayed to a client that
    // re-subscribes (e.g. after switching away mid-prompt in confirm mode). Dedup
    // by request_id (a re-sent prompt must not stack). Cancel drops one; result
    // (handled above) clears all.
    if (evt.type === "control_request" && evt.request_id) {
      const entry = { request_id: evt.request_id, request: evt.request || {} };
      if (!this.pendingControl.some((p) => p.request_id === evt.request_id)) {
        this.pendingControl.push(entry);
      }
    } else if (evt.type === "control_cancel_request" && evt.request_id) {
      this.pendingControl = this.pendingControl.filter((p) => p.request_id !== evt.request_id);
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

  async send(text, attachments = []) {
    if (!this.proc || this.ended) {
      this.emit("event", { type: "error", sessionId: this.id, message: "session is not running" });
      return false;
    }
    // Build the Anthropic content array. Text block first (if any), then one
    // block per attachment: image/* → image content block (vision models);
    // anything else → a text block inlining the file contents (text files) or
    // a descriptive note (binary), so non-image attachments work on text-only
    // models too. Content must be non-empty — a turn with only attachments and
    // no text is allowed (the prompt can live in a prior turn).
    const content = [];
    let userText = typeof text === "string" ? text : "";
    // Auto-inject a matching skill so the conversation actually uses it. The
    // native CLI loads skill descriptions and auto-invokes when the model emits
    // a match — but a non-Claude model on a custom gateway may never do that.
    // So we match the user's text ourselves against the skills available to
    // this session's cwd (global + this workspace) and, on a clear match,
    // prepend the skill's body to the message. Conservative + respects
    // disable-model-invocation and slash commands (see skills.js pickSkill).
    if (userText.trim() && !userText.trim().startsWith("/")) {
      try {
        const skills = await availableSkillsForCwd(this.cwd);
        const match = pickSkill(userText, skills);
        if (match) userText = injectSkill(match, userText);
      } catch {
        // Never block sending on a skill-matching failure.
      }
    }
    if (userText.length > 0) content.push({ type: "text", text: userText });
    for (const att of attachments) {
      if (!att || typeof att.data !== "string" || !att.data) continue;
      const mediaType = String(att.mediaType || "");
      const name = String(att.name || "");
      if (mediaType.startsWith("image/")) {
        // Image content block — only consumed by vision-capable models; the UI
        // auto-switches to a vision model before sending (see App.jsx).
        content.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: att.data },
        });
        continue;
      }
      // Non-image: decode and inline as text if it looks textual, else a note.
      const block = fileToTextBlock(att.data, mediaType, name);
      if (block) content.push(block);
    }
    if (content.length === 0) {
      this.emit("event", { type: "error", sessionId: this.id, message: "empty message (no text or attachments)" });
      return false;
    }
    this.busy = true;
    this.lastActivity = Date.now();
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content },
    });
    const ok = this.proc.stdin.write(line + "\n");
    emitStatus();
    return ok;
  }

  // Answer an in-flight `control_request` (a permission / AskUserQuestion
  // prompt claude emitted on stdout). We write one `control_response` line to
  // the child's stdin, matching the request_id and carrying a PermissionResult
  // (or a request_user_dialog result) in `response`. This is the stdin half of
  // Claude Code's stream-json control protocol; the stdout half (control_request)
  // is already forwarded to the client verbatim by _dispatch.
  answerControl(requestId, response) {
    if (!this.proc || this.ended) {
      this.emit("event", { type: "error", sessionId: this.id, message: "session is not running" });
      return false;
    }
    if (typeof requestId !== "string" || !requestId) {
      this.emit("event", { type: "error", sessionId: this.id, message: "answer requires a requestId" });
      return false;
    }
    // Drop the prompt from the replay set so a client re-subscribing after this
    // doesn't get a stale card for an already-answered request.
    this.pendingControl = this.pendingControl.filter((p) => p.request_id !== requestId);
    const line = JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: requestId, response },
    });
    try {
      return this.proc.stdin.write(line + "\n");
    } catch (e) {
      this.emit("event", { type: "error", sessionId: this.id, message: `answer write failed: ${e.message}` });
      return false;
    }
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

// Prepend a matched skill's instructions to the user's message so the model
// follows the skill even when it wouldn't auto-invoke. The block is clearly
// labeled (so it's visible in the transcript and the model treats it as
// guidance), then the user's original request follows verbatim.
function injectSkill(skill, text) {
  const body = (skill.body || "").trim();
  const scope = skill.scope === "workspace" ? " (this workspace)" : " (global)";
  const header =
    `[Active skill: ${skill.name}${scope} — this request matched it. ` +
    `Apply the skill's instructions below, then fulfill the user's request.]`;
  return `${header}\n\n${body}\n\n---\n\nUser request:\n${text}`;
}

// The live chat renders the user's ORIGINAL message (optimistic, before the
// server injects a skill). On resume, though, history is read from the
// transcript — which holds the injected block. Strip the wrapper so a resumed
// session shows the same clean message the user typed, not the skill preamble.
// Only touches text that genuinely starts with our injection marker and has the
// `User request:` separator, so normal messages are passed through untouched.
const SKILL_INJECT_SEP = "\n---\n\nUser request:\n";
function stripSkillInjection(text) {
  if (typeof text !== "string" || !text.startsWith("[Active skill:")) return text;
  const i = text.indexOf(SKILL_INJECT_SEP);
  if (i < 0) return text;
  return text.slice(i + SKILL_INJECT_SEP.length);
}

// Turn a non-image base64 attachment into an Anthropic text content block. If
// the decoded bytes look textual (no NUL bytes in the first 8 KB), inline the
// contents under a labeled fenced block so the model can read the file — works
// on every model, including text-only ones. Otherwise emit a short note (the
// Claude Messages API only accepts image + PDF document blocks, not arbitrary
// binaries, and this gateway's models don't take document blocks). Inlined
// text is capped to keep the prompt bounded; a truncation note is appended.
const INLINE_TEXT_CAP = 200 * 1024; // 200 KB of decoded text per file
function fileToTextBlock(b64, mediaType, name) {
  let buf;
  try {
    buf = Buffer.from(b64, "base64");
  } catch {
    return null;
  }
  const head = buf.subarray(0, 8192);
  const looksTextual = !head.includes(0);
  const label = name ? `Attached file: ${name}` : "Attached file";
  if (!looksTextual) {
    return {
      type: "text",
      text: `[${label} — binary, ${mediaType || "unknown type"}, ${buf.length} bytes. Content not inlined.]`,
    };
  }
  let text = buf.toString("utf8");
  let truncated = "";
  if (text.length > INLINE_TEXT_CAP) {
    truncated = `\n[…truncated: ${buf.length} bytes total, showing first ${INLINE_TEXT_CAP} chars…]`;
    text = text.slice(0, INLINE_TEXT_CAP);
  }
  // Fence language from the file extension (best-effort, ignored if unknown).
  const ext = (name.split(".").pop() || "").toLowerCase();
  const fence = ext ? ext : "";
  return {
    type: "text",
    text: `[${label}]\n\`\`\`${fence}\n${text}\n\`\`\`${truncated}`,
  };
}

// Restore persisted sessions now that the Session class is defined.
loadState();

// Idle reaper. claude -p subprocesses live forever waiting on stdin, so every
// session ever opened would otherwise accumulate as a ~300MB process. This
// single unref'd timer periodically stop()s any session whose process has been
// idle (not busy) past config.idleTimeoutMs. The map entry is kept — ws.js's
// subscribe handler auto-restarts it via --resume on next open, so reaping is
// invisible to users. stop() does SIGTERM → SIGKILL, so even a stuck process is
// guaranteed to die (and free its RSS).
let reaperTimer = null;
function startReaper() {
  if (reaperTimer) clearInterval(reaperTimer);
  if (!config.idleTimeoutMs || !config.reaperIntervalMs) return;
  reaperTimer = setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (!s.proc || s.ended || s.busy) continue;
      if (now - (s.lastActivity || 0) > config.idleTimeoutMs) {
        s.stop(); // SIGTERM + SIGKILL fallback; ended flips true on exit
      }
    }
  }, config.reaperIntervalMs).unref();
}
startReaper();

// Count currently-alive claude processes (a process exists and hasn't exited).
function aliveCount() {
  let n = 0;
  for (const s of sessions.values()) if (s.proc && !s.ended) n++;
  return n;
}

// LRU-stop the oldest non-busy alive session to make room for a new one. Busy
// sessions are never evicted (that would kill an in-flight turn). No-op if
// every alive session is currently busy — in that case we let the new spawn
// through rather than block the user (the reaper will catch up next tick).
function evictOldestIdle() {
  let oldest = null;
  for (const s of sessions.values()) {
    if (!s.proc || s.ended || s.busy) continue;
    if (!oldest || (s.lastActivity || 0) < (oldest.lastActivity || 0)) oldest = s;
  }
  if (oldest) oldest.stop();
}

export const SessionManager = {
  /** Start a new session or resume an existing one. Returns sessionId. */
  start({ cwd, sessionId, model, confirm }) {
    mkdirSync(cwd, { recursive: true });
    if (sessionId && sessions.has(sessionId)) {
      const s = sessions.get(sessionId);
      // Stop the prior process before replacing it. Without this, re-picking a
      // running session (or switching its model) would overwrite the map entry
      // and orphan the old claude subprocess.
      s.stop();
      // A passed model switches the session's model (restart-with-resume under
      // the new model); otherwise keep the model it was already using. Same for
      // confirm: an explicit boolean toggles interactive confirmation mode
      // (restarting under it); undefined keeps whatever the session had.
      const nextModel = model || s.model;
      const nextConfirm = confirm === undefined ? s.confirm : !!confirm;
      const resume = existsSync(sessionLogPath(s.cwd, sessionId) || "") ? sessionId : undefined;
      const sess = new Session({ id: sessionId, cwd: s.cwd, resume, model: nextModel, confirm: nextConfirm });
      sessions.set(sessionId, sess);
      if (nextModel !== s.model || nextConfirm !== s.confirm) saveState();
      sess.start();
      emitStatus();
      return sessionId;
    }
    const id = sessionId || crypto.randomUUID();
    // If the caller passed an id whose transcript is gone (e.g. a stale entry
    // the client still had cached), start a fresh conversation under that id
    // instead of --resume-ing into nothing.
    const resume = sessionId && existsSync(sessionLogPath(cwd, sessionId) || "") ? sessionId : undefined;
    const sess = new Session({
      id,
      cwd,
      resume,
      model: model || config.anthropicModel,
      confirm: confirm === undefined ? config.confirmTools : !!confirm,
    });
    sessions.set(id, sess);
    // Enforce the concurrency cap before spawning. The re-pick branch above
    // already stop()s the prior process for this id, so only count fresh
    // spawns here. Evict the LRU idle session if at cap; busy ones are spared.
    if (config.maxSessions > 0 && aliveCount() >= config.maxSessions) {
      evictOldestIdle();
    }
    saveState();
    sess.start();
    emitStatus();
    return id;
  },

  async send(sessionId, text, attachments = []) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.title === undefined) {
      const t = typeof text === "string" ? text.trim() : "";
      const n = Array.isArray(attachments) ? attachments.length : 0;
      s.title = t ? t.slice(0, 60) : n ? `[${n} attachment${n > 1 ? "s" : ""}]` : "(empty)";
      saveState();
    }
    return s.send(text, attachments);
  },

  stop(sessionId) {
    const s = sessions.get(sessionId);
    if (s) s.stop();
  },

  // Answer an in-flight control_request (permission / AskUserQuestion prompt)
  // for a session by writing a control_response to its claude subprocess stdin.
  answerControl(sessionId, requestId, response) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    return s.answerControl(requestId, response);
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
    return [...sessions.values()].map(({ id, cwd, title, createdAt, model, busy, ended, confirm }) => ({
      id,
      cwd,
      title,
      createdAt,
      model,
      busy: !!busy,
      ended: !!ended,
      confirm: !!confirm,
    }));
  },

  get(sessionId) {
    return sessions.get(sessionId);
  },

  // Prior transcript for a session, in the frontend's message shape (empty if
  // the JSONL log doesn't exist yet, e.g. a brand-new session). With `opts`
  // ({limit[, beforeIndex]}) returns a paginated {messages, oldestIndex,
  // hasMore}; without `opts` returns the full array (backward compat).
  history(sessionId, opts) {
    const s = sessions.get(sessionId);
    if (!s) return opts ? { messages: [], oldestIndex: 0, hasMore: false } : [];
    return loadHistory(s.cwd, sessionId, opts);
  },
};

// ws.js attaches its own `sess.on('event', ...)` listener after start(), via
// SessionManager.get(id). Each Session is itself an EventEmitter, so no global
// bus is needed.