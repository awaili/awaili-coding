import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Load a .env file by hand (no dependency needed).
function loadEnvFile() {
  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, val] = m;
    if (process.env[key] === undefined) {
      process.env[key] = val.replace(/^["']|["']$/g, "");
    }
  }
}
loadEnvFile();

export const config = {
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:11434",
  anthropicModel: process.env.ANTHROPIC_MODEL || "glm-5.2:cloud",
  anthropicHaikuModel:
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || process.env.ANTHROPIC_MODEL || "glm-5.2:cloud",
  anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || "dummy",
  // Base URL for the Ollama model catalog (GET /api/tags). The Anthropic
  // gateway and Ollama usually share one host, so this defaults to
  // ANTHROPIC_BASE_URL; set OLLAMA_BASE_URL only if they differ.
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL || process.env.ANTHROPIC_BASE_URL || "http://127.0.0.1:11434",
  // Selectable models for the UI's model dropdown. Comma-separated. Defaults to
  // the configured ANTHROPIC_MODEL so the list always contains the default. The
  // gateway exposes no model catalog, so this is the source of truth (with a
  // free-text "custom…" entry in the UI for anything not listed here).
  availableModels: (process.env.AVAILABLE_MODELS || process.env.ANTHROPIC_MODEL || "glm-5.2:cloud")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Long-lived Claude subscription OAuth token (from `claude setup-token`,
  // 1-year validity). setup-token only PRINTS the token — it does not write a
  // login into ~/.claude — so sessions routed `native` (see modelRoutes) need
  // it injected as CLAUDE_CODE_OAUTH_TOKEN. Lives in .env.auth (secrets file,
  // systemd EnvironmentFile), not .env.
  nativeOAuthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || "",
  // Per-model gateway routing: comma-separated `<prefix>=<target>` rules,
  // first matching prefix wins. Target forms:
  //   `native`        — the Claude subscription: no base URL or auth token
  //                     injected, nativeOAuthToken supplied via
  //                     CLAUDE_CODE_OAUTH_TOKEN (see above).
  //   `engine:<name>` — a non-claude session engine. Currently `codex`: the
  //                     official Codex CLI (ChatGPT-plan login) drives the
  //                     session via the codex.js adapter.
  //   `<baseUrl>`     — an Anthropic-protocol gateway, optionally followed by
  //                     `|<auth token>` (e.g. `grok-=http://127.0.0.1:11435|k`).
  // Models that match no rule use the global anthropicBaseUrl like before.
  modelRoutes: (process.env.MODEL_ROUTES || "claude-=native")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((rule) => {
      const eq = rule.indexOf("=");
      if (eq < 0) return null;
      const prefix = rule.slice(0, eq).trim();
      const target = rule.slice(eq + 1).trim();
      if (target === "native") return { prefix, native: true, engine: null, baseUrl: null, token: null };
      if (target.startsWith("engine:"))
        return { prefix, native: false, engine: target.slice(7).trim(), baseUrl: null, token: null };
      const pipe = target.indexOf("|");
      return pipe < 0
        ? { prefix, native: false, engine: null, baseUrl: target, token: null }
        : { prefix, native: false, engine: null, baseUrl: target.slice(0, pipe).trim(), token: target.slice(pipe + 1).trim() };
    })
    .filter(Boolean),
  // Force-include list of models that accept image (vision) input. Capability
  // is auto-detected from the gateway (see catalog.js — /api/tags and /api/show
  // both report a `capabilities` array containing "vision"), so this is only an
  // override for gateways that don't report capabilities, NOT the source of
  // truth it used to be. Comma-separated.
  visionModels: (process.env.VISION_MODELS || "gemma4:31b-cloud")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Force-EXCLUDE list, for a model that reports "vision" but whose gateway
  // rejects image blocks anyway (detection can only trust what it's told).
  // Wins over both auto-detection and visionModels above. Comma-separated.
  visionModelsExclude: (process.env.VISION_MODELS_EXCLUDE || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // The vision model used to transcribe images for text-only models: when a
  // message carries images and the session's model can't take them, the server
  // calls this model to turn the images into text and forwards THAT (see
  // vision.js + sessions.js send()). Keeps the user's chosen coding model in
  // place instead of restarting the session onto a vision model. Must itself be
  // vision-capable.
  visionDescribeModel: process.env.VISION_DESCRIBE_MODEL || "gemma4:31b-cloud",
  // Cumulative byte budget for base64 image blocks embedded in one session's
  // transcript. Every turn re-sends the whole history, and the gateway
  // (Ollama 0.34.0 /v1/messages) refuses to even READ a request body at
  // 16MB — so a session that keeps pasting screenshots for a vision-capable
  // model eventually crosses it and every subsequent message fails with
  // "failed to read request body" (400). Auto-compact can't catch this: it
  // counts tokens (~1.6K per image), not transport bytes. Once the session's
  // stored images plus this message's would exceed the budget, new images are
  // transcribed to text instead of embedded, bounding history growth.
  imageBudgetBytes: (Number(process.env.SESSION_IMAGE_BUDGET_MB) || 12) * 1024 * 1024,
  disableBetas: process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS || "1",
  port: Number(process.env.PORT) || 3001,
  // Loopback only, so the backend is never exposed on 0.0.0.0 past nginx
  // (plaintext HTTP, TLS skipped).
  host: process.env.HOST || "127.0.0.1",
  workspaceRoot: resolve(process.env.WORKSPACE_ROOT || resolve(root, "workspace")),
  skipPermissions: (process.env.SKIP_PERMISSIONS ?? "1") !== "0",
  // Interactive confirmation mode. When true (or CONFIRM_TOOLS=1), new chats
  // spawn claude in `default` permission mode WITHOUT --dangerously-skip-
  // permissions and WITHOUT an --allowedTools allowlist. Claude Code's default
  // rules auto-approve read-only tools but emit a `control_request`
  // (can_use_tool) for write/exec tools and AskUserQuestion, which the web UI
  // surfaces as an inline prompt the user answers (Allow / Deny / Always allow)
  // via a `control_response` written to the child's stdin. On by default so
  // users see and approve write/exec tools and AskUserQuestion; set
  // CONFIRM_TOOLS=0 to restore the old fully-autonomous behavior. The topbar
  // Confirm toggle still turns it off per-chat.
  confirmTools: (process.env.CONFIRM_TOOLS ?? "1") === "1",
  // Optional: when SKIP_PERMISSIONS=0, restrict to this allowlist instead.
  // Also used as the fallback allowlist when running as root (where
  // --dangerously-skip-permissions is refused). This is a comprehensive set of
  // the common tools a headless coding/research agent and its skills need, so
  // skills like /deep-research run without per-tool permission denials (which
  // print mode can't answer and would abort the run):
  //   - File/code: Read Write Edit Bash Glob Grep NotebookEdit
  //   - Web: WebFetch WebSearch
  //   - Orchestration: Agent Workflow Skill (Skill must be here or /<skill>
  //     can't be invoked at top level and the model falls back to a subagent,
  //     where the skill refuses with "Execute skill: <name>")
  //   - Task tracking: TodoWrite TaskCreate TaskUpdate TaskList TaskGet
  //     TaskOutput TaskStop
  //   - Planning: EnterPlanMode ExitPlanMode
  // Intentionally excluded (interactive/harness tools that don't make sense in
  // a headless -p session, or that can stall waiting for input print mode can't
  // provide): AskUserQuestion PushNotification Monitor CronCreate CronDelete
  // CronList ScheduleWakeup DesignSync EnterWorktree ExitWorktree. Add any of
  // these via ALLOWED_TOOLS in .env if you need them.
  allowedTools:
    process.env.ALLOWED_TOOLS ||
    "Read Write Edit Bash Glob Grep NotebookEdit WebFetch WebSearch Agent Workflow Skill TodoWrite TaskCreate TaskUpdate TaskList TaskGet TaskOutput TaskStop EnterPlanMode ExitPlanMode",
  // Login password for the web UI. If empty at startup, auth.js generates a
  // random one and logs it — anonymous access is never allowed.
  authPassword: process.env.AUTH_PASSWORD || "",
  // HMAC secret used to sign session cookies. If empty, a random ephemeral
  // secret is generated per process (sessions don't survive a restart).
  authSecret: process.env.AUTH_SECRET || "",
  // Paginated session history: when a session is opened, only the last
  // `historyInitialSize` messages are shipped to the client (saves WS payload
  // + DOM for long transcripts); older messages load in `historyPageSize`
  // batches via the "Load older" button. Override via env if desired.
  historyInitialSize: Number(process.env.HISTORY_INITIAL_SIZE) || 10,
  historyPageSize: Number(process.env.HISTORY_PAGE_SIZE) || 20,
  // Idle reaper. `claude -p --input-format stream-json` stays alive forever
  // waiting on stdin — it does NOT exit when a turn finishes — and ws.js
  // intentionally keeps subprocesses alive across WebSocket disconnects so a
  // chat can be resumed. Combined, every chat ever opened accumulates as a
  // ~300MB process. On a memory-constrained box (3.6GB, no swap) this OOMs.
  // The reaper periodically stop()s any session whose process has been idle
  // (not busy) longer than idleTimeoutMs. The map entry is kept so the
  // session resumes seamlessly on next open (ws.js's subscribe handler
  // restarts it via --resume and replays on-disk history). 0 disables.
  idleTimeoutMs: Number(process.env.IDLE_TIMEOUT_MS) || 10 * 60 * 1000,
  // Hard cap on simultaneously-alive claude processes. Starting a new
  // session when this many are already alive LRU-stops the oldest idle one
  // first (busy sessions are never evicted — that would kill in-flight work).
  // 0 disables the cap. Sized for a 3.6GB box: ~6 × 300MB leaves headroom.
  maxSessions: Number(process.env.MAX_SESSIONS) || 6,
  reaperIntervalMs: Number(process.env.REAPER_INTERVAL_MS) || 60 * 1000,
};

// Env vars that must NEVER reach a child process. Every spawn site here
// inherits the server's environment, and the server's environment carries the
// web UI's own credentials: AUTH_PASSWORD is the login password and AUTH_SECRET
// is the HMAC key that signs session cookies (leaking it lets anyone forge a
// cookie for anyone, and rotating the password doesn't help). The children are
// a fully-autonomous `claude` with Bash, the codex/grok CLIs, and an
// interactive root shell — i.e. precisely the places where `env | grep AUTH`
// is one command away. CLAUDE_CODE_OAUTH_TOKEN (the Claude subscription token)
// is stripped too: only `native`-routed sessions need it, and Session.env()
// injects it explicitly for those, so a gateway-routed session no longer
// carries a subscription bearer it has no business holding.
const SECRET_ENV_KEYS = ["AUTH_PASSWORD", "AUTH_SECRET", "CLAUDE_CODE_OAUTH_TOKEN"];

// `process.env` minus the server-only secrets above. EVERY spawn site must
// build its child env from this, never from process.env directly.
export function safeProcessEnv() {
  const env = { ...process.env };
  for (const k of SECRET_ENV_KEYS) delete env[k];
  return env;
}

export function childEnv() {
  return {
    ...safeProcessEnv(),
    ANTHROPIC_BASE_URL: config.anthropicBaseUrl,
    ANTHROPIC_MODEL: config.anthropicModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.anthropicHaikuModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.anthropicModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.anthropicModel,
    ANTHROPIC_AUTH_TOKEN: config.anthropicAuthToken,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: config.disableBetas,
  };
}

// Resolve which gateway/auth a model name routes to (see config.modelRoutes).
// Unrouted models fall back to the global gateway — the pre-routing behavior.
export function routeForModel(model) {
  for (const r of config.modelRoutes) {
    if (model && model.startsWith(r.prefix)) return r;
  }
  return { native: false, engine: null, baseUrl: config.anthropicBaseUrl, token: config.anthropicAuthToken };
}