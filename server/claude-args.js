import { config } from "./config.js";

const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Build the argv + env for a headless `claude` subprocess that streams
 * stream-json both directions. One long-lived process per chat session.
 *
 * @param {{ cwd: string, resume?: string, id?: string }} opts
 */
export function buildClaudeArgs({ cwd, resume, id }) {
  const args = [
    "-p", // print (non-interactive) mode
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--include-partial-messages",
    "--verbose",
  ];
  if (resume) {
    args.push("--resume", resume);
  } else {
    // Use the session id the manager already chose so claude's init event
    // reports the SAME id. If we generate a fresh one here, init reports a
    // different id, the server migrates its map key to that id, and the
    // frontend (which received our original id) never sees the streamed
    // answer — the chat looks like it got no response.
    args.push("--session-id", id || crypto.randomUUID());
  }
  args.push("--add-dir", cwd);

  // Permission strategy. --dangerously-skip-permissions gives full autonomy
  // but Claude Code refuses it when running as root/sudo (safety check). In
  // that case fall back to an --allowedTools allowlist so file/exec tools
  // still run without interactive prompts (which print mode can't answer).
  const wantSkip = config.skipPermissions && !isRoot;
  if (wantSkip) {
    args.push("--dangerously-skip-permissions");
  } else if (config.allowedTools) {
    if (config.skipPermissions && isRoot) {
      process.stderr.write(
        "[coding-ui] running as root: --dangerously-skip-permissions unavailable, using --allowedTools allowlist instead.\n",
      );
    }
    args.push("--allowedTools", ...config.allowedTools.split(/\s+/).filter(Boolean));
  }
  return args;
}