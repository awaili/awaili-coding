// Grok engine adapter: runs xAI's official Grok Build CLI (`grok -p
// --output-format streaming-json`, grok.com subscription login) as a
// per-turn one-shot subprocess and translates its JSONL event stream into
// the claude stream-json shapes the rest of the server already understands.
// Same pattern as codex.js: one spawn per turn, continuity via grok's own
// session resume (`grok --resume <session_id>`), transcript written in
// claude's exact JSONL record shape so history/tool cards/delete need no
// changes, and the grok session id persisted as a sidecar record.
//
// Everything here is the official client on the official auth (grok login
// with the user's grok.com subscription) — no tokens are extracted or
// replayed. Usage draws from the plan's shared weekly allowance, not API
// billing.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { sessionLogPath, fileToTextBlock } from "./util.js";

// sessions.js assigns this at module load (same pattern as codexHooks — the
// state broadcast + persistence live there; a mutable object dodges the
// circular import).
export const grokHooks = { onStateChange: () => {} };

// ── event → claude block translation ────────────────────────────────────────
// Grok tool names map onto the claude tool names the frontend already
// renders cards for; unknown tools pass through under their own name with
// the raw input (the UI degrades gracefully).
function toolToClaude(tc) {
  const raw = tc.rawInput || {};
  switch (tc.toolName) {
    case "run_terminal_command":
      return {
        name: "Bash",
        input: { command: raw.command || raw.cmd || "", description: tc.title || "grok" },
      };
    case "write":
      return { name: "Write", input: { file_path: raw.file_path || raw.path || "", content: raw.content ?? "" } };
    case "search_replace":
      return {
        name: "Edit",
        input: {
          file_path: raw.file_path || raw.path || "",
          old_string: raw.old_string ?? raw.oldText ?? "",
          new_string: raw.new_string ?? raw.newText ?? "",
        },
      };
    case "read_file":
      return { name: "Read", input: { file_path: raw.target_file || raw.file_path || raw.path || "" } };
    case "list_dir":
      return { name: "Glob", input: { pattern: "*", path: raw.path || raw.dir || "" } };
    case "grep":
      return { name: "Grep", input: { pattern: raw.pattern || raw.query || "", path: raw.path || "" } };
    default:
      return { name: tc.toolName || "grok_tool", input: raw };
  }
}

// Grok's Imagine tools (image_gen / image_edit / image_to_video /
// reference_to_video) save their output under /root/.grok/sessions/... — outside
// WORKSPACE_ROOT, so the UI can neither list nor serve it. When one finishes,
// the result text carries a JSON {"path": ...}; copy that file into the
// session cwd (file tree + /api/files/download) and remember a URL so the
// turn's final text can embed it as a markdown image/link.
const MEDIA_TOOLS = new Set(["image_gen", "image_edit", "image_to_video", "reference_to_video"]);

// Human-readable text for a finished tool call, from the tool_call_update's
// content items (diff / content) and rawOutput (command stdout etc.).
function toolResultText(upd) {
  const parts = [];
  for (const c of upd.content || []) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "content" && c.content && typeof c.content.text === "string") parts.push(c.content.text);
    else if (c.type === "diff")
      parts.push(`${c.path}:\n${c.oldText || ""}\n→\n${c.newText || ""}`);
    else if (typeof c.text === "string") parts.push(c.text);
  }
  const ro = upd.rawOutput;
  if (ro && typeof ro === "object") {
    if (typeof ro.stdout === "string" && ro.stdout) parts.push(ro.stdout);
    if (typeof ro.stderr === "string" && ro.stderr && !String(ro.stderr).trim().startsWith("empty"))
      parts.push(String(ro.stderr).trim());
  }
  if (!parts.length && ro) {
    try {
      parts.push(JSON.stringify(ro).slice(0, 2000));
    } catch {
      /* non-serializable — leave empty */
    }
  }
  return parts.join("\n").slice(0, 5000);
}

export class GrokSession extends EventEmitter {
  constructor({ id, cwd, model, confirm }) {
    super();
    this.id = id;
    this.cwd = cwd;
    this.model = model;
    // Headless runs pass --always-approve (sandboxed to the session cwd by
    // grok's own permission model), so there is no interactive approval flow
    // to surface; kept as a field for the state file / sidebar.
    this.confirm = !!confirm;
    this.proc = null; // only alive DURING a turn
    this.busy = false;
    this.ended = false;
    this.lastActivity = Date.now();
    this.pendingControl = []; // never used — headless has no control flow
    this.metrics = null;
    this.title = undefined;
    this.createdAt = undefined;
    this.grokSessionId = null; // grok's own session id, learned from the end event
    this.turnCount = 0;
    this.turnStart = 0;
    this.bufChunks = [];
    this.bufLen = 0;
    this.sawResult = false;
    this.tmpDir = null; // per-turn attachment dir inside the session cwd
    // Per-turn accumulator state (reset in send()).
    this.text = "";
    this.thinking = "";
    this.tools = new Map();
    this.pendingMedia = []; // markdown embeds for this turn's generated media
    this._textMsgId = "grok-msg-init";
  }

