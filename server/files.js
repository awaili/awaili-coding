import { Router } from "express";
import { readdir, readFile, writeFile, stat, rmdir, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, basename, join, relative, sep } from "node:path";
import { config } from "./config.js";
import { mkdirp, confineCwd, safe } from "./util.js";
import { SessionManager } from "./sessions.js";

const router = Router();

const IGNORE = new Set(["node_modules", ".git", "dist", ".vite"]);

// Confine an attacker-supplied cwd to WORKSPACE_ROOT. The old `safe()` only
// confined `path` under whatever `cwd` the client sent — so `?cwd=/etc` made the
// whole traversal guard meaningless. Reject up front if cwd escapes.
function confinedCwd(reqCwd) {
  const root = confineCwd(reqCwd);
  if (!root) return null;
  return root;
}

// GET /api/files?cwd=<abs>&path=<rel>  -> tree of dir (one level) or file contents
router.get("/files", async (req, res) => {
  const root = confinedCwd(req.query.cwd);
  if (!root) return res.status(400).json({ error: "workspace outside WORKSPACE_ROOT" });
  const sub = req.query.path ? String(req.query.path) : "";
  const target = safe(root, sub);
  if (!target) return res.status(400).json({ error: "path outside workspace" });

  let st;
  try {
    st = await stat(target);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }

  if (st.isFile()) {
    try {
      const content = await readFile(target, "utf8");
      return res.json({ type: "file", path: sub, content });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  try {
    const entries = await readdir(target, { withFileTypes: true });
    const items = entries
      .filter((e) => !IGNORE.has(e.name) && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, dir: e.isDirectory(), path: sub ? `${sub}/${e.name}` : e.name }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    res.json({ type: "dir", path: sub, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/files/download?cwd=<abs>&path=<rel> -> stream a file as an attachment
// (Content-Disposition: attachment). Confined under cwd via safe(). Directories
// are rejected — the UI only offers this on files. Same-origin GET carries the
// session cookie, so no extra auth handling is needed on the client.
router.get("/files/download", async (req, res) => {
  const root = confinedCwd(req.query.cwd);
  if (!root) return res.status(400).json({ error: "workspace outside WORKSPACE_ROOT" });
  const sub = req.query.path ? String(req.query.path) : "";
  if (!sub) return res.status(400).json({ error: "path required" });
  const target = safe(root, sub);
  if (!target) return res.status(400).json({ error: "path outside workspace" });

  let st;
  try {
    st = await stat(target);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }
  if (st.isDirectory()) return res.status(400).json({ error: "download supports files only" });

  const name = basename(target);
  // ASCII fallback + RFC 5987 UTF-8 filename* so non-English names download intact.
  const ascii = name.replace(/[^\x20-\x7E]/g, "_");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", st.size);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  createReadStream(target).pipe(res);
});

// PUT /api/files { cwd, path, content } -> write file contents (confined under cwd)
router.put("/files", async (req, res) => {
  const root = confinedCwd(req.body?.cwd);
  if (!root) return res.status(400).json({ error: "workspace outside WORKSPACE_ROOT" });
  const sub = req.body?.path ? String(req.body.path) : "";
  if (!sub) return res.status(400).json({ error: "path required" });
  const target = safe(root, sub);
  if (!target) return res.status(400).json({ error: "path outside workspace" });

  // Refuse to overwrite a directory.
  try {
    const st = await stat(target);
    if (st.isDirectory()) return res.status(400).json({ error: "path is a directory" });
  } catch {
    // not yet present — fine, we'll create it (parent must already exist though)
  }

  try {
    await mkdirp(dirname(target));
    await writeFile(target, String(req.body?.content ?? ""), "utf8");
    res.json({ ok: true, path: sub });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/files?cwd=<abs>&path=<rel> -> remove a file or directory (recursively
// for directories) confined under cwd via safe(). Refuses the workspace root
// itself (empty path) so the whole workspace can't be wiped from the file tree.
router.delete("/files", async (req, res) => {
  const root = confinedCwd(req.query.cwd);
  if (!root) return res.status(400).json({ error: "workspace outside WORKSPACE_ROOT" });
  const sub = req.query.path ? String(req.query.path) : "";
  if (!sub) return res.status(400).json({ error: "path required" });
  const target = safe(root, sub);
  if (!target) return res.status(400).json({ error: "path outside workspace" });

  try {
    // Refuse to delete the cwd itself — only its contents should be removable
    // from the tree, never the workspace root directory.
    if (target === root) return res.status(400).json({ error: "cannot delete workspace root" });
    await rm(target, { recursive: true, force: false });
    res.json({ ok: true, path: sub });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/workspaces -> list of dirs under WORKSPACE_ROOT (per-session working dirs)
router.get("/workspaces", async (_req, res) => {
  try {
    const entries = await readdir(config.workspaceRoot, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .sort();
    res.json({ root: config.workspaceRoot, dirs });
  } catch (e) {
    res.json({ root: config.workspaceRoot, dirs: [] });
  }
});

// POST /api/workspaces { name } -> create a working dir
router.post("/workspaces", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name || /[\\/]/.test(name) || name === "." || name === "..")
    return res.status(400).json({ error: "invalid name" });
  try {
    await mkdirp(join(config.workspaceRoot, name));
    res.json({ path: join(config.workspaceRoot, name) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/workspaces?name=<name> -> remove an EMPTY, unused working dir.
// Refuses if the folder has any entries or if any session still uses it as
// its cwd (deleting would orphan that session's working directory).
router.delete("/workspaces", async (req, res) => {
  const name = String(req.query.name || req.body?.name || "").trim();
  if (!name || /[\\/]/.test(name) || name === "." || name === "..")
    return res.status(400).json({ error: "invalid name" });
  const target = join(config.workspaceRoot, name);
  const rel = relative(config.workspaceRoot, target);
  if (rel.startsWith("..") || rel.includes(`..${sep}`))
    return res.status(400).json({ error: "path outside workspace" });

  let entries;
  try {
    entries = await readdir(target);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }
  if (entries.length > 0) return res.status(400).json({ error: "workspace not empty" });
  if (SessionManager.list().some((s) => s.cwd === target))
    return res.status(400).json({ error: "workspace has sessions" });

  try {
    await rmdir(target);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;