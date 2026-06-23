import { Router } from "express";
import { readdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { confineCwd, safe, mkdirp } from "./util.js";

const router = Router();

// Skill directory names become /skill-name commands and are joined into
// filesystem paths, so allow only a safe charset with no slashes/leading dot.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Personal/global skills live outside WORKSPACE_ROOT (in ~/.claude/skills), so
// they can't go through /api/files. Workspace skills live under the (confined)
// cwd at <cwd>/.claude/skills. Returns the absolute skills dir or null if the
// workspace cwd escapes WORKSPACE_ROOT.
function skillsDir(scope, cwd) {
  if (scope === "global") return join(homedir(), ".claude", "skills");
  if (scope === "workspace") {
    const root = confineCwd(cwd);
    if (!root) return null;
    return join(root, ".claude", "skills");
  }
  return null;
}

// Resolve a skill directory under a skills root, validating the name. Returns
// the absolute path or null. NAME_RE has no slashes so join() can't escape.
function skillDir(root, name) {
  if (!NAME_RE.test(name || "")) return null;
  return join(root, name);
}

// Best-effort frontmatter description parser. SKILL.md frontmatter is a YAML
// block between `---` markers; we only need the `description` line for the list
// view, so a regex avoids pulling in a YAML dependency.
function parseDescription(text) {
  if (typeof text !== "string" || !text.startsWith("---")) return "";
  const end = text.indexOf("\n---", 3);
  if (end < 0) return "";
  const block = text.slice(3, end);
  const m = block.match(/^description:\s*(.+?)\s*$/m);
  return m ? m[1].replace(/^["']|["']$/g, "") : "";
}

// GET /api/skills?scope=global|workspace&cwd=<abs>
//   -> { dir, skills: [{ name, description }] }
// Lists subdirectories of the skills dir that contain a SKILL.md.
router.get("/skills", async (req, res) => {
  const dir = skillsDir(req.query.scope, req.query.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // Skills dir doesn't exist yet — nothing to list.
    return res.json({ dir, skills: [] });
  }
  const skills = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const md = join(dir, e.name, "SKILL.md");
    let description = "";
    try {
      description = parseDescription(await readFile(md, "utf8"));
    } catch {
      // No SKILL.md — skip this dir (not a valid skill).
      continue;
    }
    skills.push({ name: e.name, description });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ dir, skills });
});

// POST /api/skills { scope, cwd, name } -> create skill dir + templated SKILL.md.
router.post("/skills", async (req, res) => {
  const dir = skillsDir(req.body?.scope, req.body?.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  const name = String(req.body?.name || "");
  const target = skillDir(dir, name);
  if (!target) return res.status(400).json({ error: "invalid skill name" });
  try {
    const st = await stat(target);
    if (st) return res.status(400).json({ error: "skill already exists" });
  } catch {
    // not present — good, we'll create it
  }
  try {
    await mkdirp(target);
    const template =
      `---\n` +
      `name: ${name}\n` +
      `description: When to use this skill\n` +
      `---\n\n` +
      `# ${name}\n\n` +
      `Instructions for the skill go here.\n`;
    await writeFile(join(target, "SKILL.md"), template, "utf8");
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/skills?scope=&cwd=&name= -> remove the whole skill directory.
router.delete("/skills", async (req, res) => {
  const dir = skillsDir(req.query.scope, req.query.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  const name = String(req.query.name || req.body?.name || "");
  const target = skillDir(dir, name);
  if (!target) return res.status(400).json({ error: "invalid skill name" });
  try {
    await rm(target, { recursive: true, force: false });
    res.json({ ok: true, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/skills/file?scope=&cwd=&skill=<name>&path=<rel>
//   -> dir listing ({type:"dir",path,items}) or file contents ({type:"file",path,content}).
// Mirrors /api/files shape so the frontend tree logic is familiar. Confines
// `path` under the skill dir via safe() (symlink-aware).
router.get("/skills/file", async (req, res) => {
  const dir = skillsDir(req.query.scope, req.query.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  const target = skillDir(dir, req.query.skill);
  if (!target) return res.status(400).json({ error: "invalid skill name" });
  const sub = req.query.path ? String(req.query.path) : "";
  const resolved = safe(target, sub);
  if (!resolved) return res.status(400).json({ error: "path outside skill" });

  let st;
  try {
    st = await stat(resolved);
  } catch (e) {
    return res.status(404).json({ error: e.message });
  }
  if (st.isFile()) {
    try {
      const content = await readFile(resolved, "utf8");
      return res.json({ type: "file", path: sub, content });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  try {
    const entries = await readdir(resolved, { withFileTypes: true });
    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({ name: e.name, dir: e.isDirectory(), path: sub ? `${sub}/${e.name}` : e.name }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    res.json({ type: "dir", path: sub, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/skills/file { scope, cwd, skill, path, content } -> write a file
// inside the skill dir (mkdirp parents so supporting files can be nested).
router.put("/skills/file", async (req, res) => {
  const dir = skillsDir(req.body?.scope, req.body?.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  const target = skillDir(dir, req.body?.skill);
  if (!target) return res.status(400).json({ error: "invalid skill name" });
  const sub = req.body?.path ? String(req.body.path) : "";
  if (!sub) return res.status(400).json({ error: "path required" });
  const resolved = safe(target, sub);
  if (!resolved) return res.status(400).json({ error: "path outside skill" });
  try {
    const st = await stat(resolved);
    if (st.isDirectory()) return res.status(400).json({ error: "path is a directory" });
  } catch {
    // not yet present — fine
  }
  try {
    await mkdirp(join(resolved, ".."));
    await writeFile(resolved, String(req.body?.content ?? ""), "utf8");
    res.json({ ok: true, path: sub });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/skills/file?scope=&cwd=&skill=&path=<rel> -> remove a file or
// subdir inside the skill. Requires a non-empty path (deleting the whole skill
// uses DELETE /api/skills) and refuses to delete the skill dir itself.
router.delete("/skills/file", async (req, res) => {
  const dir = skillsDir(req.query.scope, req.query.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  const target = skillDir(dir, req.query.skill);
  if (!target) return res.status(400).json({ error: "invalid skill name" });
  const sub = req.query.path ? String(req.query.path) : "";
  if (!sub) return res.status(400).json({ error: "path required" });
  const resolved = safe(target, sub);
  if (!resolved || resolved === target)
    return res.status(400).json({ error: "path outside skill" });
  try {
    await rm(resolved, { recursive: true, force: false });
    res.json({ ok: true, path: sub });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

export default router;