  // Mirror of Session.start() for the SessionManager/ws.js lifecycle.
  start() {
    this.ended = false;
    this.busy = false;
    this.lastActivity = Date.now();
    return this.id;
  }

  // Grok session id for `--resume`, persisted as a sidecar transcript record
  // (loadHistory skips unknown types). Read lazily — after a server restart
  // it lives only on disk.
  loadGrokSessionId() {
    if (this.grokSessionId) return this.grokSessionId;
    const path = sessionLogPath(this.cwd, this.id);
    if (!path) return null;
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const r = JSON.parse(t);
          if (r.type === "grok_session" && r.session_id) {
            this.grokSessionId = r.session_id;
            return this.grokSessionId;
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

  _stateChanged() {
    grokHooks.onStateChange(this);
  }

  // Emit one assistant partial (same message id, growing content) — the same
  // assistant-partial pattern the gateway thinking models already stream,
  // which the frontend replaces in place. The transcript only gets the final
  // complete record (written at end of turn), so history stays clean.
  _emitPartial(kind, text) {
    this.emit("event", {
      type: "claude",
      data: {
        type: "assistant",
        message: {
          id: this._textMsgId,
          role: "assistant",
          content: [kind === "thinking" ? { type: "thinking", thinking: text } : { type: "text", text }],
        },
      },
      sessionId: this.id,
    });
  }

  // Copy an Imagine-tool output into the session cwd (see MEDIA_TOOLS). Returns
  // the workspace-relative name on success, null when the call wasn't a media
  // tool or the file couldn't be recovered.
  _collectMedia(call, upd) {
    if (!call || !MEDIA_TOOLS.has(call.toolName)) return null;
    const txt = toolResultText(upd);
    const m = txt.match(/"path"\s*:\s*"([^"]+)"/);
    if (!m) return null;
    const src = m[1];
    try {
      const buf = readFileSync(src);
      const ext = (src.match(/(\.[a-z0-9]+)$/i) || [])[1] || "";
      const rel = `grok-${call.toolName}-${String(upd.toolCallId || "").slice(0, 8)}${ext}`;
      writeFileSync(join(this.cwd, rel), buf);
      return rel;
    } catch {
      return null; // best-effort — the raw path still shows in the tool result
    }
  }

  _dispatch(evt) {
    if (evt.type === "text" && typeof evt.data === "string") {
      this.text += evt.data;
      this._emitPartial("text", this.text);
      return;
    }
    // thinking deltas (thought events) — same partial pattern, thinking block.
    if ((evt.type === "thinking" || evt.type === "thought") && typeof evt.data === "string") {
      this.thinking += evt.data;
      this._emitPartial("thinking", this.thinking);
      return;
    }
    if (evt.type === "tool_call" && evt.toolCallId) {
      // Stash; the completed tool_call_update below carries the result.
      this.tools.set(evt.toolCallId, evt);
      return;
    }
    if (evt.type === "tool_call_update" && evt.toolCallId) {
      if (evt.status !== "completed" && evt.status !== "failed") return; // progress diffs, not final
      const call = this.tools.get(evt.toolCallId);
      if (!call || call._done) return;
      call._done = true;
      const toolUse = toolToClaude(call);
      const block = { type: "tool_use", id: evt.toolCallId, name: toolUse.name, input: toolUse.input };
      const mediaRel = this._collectMedia(call, evt);
      const tr = {
        type: "tool_result",
        tool_use_id: evt.toolCallId,
        content: toolResultText(evt) + (mediaRel ? `\n[生成文件已复制到工作区: ${mediaRel}]` : ""),
        is_error: evt.status === "failed",
      };
      if (mediaRel) {
        const url = `/api/files/download?cwd=${encodeURIComponent(this.cwd)}&path=${encodeURIComponent(mediaRel)}`;
        const isVideo = /\.(mp4|mov|webm)$/i.test(mediaRel);
        // Inline display in the assistant bubble: markdown <img> for images,
        // a plain link for videos (the browser won't play <img src=mp4>).
        this.pendingMedia.push(isVideo ? `[📹 ${mediaRel}](${url})` : `![${mediaRel}](${url})`);
      }
      // assistant(tool_use) → user(tool_result), the pairing claude streams.
      this.emit("event", { type: "claude", data: { type: "assistant", message: { id: evt.toolCallId, role: "assistant", content: [block] } }, sessionId: this.id });
      this.emit("event", { type: "claude", data: { type: "user", message: { role: "user", content: [tr] } }, sessionId: this.id });
      this.appendTranscript({ type: "assistant", uuid: randomUUID(), message: { id: evt.toolCallId, role: "assistant", content: [block] } });
      this.appendTranscript({ type: "user", uuid: randomUUID(), message: { role: "user", content: [tr] } });
      return;
    }
    if (evt.type === "end") {
      this.sawResult = true;
      this.busy = false;
      this.lastActivity = Date.now();
      this.turnCount += 1;
      if (evt.sessionId && !this.grokSessionId) {
        this.grokSessionId = evt.sessionId;
        this.appendTranscript({ type: "grok_session", session_id: evt.sessionId });
      }
      // Final complete assistant record (text + thinking, if any). Generated
      // media from Imagine tools is embedded after the model's own text so the
      // image/video shows inline in the bubble (workspace copy also exists —
      // see _collectMedia).
      const finalBlocks = [];
      if (this.thinking) finalBlocks.push({ type: "thinking", thinking: this.thinking });
      let finalText = this.text;
      if (this.pendingMedia.length) {
        finalText = `${finalText}\n\n${this.pendingMedia.join("\n\n")}`.trim();
      }
      if (finalText) finalBlocks.push({ type: "text", text: finalText });
      if (this.pendingMedia.length) {
        // The streamed partials predate the media (it only resolves once the
        // tool finishes) — one last partial so live clients see the embed too,
        // not just the reloaded history.
        this._emitPartial("text", finalText);
      }
      if (finalBlocks.length) {
        this.appendTranscript({ type: "assistant", uuid: randomUUID(), message: { id: this._textMsgId, role: "assistant", content: finalBlocks } });
      }
      const failed = evt.stopReason === "error";
      const cancelled = evt.stopReason === "cancelled";
      const u = evt.usage || {};
      const result = {
        type: "result",
        subtype: failed ? "error_during_execution" : cancelled ? "cancelled" : "success",
        is_error: failed || cancelled,
        // Subscription usage (plan allowance), not API billing — report no
        // dollar cost, same convention as the codex engine adapter.
        total_cost_usd: null,
        duration_ms: this.turnStart ? Date.now() - this.turnStart : null,
        num_turns: this.turnCount,
        usage: {
          input_tokens: u.input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cache_read_input_tokens: u.cache_read_input_tokens || 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
        },
      };
      this.metrics = {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        cacheReadTokens: result.usage.cache_read_input_tokens,
        cacheCreationTokens: result.usage.cache_creation_input_tokens,
        totalCostUsd: null,
        totalDurationMs: result.duration_ms,
        totalTurns: this.turnCount,
      };
      this.emit("event", { type: "claude", data: result, sessionId: this.id });
      if (failed) {
        this.emit("event", { type: "error", sessionId: this.id, message: "grok turn ended with an error" });
      }
      this._endTurn();
      return;
    }
    // available_commands / usage / unknown: nothing to surface.
  }

  // Byte-exact newline splitter (same chunk-safety as Session._onStdout).
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
      if (!line || !line.startsWith("{")) continue; // TUI noise on stdout
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      this._dispatch(evt);
    }
  }

  // Per-turn spawn. Mirrors Session.send()'s contract. Attachments: images and
  // binary files are written into a per-turn dir inside the session cwd and
  // referenced in the prompt (grok reads them with its own read_file tool —
  // including images, which it routes to vision); textual attachments are
  // inlined like the claude path.
  async send(text, attachments = []) {
    if (this.busy || this.proc) {
      this.emit("event", { type: "error", sessionId: this.id, message: "session is busy" });
      return false;
    }
    const content = [];
    if (typeof text === "string" && text.trim()) content.push({ type: "text", text });
    const attLines = [];
    this.tmpDir = null;
    for (const att of attachments) {
      if (!att || typeof att.data !== "string" || !att.data) continue;
      const mediaType = String(att.mediaType || "");
      const name = String(att.name || "");
      if (mediaType.startsWith("image/")) {
        // Keep the image in the transcript (claude-shaped image block — the
        // UI serves it via /api/transcript/image) AND hand grok a real file it
        // can read with its own tools (vision-capable read_file).
        content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: att.data } });
        if (!this.tmpDir) this.tmpDir = join(this.cwd, `.grok-att-${this.id.slice(0, 8)}`);
        mkdirSync(this.tmpDir, { recursive: true });
        const f = join(this.tmpDir, name || `img-${attLines.length}.png`);
        writeFileSync(f, Buffer.from(att.data, "base64"));
        attLines.push(`用户上传了图片 ${f}，请用工具读取查看。`);
        continue;
      }
      const block = fileToTextBlock(att.data, mediaType, name);
      if (block) {
        content.push(block);
        continue;
      }
      // Binary non-image: hand grok the file (no transcript block — the UI
      // placeholder text in `text`/name still shows it in history).
      if (!this.tmpDir) this.tmpDir = join(this.cwd, `.grok-att-${this.id.slice(0, 8)}`);
      mkdirSync(this.tmpDir, { recursive: true });
      const f = join(this.tmpDir, name || `att-${attLines.length}.bin`);
      writeFileSync(f, Buffer.from(att.data, "base64"));
      attLines.push(`附件已保存为 ${f}（${mediaType || "binary"}），可用工具读取。`);
    }
    const userText = [...content.filter((b) => b.type === "text").map((b) => b.text), ...attLines]
      .join("\n")
      .trim();
    if (!userText) {
      this.emit("event", { type: "error", sessionId: this.id, message: "empty message (no text or attachments)" });
      return false;
    }
    // Transcript user record BEFORE spawning, so a crash mid-turn still leaves
    // the user's message in history.
    this.appendTranscript({ type: "user", uuid: randomUUID(), message: { role: "user", content } });

    const prevSessionId = this.loadGrokSessionId();
    const args = [
      ...(prevSessionId ? ["--resume", prevSessionId] : []),
      "--always-approve",
      "-m",
      this.model,
      "-p",
      userText,
      "--output-format",
      "streaming-json",
    ];

    this.busy = true;
    this.sawResult = false;
    this.turnStart = Date.now();
    this.lastActivity = Date.now();
    this.bufChunks = [];
    this.bufLen = 0;
    this.text = "";
    this.thinking = "";
    this.tools = new Map();
    this.pendingMedia = [];
    this._textMsgId = "grok-msg-" + randomUUID();
    this._stateChanged();

    let proc;
    try {
      proc = spawn("grok", args, { cwd: this.cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      this.busy = false;
      this.emit("event", { type: "error", sessionId: this.id, message: `failed to start grok: ${e.message}` });
      return false;
    }
    this.proc = proc;
    this.emit("activity");

    proc.on("error", (e) => {
      this._endTurn();
      this.emit("event", { type: "error", sessionId: this.id, message: `grok process error: ${e.message}` });
    });
    proc.stdout.on("error", () => {});
    proc.stdout.on("data", (chunk) => this._onStdout(chunk));
    proc.stderr.on("data", (chunk) => {
      const t = chunk.toString();
      if (/\b(error|exception|failed|denied|unauthorized|not authenticated)\b/i.test(t)) {
        this.emit("event", { type: "error", sessionId: this.id, message: t.trim().split("\n").slice(-3).join("\n") });
      } else {
        process.stderr.write(`[grok:${String(this.id).slice(0, 8)}] ${t}`);
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
      // A follow-up turn may already be running (the end event releases the
      // proc reference immediately) — its exit must not clobber this one.
      if (this.proc !== proc) return;
      this._endTurn();
      if (!this.sawResult) {
        // Crash / kill before the end event: still end the turn with a
        // visible reason so the UI composer re-enables.
        this.emit("event", {
          type: "claude",
          data: {
            type: "result",
            subtype: signal === "SIGTERM" || signal === "SIGKILL" ? "cancelled" : "error_during_execution",
            is_error: true,
            result: `grok exited (${code ?? "no code"}${signal ? `, signal ${signal}` : ""}) before finishing`,
          },
          sessionId: this.id,
        });
        if (signal !== "SIGTERM" && signal !== "SIGKILL") {
          this.emit("event", { type: "error", sessionId: this.id, message: `grok exited early (code ${code ?? "?"}${signal ? `, ${signal}` : ""})` });
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
    // NOTE: no "exit" event and ended stays false — a grok session dying
    // mid-turn (or idling for hours) is NOT terminal; the next send() spawns
    // a fresh process (resuming via the persisted grok session id).
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

  // Headless grok has no interactive control flow — answerControl is a no-op.
  answerControl() {
    return false;
  }
}
