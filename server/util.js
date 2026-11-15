import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve, relative, dirname, basename, sep, join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";

export async function mkdirp(p) {
  await mkdir(p, { recursive: true });
  return p;
}

// realpath() that returns null instead of throwing when the path doesn't exist
// (e.g. a file about to be written). Used by safe() so symlink resolution can
// still run on the existing parent directory.
function realpathOrNull(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// True if `target` is `root` itself or a path beneath it. String-only (no
// symlink follow) — the cheap first confinement check; safe() additionally
// realpaths to defeat symlinks.
function inside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

// Confine an attacker-supplied cwd to WORKSPACE_ROOT. Returns the confined
// absolute path, or null if it escapes. `want` may be absolute or relative;
// absolute paths outside the workspace are rejected by the relative() check.
export function confineCwd(want) {
  const root = resolve(config.workspaceRoot);
  const target = resolve(root, want || ".");
  if (!inside(root, target)) return null;
  return target;
}

// Resolve `sub` under `root` and confine it, following symlinks so a symlink
// inside the workspace that points outside can't be used to escape. Returns the
// real absolute path or null. `root` must already be confined (caller passes a
// cwd that passed confineCwd()).
export function safe(root, sub) {
  const target = resolve(root, sub || ".");
  if (!inside(root, target)) return null;
  const realRoot = realpathOrNull(root) || root;
  // If the target exists, realpath it; otherwise realpath its parent and
  // re-join the basename (for files about to be created).
  const realTarget = realpathOrNull(target);
  const real = realTarget || (realpathOrNull(dirname(target)) ? resolve(realpathOrNull(dirname(target)), basename(target)) : target);
  if (!inside(realRoot, real)) return null;
  return real;
}
// --- Shared session helpers (sessions.js and codex.js both use these) ---

// sessionId is joined into a path, so reject anything outside a safe charset
// (defense in depth — the HTTP caller is also validated upstream).
export const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Claude Code stores each session's full transcript as JSONL under
// ~/.claude/projects/<sanitized-cwd>/<sessionId>.jsonl. The sanitizer turns
// path separators AND underscores/dots into dashes, so a cwd like
// /data/.../idc_migrate lands in a dir named ...-idc-migrate (hyphen, not
// underscore). The claude engine writes this file itself; the codex engine's
// adapter writes the SAME shape so history loading stays engine-agnostic.
export function sessionLogPath(cwd, sessionId) {
  const sid = String(sessionId || "");
  if (!ID_RE.test(sid)) return null; // caller treats null as "no transcript"
  const enc = String(cwd).replace(/[\/\\._]/g, "-");
  return join(homedir(), ".claude", "projects", enc, `${sid}.jsonl`);
}

const INLINE_TEXT_CAP = 200 * 1024; // 200 KB of decoded text per file

// Turn a base64 attachment into an inline text block when it looks textual,
// else a placeholder note. Shared by the claude and codex send paths.
export function fileToTextBlock(b64, mediaType, name) {
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
