import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { config, childEnv, routeForModel, contextWindowFor } from "./config.js";
import { buildClaudeArgs } from "./claude-args.js";
import { availableSkillsForCwd, pickSkill } from "./skills.js";
import { isVisionModel } from "./catalog.js";
import { transcribeImages } from "./vision.js";
import { sessionLogPath, fileToTextBlock, injectSkill, transcriptEngine } from "./util.js";
import { readHistory, readConversationText, embeddedImageBytes, forgetTranscript } from "./transcript.js";
import { CodexSession, codexHooks } from "./codex.js";
import { GrokSession, grokHooks } from "./grok.js";

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

// The codex/grok engine adapters report busy/metrics changes through here
// (their modules can't import this one — sessions.js constructs them).
codexHooks.onStateChange = () => {
  saveState();
  emitStatus();
};
grokHooks.onStateChange = () => {
  saveState();
  emitStatus();
};

// Pick the session class by model routing: models routed to a `engine:*`
// target run on that engine's adapter, everything else on the claude engine.
function sessionClassFor(model) {
  const engine = routeForModel(model).engine;
  if (engine === "codex") return CodexSession;
  if (engine === "grok") return GrokSession;
  return Session;
}

// Transcript path (claude's JSONL under ~/.claude/projects/<sanitized-cwd>/)
// lives in util.js now — shared with the codex engine adapter, which writes
// the same shape. We read it to show prior conversation when a session is
// resumed (--resume does NOT replay history in stream-json print mode).

