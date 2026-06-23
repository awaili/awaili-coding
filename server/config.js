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
  disableBetas: process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS || "1",
  port: Number(process.env.PORT) || 3001,
  workspaceRoot: resolve(process.env.WORKSPACE_ROOT || resolve(root, "workspace")),
  skipPermissions: (process.env.SKIP_PERMISSIONS ?? "1") !== "0",
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