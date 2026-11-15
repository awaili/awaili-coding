import { mkdir } from "node:fs/promises";
import { realpathSync, openSync, readSync, closeSync } from "node:fs";
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

// --- Skill injection marker ---------------------------------------------
// The send path may prepend a matched skill's instructions to the user's
// message (sessions.js), and the history reader must strip that wrapper back
// off so a resumed session shows the message the user actually typed
// (transcript.js). Both halves live here so the marker has ONE definition —
// they have to agree exactly or resumed chats show the skill preamble.
const SKILL_INJECT_HEAD = "[Active skill:";
const SKILL_INJECT_SEP = "\n\n---\n\nUser request:\n";

// Prepend a matched skill's instructions to the user's message so the model
// follows the skill even when it wouldn't auto-invoke. The block is clearly
// labeled (so it's visible in the transcript and the model treats it as
// guidance), then the user's original request follows verbatim.
export function injectSkill(skill, text) {
  const body = (skill.body || "").trim();
  const scope = skill.scope === "workspace" ? " (this workspace)" : " (global)";
  const header =
    `${SKILL_INJECT_HEAD} ${skill.name}${scope} — this request matched it. ` +
    `Apply the skill's instructions below, then fulfill the user's request.]`;
  return `${header}\n\n${body}${SKILL_INJECT_SEP}${text}`;
}

// Inverse of injectSkill for display. Only touches text that genuinely starts
// with the marker AND has the separator, so normal messages pass through
// untouched.
export function stripSkillInjection(text) {
  if (typeof text !== "string" || !text.startsWith(SKILL_INJECT_HEAD)) return text;
  const i = text.indexOf(SKILL_INJECT_SEP);
  if (i < 0) return text;
  return text.slice(i + SKILL_INJECT_SEP.length);
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

// Which engine wrote a session's transcript?
//
// All three engines write to the SAME file (sessionLogPath) in claude's JSONL
// record shape, but only the claude CLI's own records are a conversation it
// can resume: it stamps every record with `sessionId` (plus cwd/version/
// parentUuid/timestamp), while codex.js / grok.js write records carrying just
// {type, uuid, message} plus one `codex_thread` / `grok_session` sidecar.
//
// This distinction is load-bearing. `claude --resume <id>` pointed at an
// adapter-written transcript exits with "No conversation found with session ID:
// <id>", and `--session-id <id>` is refused as well once the file exists
// ("Session ID ... is already in use") — so a chat started on codex/grok cannot
// be driven by the claude CLI at all, and callers must check before spawning
// instead of letting the CLI fail with a message no user can act on.
//
// Returns "claude" | "codex" | "grok", or null when the file is missing,
// empty, or carries no marker yet (callers treat null as claude-resumable —
// the pre-existing behavior).
const ENGINE_SNIFF_BYTES = 256 * 1024;
export function transcriptEngine(path) {
  if (!path) return null;
  let fd;
  let buf;
  let bytes = 0;
  try {
    fd = openSync(path, "r");
    buf = Buffer.allocUnsafe(ENGINE_SNIFF_BYTES);
    bytes = readSync(fd, buf, 0, ENGINE_SNIFF_BYTES, 0);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
  if (!bytes) return null;
  const lines = buf.subarray(0, bytes).toString("utf8").split("\n");
  // The last line may be cut mid-record by the read cap — drop it unless the
  // read covered the whole file (then it is just the trailing empty string).
  if (bytes === ENGINE_SNIFF_BYTES) lines.pop();
  let adapter = null;
  for (const line of lines) {
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // partial/garbage line — keep looking
    }
    // A claude-native marker wins outright: an adapter sidecar can be appended
    // to a claude transcript (model switched the other way), and that file is
    // still resumable by the claude CLI.
    if (typeof rec?.sessionId === "string" && rec.sessionId) return "claude";
    if (!adapter) {
      if (rec?.type === "codex_thread") adapter = "codex";
      else if (rec?.type === "grok_session") adapter = "grok";
      else if (rec?.type === "usage" && (rec.engine === "codex" || rec.engine === "grok")) adapter = rec.engine;
    }
  }
  return adapter;
}