// Transcript reading (history pagination, per-image fetch, and the embedded
// image budget) lives in transcript.js, which streams the JSONL instead of
// doing readFileSync + full-file JSON.parse on the event loop. See that
// module's header for the measured stall this removed.

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
        // Restore as real session instances (not plain objects) so the methods
        // used on resume — stop(), send() — exist. proc stays null: these are
        // not running, so stop() is a no-op until the session is re-picked and
        // SessionManager.start() spawns a fresh process for it.
        //
        // Pick the class by the session's OWN model, exactly like start()
        // does. Hardcoding the claude Session here (as this did) silently
        // changed a codex/grok chat's engine on every server restart, and the
        // claude CLI cannot drive an adapter-written transcript — so reopening
        // such a chat after a restart died with "No conversation found with
        // session ID: <id>".
        const sess = new (sessionClassFor(s.model))({ id: s.id, cwd: s.cwd, resume: s.id, model: s.model, confirm: s.confirm });
        sess.title = s.title;
        sess.createdAt = s.createdAt;
        sess.metrics = s.metrics || null;
        // Restored lastActivity keeps the sidebar's "last seen" honest across a
        // server restart (without it every session looks just-used).
        if (typeof s.lastActivity === "number") sess.lastActivity = s.lastActivity;
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
  const arr = [...sessions.values()].map(({ id, cwd, title, createdAt, model, confirm, metrics, lastActivity }) => ({
    id,
    cwd,
    title,
    createdAt,
    model,
    confirm,
    metrics: metrics || null,
    lastActivity: lastActivity || null,
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

// Pull the display-relevant metrics out of a stream-json `result` event. The
// usage.* token counts are for the LAST turn only; total_cost_usd, duration_ms
// and num_turns are cumulative across the whole session (claude accumulates
// them, so we just take its value rather than re-summing). Returns null only
// if the event is malformed — a normal result always has usage + totals.
// Tools whose file_path/notebook_path argument names a workspace file they
// mutate — the sources of the `fs-changed` event and the artifact index.
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function extractMetrics(evt) {
  const u = evt && evt.usage ? evt.usage : {};
  return {
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheCreationTokens: u.cache_creation_input_tokens || 0,
    // Approximate context occupancy after this turn: everything the model was
    // handed (input + cache read + cache write) is what the next turn re-sends.
    // Used by the UI's context gauge and the `context-high` warning.
    contextTokens:
      (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
    totalCostUsd: typeof evt.total_cost_usd === "number" ? evt.total_cost_usd : null,
    totalDurationMs: typeof evt.duration_ms === "number" ? evt.duration_ms : null,
    totalTurns: typeof evt.num_turns === "number" ? evt.num_turns : null,
  };
}

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
    // Metrics from the last `result` event (one per completed turn). Carries
    // the last turn's token breakdown (usage.*) plus the session-cumulative
    // cost/duration/turns that claude reports authoritatively — total_cost_usd,
    // duration_ms and num_turns are cumulative across the WHOLE session, not
    // per-turn. Persisted so a resumed session shows its last-known metrics
    // until the next turn refreshes them; the on-disk transcript does NOT store
    // the result event, so without persisting here the metrics are lost on
    // restart and the UI has nothing to show for past sessions.
    this.metrics = null;
    // Absolute file paths touched by file-mutating tools (Edit/Write/MultiEdit/
    // NotebookEdit) during the CURRENT turn. Flushed as an `fs-changed` event
    // on the turn's result so the file tree can refresh without polling.
    this.turnFiles = [];
    // Whether a `context-high` warning already fired for the current occupancy
    // band (re-arms once usage drops well below the threshold).
    this.contextWarned = false;
  }

  // Child env with this session's model overriding the global default. All four
  // model aliases are set so background/haiku calls hit a model that resolves on
  // the session's route (matches childEnv()'s single-model behavior).
  //
  // Per-model routing (config.modelRoutes): a `native` route means the model is
  // served by the claude CLI's own subscription OAuth — the gateway base URL,
  // dummy auth token and beta-trimming var must NOT be injected (they would
  // override ~/.claude credentials and 401). Any other route overrides the
  // base URL (and token when the rule carries one) so future per-model shims
  // can coexist with the global gateway.
  env() {
    const env = {
      ...childEnv(),
      ANTHROPIC_MODEL: this.model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: this.model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: this.model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: this.model,
    };
    const route = routeForModel(this.model);
    if (route.native) {
      delete env.ANTHROPIC_BASE_URL;
      delete env.ANTHROPIC_AUTH_TOKEN;
      // Beta trimming exists only for non-Anthropic gateways; let the native
      // client send whatever headers it wants.
      delete env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS;
      // setup-token doesn't write a login into ~/.claude — it only prints a
      // long-lived token, so it must ride in via env.
      if (config.nativeOAuthToken) env.CLAUDE_CODE_OAUTH_TOKEN = config.nativeOAuthToken;
    } else {
      if (route.baseUrl) env.ANTHROPIC_BASE_URL = route.baseUrl;
      if (route.token) env.ANTHROPIC_AUTH_TOKEN = route.token;
    }
    return env;
  }

  start() {
    // Recompute --resume at spawn time from the transcript's existence. A
    // session created as a new chat is constructed with resume:undefined and
    // this.resume was never refreshed, so reactivating it after its process
    // died (idle reaper, exit) used to spawn `--session-id <id>` again — which
    // claude ≥2.1.268 REFUSES once <id>.jsonl exists ("Session ID ... is
    // already in use") and exits immediately, leaving the session impossible
    // to reopen. The transcript is the source of truth: if it's there, this
    // session has history and must be resumed, never restarted fresh.
    const logPath = sessionLogPath(this.cwd, this.id);
    const hasLog = !!(logPath && existsSync(logPath));
    // ...but only the claude CLI's own transcripts are resumable by it. A chat
    // whose history was written by the codex/grok adapter can be driven by
    // neither flag — `--resume` exits with "No conversation found with session
    // ID", `--session-id` is refused as above — so refuse here with a message
    // that names the way out, instead of spawning a process that dies on a
    // line the user can't act on. (Reached when a chat's model is switched
    // across engines, or when such a session is restored after a restart.)
    const owner = hasLog ? transcriptEngine(logPath) : null;
    if (owner && owner !== "claude") {
      const back = owner === "codex" ? "gpt-5.6-*" : "grok-*";
      this.ended = true;
      this.busy = false;
      this.emit("event", {
        type: "error",
        sessionId: this.id,
        message:
          `This chat was created with the ${owner} engine and the claude CLI cannot resume its history. ` +
          `Switch the model back to a ${back} model to continue it, or start a new chat under ${this.model}.`,
      });
      return this.id;
    }
    this.resume = hasLog ? this.id : undefined;
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
      this.metrics = extractMetrics(evt);
      saveState();
      emitStatus();
      // Tell subscribed clients which workspace files this turn touched, so
      // the file tree can refresh exactly the affected folders instead of
      // polling (collected from the turn's assistant tool_use blocks below).
      if (this.turnFiles && this.turnFiles.length) {
        const files = [...new Set(this.turnFiles)];
        this.turnFiles = [];
        this.emit("event", { type: "fs-changed", sessionId: this.id, files });
      }
      // Context gauge warning: occupancy (input + cache of the last turn
      // approximates the re-sent history) past the configured fraction of the
      // model's declared window. Fires once per band crossing; the Compact
      // button in the UI is the way out.
      const window_ = contextWindowFor(this.model);
      const used = this.metrics.contextTokens || 0;
      const pct = used / window_;
      if (pct >= config.contextHighPct && !this.contextWarned) {
        this.contextWarned = true;
        this.emit("event", {
          type: "context-high",
          sessionId: this.id,
          used,
          window: window_,
          pct,
        });
      } else if (pct < config.contextHighPct * 0.8) {
        this.contextWarned = false;
      }
    }
    // Collect file-mutating tool calls for the `fs-changed` event above. Only
    // the assembled `assistant` events carry parsed tool_use inputs (the raw
    // stream_events don't), so this is the one scan point.
    if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
      for (const b of evt.message.content) {
        if (b && b.type === "tool_use" && FILE_MUTATING_TOOLS.has(b.name)) {
          const p = b.input?.file_path || b.input?.notebook_path;
          if (typeof p === "string" && p) this.turnFiles.push(p);
        }
      }
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
    // A gateway that rejects image blocks surfaces as an ordinary `assistant`
    // message whose text is "API Error: 400 {...this model does not support
    // image input...}" — the CLI synthesizes it, so it renders as a normal
    // bubble with no hint of what to do about it. Flag it so the UI can offer
    // a way out. Requiring the specific phrase (not just /image/) keeps a model
    // that merely *quotes* this error from tripping it.
    if (
      evt.type === "assistant" &&
      evt.error === "invalid_request" &&
      /does not support image input/i.test(
        (evt.message?.content || [])
          .filter((b) => b && b.type === "text")
          .map((b) => b.text || "")
          .join(" "),
      )
    ) {
      this.emit("event", { type: "vision-unsupported", sessionId: this.id, model: this.model });
    }
    // Same shape, different disease: the gateway (Ollama 0.34.0) refuses to
    // even READ a request body at 16MB, and every turn re-sends the whole
    // history — so a session that accumulated too many embedded images (see
    // config.imageBudgetBytes) or other huge content fails EVERY message with
    // "failed to read request body" and retrying can never help. Flag it so
    // the UI can tell the user the way out is a fresh session (the old
    // transcript, images included, stays viewable).
    if (
      evt.type === "assistant" &&
      /failed to read request body/i.test(
        (evt.message?.content || [])
          .filter((b) => b && b.type === "text")
          .map((b) => b.text || "")
          .join(" "),
      )
    ) {
      this.emit("event", { type: "payload-too-large", sessionId: this.id, model: this.model });
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

  async send(text, attachments = [], uid, opts = {}) {
    if (!this.proc || this.ended) {
      this.emit("event", { type: "error", sessionId: this.id, message: "session is not running" });
      return false;
    }
    // Catch-all early warning: the transcript's total size approximates what
    // every turn re-sends, whatever accumulated it — pasted images, tool-
    // result screenshots (a browser driver's PNGs Read back as image blocks),
    // giant dumps. Past the budget the session is one 16MB gateway read away
    // from a hard 400 no retry can fix, so tell the user once, before it
    // breaks. (The embed-vs-transcribe guard below handles new images; this
    // covers sources the server can't intercept.)
    try {
      const log = sessionLogPath(this.cwd, this.id);
      if (log && !this.limitWarned && (await stat(log)).size > config.imageBudgetBytes) {
        this.limitWarned = true;
        this.emit("event", { type: "payload-near-limit", sessionId: this.id });
      }
    } catch {
      // no transcript yet (fresh session) — nothing to warn about
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
    // opts.noSkill skips matching (used by compaction's seed message — a
    // summary of past work shouldn't pull a runbook into the new session).
    if (userText.trim() && !userText.trim().startsWith("/") && !opts.noSkill) {
      try {
        const skills = await availableSkillsForCwd(this.cwd);
        const match = pickSkill(userText, skills);
        if (match) userText = injectSkill(match, userText);
      } catch {
        // Never block sending on a skill-matching failure.
      }
    }
    if (userText.length > 0) content.push({ type: "text", text: userText });

    // An image block is only legal for a model that accepts image input — the
    // gateway hard-400s otherwise ("this model does not support image input").
    // The model is fixed for the lifetime of this process, so rather than
    // restart the session onto a vision model (which used to silently move the
    // user's whole conversation onto a weaker coding model), transcribe the
    // images with a vision model and forward the TEXT. The chosen model keeps
    // doing the coding; it just receives the image as words. See vision.js.
    const images = attachments.filter(
      (a) =>
        a && typeof a.data === "string" && a.data && String(a.mediaType || "").startsWith("image/"),
    );
    let visionOk = true;
    let overBudget = false;
    if (images.length) {
      visionOk = await isVisionModel(this.model);
      if (visionOk) {
        // Transport guard: even a vision-capable model can't keep taking raw
        // image blocks forever — each one is embedded in the transcript and
        // re-sent on every turn, and the gateway stops READING the request at
        // 16MB (see config.imageBudgetBytes). Once stored + incoming images
        // would cross the budget, transcribe instead of embed: the session
        // keeps working, the model just receives later screenshots as words.
        const incoming = images.reduce((n, a) => n + a.data.length, 0);
        if ((await embeddedImageBytes(this.cwd, this.id)) + incoming > config.imageBudgetBytes) {
          visionOk = false;
          overBudget = true;
        }
      }
      if (!visionOk) {
        const describeModel = config.visionDescribeModel;
        // Mark busy before the (multi-second) transcription so the UI shows
        // work in progress and the idle reaper doesn't stop us mid-flight.
        this.busy = true;
        this.lastActivity = Date.now();
        emitStatus();
        this.emit("event", {
          type: "vision-transcribing",
          sessionId: this.id,
          uid,
          model: describeModel,
          count: images.length,
        });
        try {
          const r = await transcribeImages(images, { model: describeModel });
          const note = overBudget
            ? "session image bytes are near the gateway request limit, transcribing instead so the body is not rejected"
            : "";
          content.push({
            type: "text",
            text: `[image transcript · ${r.model}${note ? ` · ${note}` : ""}]\n${r.text}`,
          });
          this.emit("event", {
            type: "vision-transcribed",
            sessionId: this.id,
            uid,
            model: r.model,
            count: images.length,
            truncated: r.truncated,
            text: r.text,
          });
        } catch (err) {
          // Nothing was sent, so don't leave the session wedged as busy.
          this.busy = false;
          emitStatus();
          const why = overBudget
            ? `This session's images hit the gateway request limit, and transcribing them failed (${err.message}). ` +
              "Start a new session, or describe the image in text."
            : `${this.model} does not accept images and automatic transcription failed (${err.message}). ` +
              `Switch to ${describeModel}, or describe the image in text.`;
          this.emit("event", { type: "error", sessionId: this.id, message: why });
          return false;
        }
      }
    }

    for (const att of attachments) {
      if (!att || typeof att.data !== "string" || !att.data) continue;
      const mediaType = String(att.mediaType || "");
      const name = String(att.name || "");
      if (mediaType.startsWith("image/")) {
        // Reachable only for a vision-capable model; a text-only one already
        // got the transcription pushed above (and must NOT get an image block).
        if (visionOk) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: mediaType, data: att.data },
          });
        }
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

// injectSkill() (send path) and stripSkillInjection() (history path, used by
// transcript.js) both live in util.js now — the marker they wrap/unwrap has to
// agree exactly, so it has one definition.

// Turn a non-image base64 attachment into an Anthropic text content block. If
// the decoded bytes look textual (no NUL bytes in the first 8 KB), inline the
// contents under a labeled fenced block so the model can read the file — works
// on every model, including text-only ones. Otherwise emit a short note (the
// Claude Messages API only accepts image + PDF document blocks, not arbitrary
// binaries, and this gateway's models don't take document blocks). Inlined
// text is capped to keep the prompt bounded; a truncation note is appended.
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

// One-shot `claude -p` used by compaction: render the transcript as plain
// text (transcript.js readConversationText) and summarize it into a dense
// handoff note. Runs with the SAME env/routing as the session (Session.env())
// so the summary comes from a model the gateway can actually serve. The
// prompt rides on stdin (it can be hundreds of KB, too big for argv).
const COMPACT_PROMPT = [
  "You are compacting a coding-assistant conversation. Produce a dense handoff summary",
  "in markdown for the engineer who will continue the work. Cover, in this order:",
  "1. Goal — what the user is trying to accomplish.",
  "2. Decisions made and their rationale.",
  "3. Current state — what works, what is in progress, what failed.",
  "4. Files changed / created / deleted (paths as they appeared).",
  "5. Commands, endpoints, and environment facts that came up.",
  "6. Open questions and explicit next steps.",
  "Keep it under ~1200 words. Prefer concrete identifiers (paths, commands, values) over prose.",
  "",
  "<conversation>",
].join("\n");

function summarizeOnce(session, conversationText) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("claude", ["-p"], { cwd: session.cwd, env: session.env(), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      reject(e);
      return;
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error("summarize timed out after 240s"));
    }, 240000);
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.stdout.on("data", (d) => {
      out += d;
      if (out.length > 400_000) {
        try {
          proc.kill();
        } catch {
          /* cap enforced by the kill */
        }
      }
    });
    proc.stderr.on("data", (d) => {
      err += d;
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (code === 0 && text) resolve(text);
      else reject(new Error(err.trim().split("\n").slice(-3).join(" ") || `claude -p exited with code ${code}`));
    });
    proc.stdin.on("error", () => {});
    proc.stdin.write(`${COMPACT_PROMPT}\n${conversationText}\n</conversation>`);
    proc.stdin.end();
  });
}

