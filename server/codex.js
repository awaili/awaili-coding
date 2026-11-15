// Codex engine adapter: runs the official OpenAI Codex CLI (`codex exec --json`,
// ChatGPT-plan login) as a per-turn one-shot subprocess and translates its
// JSONL event stream into the claude stream-json shapes the rest of the server
// (ws.js event forwarding, loadHistory, the web frontend) already understands.
//
// Why a per-turn spawn: the claude engine keeps ONE long-lived `claude -p`
// process fed via stdin, but `codex exec` is one-shot — one prompt in, events
// out, exit. Continuity across turns is done with `codex exec resume
// <thread_id> <prompt>`, where thread_id comes from the first turn's
// `thread.started` event and is persisted as a sidecar record in the session's
// transcript (loadHistory skips unknown record types, so it's invisible).
//
// The transcript the adapter writes (util.js sessionLogPath — same file claude
// itself uses) is in claude's JSONL record shape, so history loading, transcript
// image serving and `remove()` all work without knowing which engine wrote it.
//
// Everything here is the official client on the official auth (codex login
// with the ChatGPT subscription) — no tokens are extracted or replayed.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { sessionLogPath, fileToTextBlock } from "./util.js";

// sessions.js assigns these at module load: status-bus broadcast + state-file
// persist both live there. Kept as a mutable object to dodge the circular
// import (sessions.js constructs CodexSession, so it can't be imported here).
export const codexHooks = { onStateChange: () => {} };

// How codex exec item types map onto claude protocol blocks, for both the live
// event stream and the transcript records. command_execution is mapped to a
// Bash tool_use + tool_result pair so the frontend renders its usual tool
// card; unknown item types degrade to a readable text block instead of being
// dropped.
function itemToClaudeBlocks(item) {
  switch (item.type) {
    case "agent_message":
      return [{ type: "text", text: item.text || "" }];
    case "command_execution":
      return [
        {
          type: "tool_use",
          id: item.id,
          name: "Bash",
          input: { command: item.command || "", description: "codex" },
        },
      ];
    default:
      return [
        {
          type: "text",
          text: `[${item.type}] ${JSON.stringify(
            Object.assign({}, item, { id: undefined, type: undefined }),
          ).slice(0, 2000)}`,
        },
      ];
  }
}

// A command_execution item also produces a user tool_result record/event —
// the same assistant(tool_use) → user(tool_result) pairing claude streams, so
// the frontend attaches the output to the tool card and loadHistory can match
// them back together.
function toolResultFor(item) {
  const ok = item.exit_code === 0;
  return {
    type: "tool_result",
    tool_use_id: item.id,
    content: item.aggregated_output || "",
    is_error: !ok,
  };
}

export class CodexSession extends EventEmitter {
  constructor({ id, cwd, model, confirm }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.model = model;
    // codex exec is non-interactive: there is no approval flow to surface, so
    // confirm mode is ignored for this engine (exec runs sandboxed
    // workspace-write with approval_policy=never). Kept as a field for the
    // state file / sidebar, which expect it.
    this.confirm = !!confirm;
    this.proc = null; // only alive DURING a turn (unlike claude's parked process)
    this.busy = false;
    this.ended = false;
    this.lastActivity = Date.now();
    this.pendingControl = []; // never used — codex exec has no control flow
    this.metrics = null;
    this.title = undefined;
    this.createdAt = undefined;
    this.threadId = null; // codex session id, learned from thread.started
    this.turnCount = 0;
    this.turnStart = 0;
    this.bufChunks = [];
    this.bufLen = 0;
    this.sawResult = false;
    this.tmpDir = null; // per-turn scratch dir for image attachments (-i)
  }

  // Mirror of Session.start() for the SessionManager/ws.js lifecycle. The
  // claude engine spawns a process here; the codex engine has nothing to keep
  // alive between turns, so this just clears the ended flag (a subscribe()
  // after an idle period calls start() on any session whose proc is gone).
  start() {
    this.ended = false;
    this.busy = false;
    this.lastActivity = Date.now();
    return this.id;
  }

