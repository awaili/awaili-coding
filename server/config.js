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
  // Models on this gateway that accept image (vision) input. When a message
  // carries image attachments and the active session's model isn't in this list,
  // the UI auto-restarts the session under the first entry (e.g. gemma4:31b-cloud)
  // before delivering the message — text-only models like glm-5.2:cloud 400 on
  // image blocks. Comma-separated; first entry is the auto-switch target.
  visionModels: (process.env.VISION_MODELS || "gemma4:31b-cloud")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  disableBetas: process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS || "1",
  port: Number(process.env.PORT) || 3001,
  // 仅监听回环口，避免后端绕过 nginx 直接暴露在 0.0.0.0（明文 HTTP + 跳过 TLS）。
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

export function childEnv() {
  return {
    ...process.env,
    ANTHROPIC_BASE_URL: config.anthropicBaseUrl,
    ANTHROPIC_MODEL: config.anthropicModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: config.anthropicHaikuModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: config.anthropicModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: config.anthropicModel,
    ANTHROPIC_AUTH_TOKEN: config.anthropicAuthToken,
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: config.disableBetas,
  };
}