export const SessionManager = {
  /** Start a new session or resume an existing one. Returns sessionId. */
  start({ cwd, sessionId, model, confirm }) {
    mkdirSync(cwd, { recursive: true });
    if (sessionId && sessions.has(sessionId)) {
      const s = sessions.get(sessionId);
      // A passed model switches the session's model (restart-with-resume under
      // the new model); otherwise keep the model it was already using. Same for
      // confirm: an explicit boolean toggles interactive confirmation mode
      // (restarting under it); undefined keeps whatever the session had.
      const nextModel = model || s.model;
      const nextConfirm = confirm === undefined ? s.confirm : !!confirm;
      // Switching a codex/grok chat onto a claude-engine model would strand
      // it: the claude CLI can resume neither an adapter-written transcript
      // nor an id whose file already exists (see util.js transcriptEngine).
      // Refuse the switch while the session is still intact — stopping it
      // first and failing at spawn time left the chat unusable until the user
      // guessed to switch back. The unchanged model goes back to the client in
      // ws.js's `session` reply, so the dropdown snaps back by itself.
      const logPath = sessionLogPath(s.cwd, sessionId);
      const owner = logPath && existsSync(logPath) ? transcriptEngine(logPath) : null;
      if (sessionClassFor(nextModel) === Session && owner && owner !== "claude") {
        s.emit("event", {
          type: "error",
          sessionId,
          message:
            `This chat runs on the ${owner} engine, and ${nextModel} would hand its history to the claude CLI, ` +
            `which cannot resume it. Keeping ${s.model}. Start a new chat to use ${nextModel}.`,
        });
        return sessionId;
      }
      // Stop the prior process before replacing it. Without this, re-picking a
      // running session (or switching its model) would overwrite the map entry
      // and orphan the old claude subprocess.
      s.stop();
      const resume = existsSync(sessionLogPath(s.cwd, sessionId) || "") ? sessionId : undefined;
      const sess = new (sessionClassFor(nextModel))({ id: sessionId, cwd: s.cwd, resume, model: nextModel, confirm: nextConfirm });
      // The restart replaces the map entry with a fresh Session object, so
      // carry over everything the constructor doesn't take — otherwise a
      // model/confirm switch resets the sidebar row to "(no title)" and
      // drops the persisted metrics.
      sess.title = s.title;
      sess.createdAt = s.createdAt;
      sess.metrics = s.metrics || null;
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
    const chosenModel = model || config.anthropicModel;
    const sess = new (sessionClassFor(chosenModel))({
      id,
      cwd,
      resume,
      model: chosenModel,
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

  async send(sessionId, text, attachments = [], uid) {
    const s = sessions.get(sessionId);
    if (!s) return false;
    if (s.title === undefined) {
      const t = typeof text === "string" ? text.trim() : "";
      const n = Array.isArray(attachments) ? attachments.length : 0;
      s.title = t ? t.slice(0, 60) : n ? `[${n} attachment${n > 1 ? "s" : ""}]` : "(empty)";
      saveState();
    }
    return s.send(text, attachments, uid);
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
    // Drop the transcript's cached image index/budget with it.
    forgetTranscript(s.cwd, sessionId);
    emitStatus();
    return true;
  },

  // Compact a session: render its transcript as plain text, summarize it with
  // a one-shot `claude -p`, and start a successor session seeded with the
  // summary. The old chat's process is stopped (its entry + transcript stay,
  // so the old conversation is still readable). Returns { ok, newId } or
  // { error }. Clients subscribed to the old session get a `compacted` event
  // naming the successor so they can follow it.
  async compact(sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return { error: "no such session" };
    if (s.busy) return { error: "session is busy — wait for the current turn to finish" };
    const engine = routeForModel(s.model).engine;
    if (engine) return { error: `compaction runs on the claude engine; this chat is on the ${engine} engine` };
    const conv = await readConversationText(s.cwd, s.id);
    if (!conv.count) return { error: "this session has no history to compact" };
    let summary;
    try {
      summary = await summarizeOnce(s, conv.text);
    } catch (e) {
      return { error: `summarizing the session failed: ${e.message}` };
    }
    // Start the successor: a brand-new session id, same cwd/model/mode, then
    // seed it with the summary. SessionManager.start enforces the concurrency
    // cap for the extra process; the old one is stopped below.
    const newId = crypto.randomUUID();
    this.start({ cwd: s.cwd, sessionId: newId, model: s.model, confirm: s.confirm });
    const sess = sessions.get(newId);
    if (!sess) return { error: "failed to start the compacted session" };
    sess.title = `${s.title || s.id.slice(0, 8)} (compact)`;
    saveState();
    const seed =
      "[Session continuation — the previous conversation was compacted to free context. " +
      "A summary follows. Pick up from this state; do not re-explain it.]\n\n" +
      `${summary}\n\n` +
      "[Reply with one short line confirming you are ready to continue.]";
    const ok = await sess.send(seed, [], undefined, { noSkill: true });
    if (!ok) return { error: "failed to seed the compacted session" };
    // Free the old chat's ~300MB process; the map entry + transcript stay so
    // the user can still open and read the old conversation.
    s.stop();
    s.emit("event", { type: "compacted", sessionId: s.id, newId });
    emitStatus();
    return { ok: true, newId };
  },

  list() {
    return [...sessions.values()].map((s) => {
      const { id, cwd, title, createdAt, model, busy, ended, confirm, metrics, lastActivity } = s;
      // Enrich with cheap-but-useful metadata for the sidebar: which engine
      // drives the chat, how big its transcript has grown (bytes), and the
      // context occupancy vs the model's declared window (see config.js).
      const engine = routeForModel(model).engine || "claude";
      let bytes = 0;
      const logPath = sessionLogPath(cwd, id);
      if (logPath) {
        try {
          bytes = statSync(logPath).size;
        } catch {
          /* no transcript yet */
        }
      }
      const window_ = contextWindowFor(model);
      const used = metrics?.contextTokens || 0;
      return {
        id,
        cwd,
        title,
        createdAt,
        model,
        busy: !!busy,
        ended: !!ended,
        confirm: !!confirm,
        metrics: metrics || null,
        lastActivity: lastActivity || null,
        engine,
        bytes,
        context: { used, window: window_, pct: window_ ? used / window_ : 0 },
      };
    });
  },

  get(sessionId) {
    return sessions.get(sessionId);
  },

  // Prior transcript for a session, in the frontend's message shape (empty if
  // the JSONL log doesn't exist yet, e.g. a brand-new session). `opts` is
  // {limit[, beforeIndex]} and the result is a page: {messages, oldestIndex,
  // hasMore}. Async — the transcript is streamed, not slurped (transcript.js).
  async history(sessionId, opts) {
    const s = sessions.get(sessionId);
    if (!s) return { messages: [], oldestIndex: 0, hasMore: false };
    return readHistory(s.cwd, sessionId, opts);
  },
};

// ws.js attaches its own `sess.on('event', ...)` listener after start(), via
// SessionManager.get(id). Each Session is itself an EventEmitter, so no global
// bus is needed.