  // Codex thread id for `exec resume`, persisted in the transcript as a
  // sidecar record (type "codex_thread" — loadHistory skips unknown types).
  // Read lazily: after a server restart the id lives only on disk.
  loadThreadId() {
    if (this.threadId) return this.threadId;
    const path = sessionLogPath(this.cwd, this.id);
    if (!path) return null;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t);
          if (r.type === "codex_thread" && r.thread_id) {
            this.threadId = r.thread_id;
            return this.threadId;
          }
        } catch {
          /* skip junk lines */
        }
      }
    } catch {
      /* no transcript yet */
    }
    return null;
  }

  appendTranscript(record) {
    const path = sessionLogPath(this.cwd, this.id);
    if (!path) return;
    try {
      appendFileSync(path, JSON.stringify(record) + "\n");
    } catch {
      /* history is best-effort; live events still flow */
    }
  }

  // busy/metrics changes must reach the statusBus (sidebar busy dots) and the
  // persisted state file — those live in sessions.js, which assigns these
  // hooks at module load to avoid a circular import.
  _stateChanged() {
    codexHooks.onStateChange(this);
  }

  // Translate one codex exec --json event into claude-shaped events + records.
  // Codex's built-in image_gen tool (the imagegen system skill) saves its
  // output under ~/.codex/generated_images/<thread_id>/ — outside the
  // workspace, and the exec --json event stream never mentions the tool, so
  // the only way to surface the file is to sweep the thread's dir at turn end
  // for files newer than the turn start. Copied into the session cwd (file
  // tree + /api/files/download) and returned as markdown embeds.
  _collectGeneratedMedia() {
    const embeds = [];
    if (!this.threadId) return embeds;
    const dir = join(homedir(), ".codex", "generated_images", this.threadId);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return embeds; // no media dir for this thread
    }
    for (const name of names) {
      const src = join(dir, name);
      try {
        const st = statSync(src);
        if (!st.isFile() || st.mtimeMs < this.turnStart - 2000) continue;
        const rel = `codex-image_gen-${name}`;
        copyFileSync(src, join(this.cwd, rel));
        const url = `/api/files/download?cwd=${encodeURIComponent(this.cwd)}&path=${encodeURIComponent(rel)}`;
        const isVideo = /\.(mp4|mov|webm)$/i.test(rel);
        embeds.push(isVideo ? `[📹 ${rel}](${url})` : `![${rel}](${url})`);
      } catch {
        /* unreadable/stale entry — skip */
      }
    }
    return embeds;
  }

  _dispatch(evt) {
    if (evt.type === "thread.started" && evt.thread_id) {
      const known = this.loadThreadId();
      if (!known) {
        this.threadId = evt.thread_id;
        this.appendTranscript({ type: "codex_thread", thread_id: evt.thread_id });
      } else if (known !== evt.thread_id) {
        // resume didn't happen / codex started a new thread — keep following
        // the newest one so subsequent turns resume the right conversation.
        this.threadId = evt.thread_id;
      }
      return;
    }
    if (evt.type === "item.completed" && evt.item) {
      const item = evt.item;
      const blocks = itemToClaudeBlocks(item);
      // assistant event (the shape _dispatch in sessions.js forwards verbatim)
      const assistantEvent = {
        type: "assistant",
        message: { id: item.id, role: "assistant", content: blocks },
      };
      this.emit("event", { type: "claude", data: assistantEvent, sessionId: this.id });
      this.appendTranscript({
        type: "assistant",
        uuid: randomUUID(),
        message: { id: item.id, role: "assistant", content: blocks },
      });
      if (item.type === "command_execution") {
        const tr = toolResultFor(item);
        const userEvent = {
          type: "user",
          message: { role: "user", content: [tr] },
        };
        this.emit("event", { type: "claude", data: userEvent, sessionId: this.id });
        this.appendTranscript({
          type: "user",
          uuid: randomUUID(),
          message: { role: "user", content: [tr] },
        });
      }
      return;
    }
    if (evt.type === "turn.completed") {
      this.sawResult = true;
      this.busy = false;
      this.lastActivity = Date.now();
      this.turnCount += 1;
      const u = evt.usage || {};
      // claude-shaped result event; cost is null (ChatGPT plan has no per-token
      // billing to report) and duration/turns are session-cumulative like the
      // claude CLI reports them.
      const result = {
        type: "result",
        subtype: "success",
        total_cost_usd: null,
        duration_ms: this.turnStart ? Date.now() - this.turnStart : null,
        num_turns: this.turnCount,
        usage: {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cache_read_input_tokens: u.cached_input_tokens || 0,
          cache_creation_input_tokens: 0,
        },
      };
      this.metrics = {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        cacheReadTokens: result.usage.cache_read_input_tokens,
        cacheCreationTokens: 0,
        totalCostUsd: null,
        totalDurationMs: result.duration_ms,
        totalTurns: this.turnCount,
      };
      const embeds = this._collectGeneratedMedia();
      if (embeds.length) {
        // A dedicated assistant message for the generated media — the model's
        // own agent_message records were already streamed/applied above, and
        // codex's event stream never mentions image_gen, so nothing to amend.
        const content = [{ type: "text", text: embeds.join("\n\n") }];
        const msgId = "codex-media-" + randomUUID();
        this.emit("event", { type: "claude", data: { type: "assistant", message: { id: msgId, role: "assistant", content } }, sessionId: this.id });
        this.appendTranscript({ type: "assistant", uuid: randomUUID(), message: { id: msgId, role: "assistant", content } });
      }
      this.emit("event", { type: "claude", data: result, sessionId: this.id });
      this._endTurn();
      return;
    }
    if (evt.type === "turn.failed" || evt.type === "error") {
      this.sawResult = true;
      this.busy = false;
      const msg =
        (evt.error && (evt.error.message || evt.error)) || JSON.stringify(evt).slice(0, 400);
      this.emit("event", { type: "claude", data: { type: "result", subtype: "error_during_execution", is_error: true, result: String(msg) }, sessionId: this.id });
      this.emit("event", { type: "error", sessionId: this.id, message: String(msg).slice(0, 400) });
      this._endTurn();
      return;
    }
    // item.started / turn.started / anything else: nothing to surface yet.
  }

  // Byte-exact newline splitter (same chunk-safety as Session._onStdout:
  // multi-byte UTF-8 must not be decoded mid-character).
  _onStdout(chunk) {
    this.bufChunks.push(chunk);
    this.bufLen += chunk.length;
    for (;;) {
      let consumed = 0;
      let nl = -1;
      for (const c of this.bufChunks) {
        const r = c.indexOf(0x0a);
        if (r >= 0) {
          nl = consumed + r;
          break;
        }
        consumed += c.length;
      }
      if (nl < 0) break;
      const all = Buffer.concat(this.bufChunks);
      const lineBuf = all.subarray(0, nl);
      const rest = all.subarray(nl + 1);
      this.bufChunks = rest.length ? [rest] : [];
      this.bufLen = rest.length;
      const line = lineBuf.toString("utf8").trim();
      if (!line || !line.startsWith("{")) continue; // "Reading additional input..." noise
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      this._dispatch(evt);
    }
  }

  // Per-turn spawn. Mirrors Session.send()'s contract: true when the turn was
  // launched, false on a client-visible error event. Attachments: images are
  // written to a per-turn temp dir and passed via -i (codex's image input);
  // textual attachments are inlined into the prompt text like the claude path.
  async send(text, attachments = []) {
    if (this.busy || this.proc) {
      this.emit("event", { type: "error", sessionId: this.id, message: "session is busy" });
      return false;
    }
    const content = [];
    if (typeof text === "string" && text.trim()) content.push({ type: "text", text });
    const imageFiles = [];
    this.tmpDir = null;
    for (const att of attachments) {
      if (!att || typeof att.data !== "string" || !att.data) continue;
      const mediaType = String(att.mediaType || "");
      const name = String(att.name || "");
      if (mediaType.startsWith("image/")) {
        // Keep the image in the transcript (claude-shaped image block —
        // history serves it via /api/transcript/image) AND hand codex a real
        // file via -i.
        content.push({
          type: "image",
          source: { type: "base64", media_type: mediaType, data: att.data },
        });
        if (!this.tmpDir) this.tmpDir = mkdtempSync(join(tmpdir(), "codex-att-"));
        const ext = mediaType.split("/")[1] || "png";
        const f = join(this.tmpDir, `img-${imageFiles.length}.${ext}`);
        writeFileSync(f, Buffer.from(att.data, "base64"));
        imageFiles.push(f);
        continue;
      }
      const block = fileToTextBlock(att.data, mediaType, name);
      if (block) content.push(block);
    }
    const userText = content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!userText && !imageFiles.length) {
      this.emit("event", { type: "error", sessionId: this.id, message: "empty message (no text or attachments)" });
      return false;
    }
    // Transcript user record BEFORE spawning, so a crash mid-turn still leaves
    // the user's message in history.
    this.appendTranscript({
      type: "user",
      uuid: randomUUID(),
      message: { role: "user", content },
    });

    const threadId = this.loadThreadId();
    const args = threadId
      ? ["exec", "resume", "--json", "--skip-git-repo-check", "-m", this.model, threadId, userText]
      : ["exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "-m", this.model, userText];
    for (const f of imageFiles) args.push("-i", f);

    this.busy = true;
    this.sawResult = false;
    this.turnStart = Date.now();
    this.lastActivity = Date.now();
    this.bufChunks = [];
    this.bufLen = 0;
    this._stateChanged();

    // Codex must NOT see an OPENAI_API_KEY — that would silently switch it from
    // the ChatGPT plan login to pay-per-token API billing.
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;

    let proc;
    try {
      proc = spawn("codex", args, { cwd: this.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.busy = false;
      this.emit("event", { type: "error", sessionId: this.id, message: `failed to start codex: ${e.message}` });
      return false;
    }
    this.proc = proc;
    this.emit("activity");

    proc.on("error", (e) => {
      this._endTurn();
      this.emit("event", { type: "error", sessionId: this.id, message: `codex process error: ${e.message}` });
    });
    proc.stdout.on("error", () => {});
    proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    proc.stderr.on("data", (chunk) => {
      const t = chunk.toString();
      if (/\b(error|exception|failed|denied|unauthorized)\b/i.test(t)) {
        this.emit("event", { type: "error", sessionId: this.id, message: t.trim().split("\n").slice(-3).join("\n") });
      } else {
        process.stderr.write(`[codex:${String(this.id).slice(0, 8)}] ${t}`);
      }
    });
    const tmpDir = this.tmpDir;
    proc.on("exit", (code, signal) => {
      if (tmpDir) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          /* temp cleanup is best-effort */
        }
        if (this.tmpDir === tmpDir) this.tmpDir = null;
      }
      // A follow-up turn may already be running (turn.completed releases the
      // proc reference immediately) — its exit must not clobber this one.
      if (this.proc !== proc) return;
      this._endTurn();
      if (!this.sawResult) {
        // Crash / kill before turn.completed: still end the turn so the UI
        // composer re-enables, with a visible reason.
        this.emit("event", {
          type: "claude",
          data: {
            type: "result",
            subtype: signal === "SIGTERM" || signal === "SIGKILL" ? "cancelled" : "error_during_execution",
            is_error: true,
            result: `codex exec exited (${code ?? "no code"}${signal ? `, signal ${signal}` : ""}) before finishing`,
          },
          sessionId: this.id,
        });
        if (signal !== "SIGTERM" && signal !== "SIGKILL") {
          this.emit("event", { type: "error", sessionId: this.id, message: `codex exec exited early (code ${code ?? "?"}${signal ? `, ${signal}` : ""})` });
        }
      }
    });
    return true;
  }

  _endTurn() {
    this.busy = false;
    this.proc = null;
    this.lastActivity = Date.now();
    this._stateChanged();
    // NOTE: no "exit" event and ended stays false — unlike claude, a codex
    // session dying mid-turn (or being idle for hours) is NOT terminal; the
    // next send() just spawns a fresh exec (resume via thread_id).
  }

  // Kill the in-flight turn if any. Not terminal (see _endTurn).
  stop() {
    const proc = this.proc;
    if (!proc) return;
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 800).unref();
  }

  // codex exec has no interactive control flow — answerControl is a no-op.
  answerControl() {
    return false;
  }
}
