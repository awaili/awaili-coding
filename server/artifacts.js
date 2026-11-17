// Session artifact index: WHICH workspace files a session touched, derived
// from its transcript.
//
// A transcript already records every Edit/Write/MultiEdit/NotebookEdit call
// (assistant records carry tool_use blocks with a file_path input), but the
// UI had no way to surface them — after a long agentic turn the user had to
// eyeball the file tree for what changed. This module streams the transcript
// once (transcript.js iterRecords — same chunked reader the history view
// uses), aggregates per-file op counts and timestamps, and memoizes the
// result on (size, mtime) so repeated panel opens don't rescan.
//
// The same index drives the "download session artifacts" zip: copy every
// still-existing file into a temp tree preserving its path relative to the
// session cwd, then hand it to `zip` (mirroring skills.js's use of
// unzip/zip instead of an archiver dependency).
import { stat, mkdtemp, rm, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, resolve, dirname, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sessionLogPath, confineCwd } from "./util.js";
import { iterRecords } from "./transcript.js";
import { safeProcessEnv } from "./config.js";

const execFileP = promisify(execFile);

const FILE_MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Bounds for the artifacts zip (the listing itself is unbounded — it's just
// metadata). A session that edited more files than this was probably editing
// node_modules; cap the damage rather than the convenience.
const ZIP_MAX_FILES = 500;
const ZIP_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

// path argument of a file-mutating tool_use input, or null.
function toolFilePath(name, input) {
  if (!FILE_MUTATING_TOOLS.has(name) || !input || typeof input !== "object") return null;
  const p = input.file_path || input.notebook_path;
  return typeof p === "string" && p ? p : null;
}

// (size, mtime)-memoized per-transcript artifact scan. Like the image index
// in transcript.js this leans on transcripts being append-only, but a full
// rescan on any size change is fine here: the scan is one pass over JSONL
// that only extracts tool names/paths, and the panel is opened on demand.
const artifactCache = new Map(); // path -> { size, mtime, items }

/**
 * Files a session touched, newest first. Each item:
 *   path    — absolute path as the tool call named it
 *   rel     — path relative to the session cwd (null when outside it)
 *   ops     — { Edit: n, Write: n, ... } call counts per tool
 *   count   — total calls touching the file
 *   firstAt / lastAt — ISO timestamps of the first/last call (null when the
 *                      record carried no timestamp)
 */
export async function sessionArtifacts(cwd, sessionId) {
  const path = sessionLogPath(cwd, sessionId);
  if (!path) return [];
  let st;
  try {
    st = await stat(path);
  } catch {
    return [];
  }
  const cached = artifactCache.get(path);
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.items;

  const byFile = new Map(); // path -> { ops, count, firstAt, lastAt }
  for await (const { rec } of iterRecords(path)) {
    if (!rec || rec.isSidechain || rec.type !== "assistant") continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || b.type !== "tool_use") continue;
      const p = toolFilePath(b.name, b.input);
      if (!p) continue;
      let e = byFile.get(p);
      if (!e) {
        e = { path: p, ops: {}, count: 0, firstAt: null, lastAt: null };
        byFile.set(p, e);
      }
      e.ops[b.name] = (e.ops[b.name] || 0) + 1;
      e.count += 1;
      if (rec.timestamp) {
        if (!e.firstAt) e.firstAt = rec.timestamp;
        e.lastAt = rec.timestamp;
      }
    }
  }
  const items = [...byFile.values()]
    .map((e) => {
      const rel = isAbsolute(e.path) ? relative(cwd, e.path) : null;
      return {
        path: e.path,
        rel: rel && !rel.startsWith("..") && !rel.includes(`..${sep}`) ? rel : null,
        ops: e.ops,
        count: e.count,
        firstAt: e.firstAt,
        lastAt: e.lastAt,
      };
    })
    .sort((a, b) => String(b.lastAt || "").localeCompare(String(a.lastAt || "")));
  const entry = { size: st.size, mtime: st.mtimeMs, items };
  artifactCache.set(path, entry);
  return items;
}

/**
 * Zip of a session's still-existing artifacts, laid out by their paths
 * relative to the session cwd. Files outside cwd (or missing) are skipped —
 * the listing shows them, but a download bundle shouldn't reach outside the
 * workspace. Returns { buffer, name } or null when there is nothing to zip.
 */
export async function artifactsZip(cwd, sessionId) {
  const root = confineCwd(cwd);
  if (!root) return null;
  const items = (await sessionArtifacts(root, sessionId)).filter((e) => e.rel);
  if (!items.length) return null;

  let tmp;
  try {
    tmp = await mkdtemp(join(tmpdir(), "artifacts-"));
    let total = 0;
    let zipped = 0;
    for (const e of items) {
      if (zipped >= ZIP_MAX_FILES) break;
      const src = resolve(root, e.rel);
      let st;
      try {
        st = await stat(src);
      } catch {
        continue; // deleted since the transcript recorded it — skip
      }
      if (!st.isFile()) continue;
      total += st.size;
      if (total > ZIP_MAX_TOTAL_BYTES) break;
      const dst = join(tmp, e.rel);
      await mkdir(dirname(dst), { recursive: true });
      await copyFile(src, dst);
      zipped += 1;
    }
    if (!zipped) return null;
    // encoding:"buffer": the zip is binary — execFile's default utf8 decoding
    // would replace every invalid byte sequence with U+FFFD and corrupt it.
    const { stdout } = await execFileP("zip", ["-rq", "-", "."], {
      cwd: tmp,
      timeout: 60000,
      maxBuffer: 128 * 1024 * 1024,
      encoding: "buffer",
      env: safeProcessEnv(), // see config.js SECRET_ENV_KEYS
    });
    return { buffer: stdout, name: `artifacts-${sessionId.slice(0, 8)}.zip`, files: zipped };
  } catch (e) {
    if (/ENOENT|spawn zip/i.test(e.message || ""))
      throw new Error("zip is not installed on the server (required to download artifacts)");
    throw e;
  } finally {
    if (tmp) {
      try {
        await rm(tmp, { recursive: true, force: true });
      } catch {
        /* temp cleanup is best-effort */
      }
    }
  }
}
