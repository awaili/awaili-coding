import { Router, raw as rawBody } from "express";
import { readdir, readFile, writeFile, stat, rm, mkdtemp, copyFile, rename } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { confineCwd, safe, mkdirp } from "./util.js";

const execFileP = promisify(execFile);

const router = Router();

// Skill directory names become /skill-name commands and are joined into
// filesystem paths, so allow only a safe charset with no slashes/leading dot.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// Remote skill sources. We browse via skillhub (a registry returning GitHub
// coordinates + a security score) and install by cloning the skill's files
// directly from github.com over git. We never fetch a user-supplied URL, so
// there's no SSRF surface. git is used instead of GitHub's REST contents API on
// purpose: api.github.com caps unauthenticated callers at 60 requests/hour per
// IP, and a shared egress address burns through that almost immediately (the
// "github 403" users hit). git clone over https is not subject to that limit.
const SKILLHUB = "https://skills.palebluedot.live";
// Owner/repo are interpolated into the git URL, so a strict charset (no
// slashes) prevents path/URL injection.
const GH_OWNER_RE = /^[A-Za-z0-9._-]{1,100}$/;

// Bounds for a remote import — defend against runaway recursion, zip-slip via
// crafted filenames, and giant/binary files masquerading as skill content.
const MAX_DEPTH = 12;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Hard cap on an uploaded zip's encoded size (the extracted tree is still
// bounded by MAX_TOTAL_BYTES/MAX_FILES/MAX_DEPTH via collectFiles).
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;

// Forwarded skillhub query params (whitelist — anything else is rejected
// upstream, and we don't want to pass arbitrary keys through).
const REMOTE_PARAMS = ["q", "limit", "page", "sort", "category", "format", "minStars", "platform", "verified"];

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
    // Scaffold a self-documenting skill that mirrors the Guide tab: SKILL.md
    // (short entrypoint) plus reference.md (detail, read on demand) and
    // examples.md (trigger calibration). Built as arrays of plain strings so the
    // backticks / ${CLAUDE_SKILL_DIR} placeholders stay literal (no template-
    // literal escaping); the only substitution is the skill directory name. The
    // frontmatter is kept compact (no interior blank lines) so it always parses.
    const skillMd = [
      "---",
      "name: " + name,
      "# description (recommended) — Claude matches the request against this to decide",
      "# whether to load the skill. Put the key use case first; the combined description",
      "# + when_to_use is truncated at 1,536 chars. Use verbs + nouns and trigger phrases.",
      'description: "One sentence: what this skill does. Use when the user asks to ... / wants to ... / mentions ..."',
      "# when_to_use (optional) — extra trigger phrases appended to the description",
      "# (counts toward the 1,536-char cap).",
      '# when_to_use: "Also use when ..."',
      "# allowed-tools (optional) — tools Claude may use WITHOUT per-use approval while",
      "# this skill is active. Space/comma list or YAML list. Does not restrict the pool.",
      "# allowed-tools: Read Grep Edit Bash(python3 *)",
      "# disallowed-tools (optional) — tools removed from the pool while active; clears",
      "# on your next message.",
      "# disallowed-tools: AskUserQuestion",
      "# disable-model-invocation: true   # only YOU run /name; Claude will not auto-load (deploy/commit)",
      "# user-invocable: false            # hidden from the / menu; only Claude invokes (background knowledge)",
      '# argument-hint: "[target]"         # autocomplete hint',
      "# arguments: target format          # named positional args -> $target, $format",
      "# model: inherit                   # model override while active (or a specific model)",
      "# effort: high                     # low|medium|high|xhigh|max",
      "# context: fork                    # run in an isolated subagent; pair with agent: Explore",
      '# paths: "**/*.py"                 # only auto-activate when working with matching files',
      "---",
      "",
      "# " + name,
      "",
      "> Keep SKILL.md under ~500 lines. State WHAT to do, not how or why. Move detail",
      "> into the supporting files below — Claude reads them only when needed",
      "> (progressive disclosure). Every line here stays in context for the whole",
      "> session once the skill is invoked.",
      "",
      "## When to use",
      "",
      '- [trigger phrase 1 — e.g. "merge these two PDFs"]',
      "- [trigger phrase 2]",
      "- [trigger phrase 3]",
      "",
      "## Instructions",
      "",
      "[The core procedure, in short numbered steps. This is what Claude follows.]",
      "",
      "1. [step]",
      "2. [step]",
      "3. [step]",
      "",
      "## Resources",
      "",
      "- `reference.md` — detailed how-to, commands, code patterns, edge cases.",
      "- `examples.md` — example requests that should (and should not) trigger this skill.",
      "- `scripts/` — bundled scripts; run with `${CLAUDE_SKILL_DIR}/scripts/<script>`.",
      "",
    ].join("\n") + "\n";
    const referenceMd = [
      "# " + name + " — reference",
      "",
      "> Claude reads this file on demand when it needs the detail. SKILL.md stays short",
      "> and points here. Add the step-by-step depth, commands, code patterns, and edge",
      "> cases below. If this grows large, split it into more files and link them from",
      "> SKILL.md.",
      "",
      "## Overview",
      "",
      "[What this skill does, in depth: the problem it solves, the approach, key concepts.]",
      "",
      "## Detailed steps",
      "",
      "### [Step area 1]",
      "",
      "[Commands / code / procedure for this area.]",
      "",
      "### [Step area 2]",
      "",
      "[...]",
      "",
      "## Code patterns / API",
      "",
      "[Reusable snippets and the API surface the skill relies on.]",
      "",
      "```bash",
      "# example command",
      "[command]",
      "```",
      "",
      "## Edge cases and gotchas",
      "",
      "- [case 1 — what to watch for]",
      "- [case 2]",
      "",
      "## Scripts",
      "",
      "If the skill bundles scripts in `scripts/`, reference them from SKILL.md with",
      "`${CLAUDE_SKILL_DIR}/scripts/<script>` so they resolve regardless of the current",
      "working directory.",
      "",
    ].join("\n") + "\n";
    const examplesMd = [
      "# " + name + " — examples",
      "",
      "> Use these to test that the `description` in SKILL.md matches real requests. A skill",
      "> triggering only means Claude found it — check the OUTPUT too. Test in a FRESH",
      "> session (leftover authoring context masks gaps).",
      "",
      "## Should trigger",
      "",
      "Prompts that SHOULD activate this skill:",
      "",
      '- "[example request 1]"',
      '- "[example request 2]"',
      '- "[example request 3]"',
      "",
      "## Should NOT trigger",
      "",
      "Prompts that look similar but should NOT fire this skill (use these to sharpen the",
      "description or add when_to_use):",
      "",
      '- "[lookalike request that belongs to a different skill]"',
      "",
      "## Expected behavior",
      "",
      "For each should-trigger example, what good output looks like:",
      "",
      '- **"[request 1]"** -> [expected result]',
      '- **"[request 2]"** -> [expected result]',
      "",
    ].join("\n") + "\n";
    const files = { "SKILL.md": skillMd, "reference.md": referenceMd, "examples.md": examplesMd };
    for (const [rel, body] of Object.entries(files)) {
      const resolved = safe(target, rel);
      if (!resolved) throw new Error(`path escapes skill dir: ${rel}`);
      await mkdirp(dirname(resolved));
      await writeFile(resolved, body, "utf8");
    }
    res.json({ ok: true, name, files: Object.keys(files) });
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

// POST /api/skills/folder { scope, cwd, skill, path } -> create an empty
// folder inside the skill dir (mkdirp parents). Lets the editor organize a
// skill's supporting files into subfolders without first creating a file.
router.post("/skills/folder", async (req, res) => {
  const dir = skillsDir(req.body?.scope, req.body?.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  const target = skillDir(dir, req.body?.skill);
  if (!target) return res.status(400).json({ error: "invalid skill name" });
  const sub = req.body?.path ? String(req.body.path).replace(/^\/+|\/+$/g, "") : "";
  if (!sub) return res.status(400).json({ error: "path required" });
  const resolved = safe(target, sub);
  if (!resolved || resolved === target) return res.status(400).json({ error: "path outside skill" });
  try {
    const st = await stat(resolved);
    if (st.isDirectory()) return res.status(400).json({ error: "folder already exists" });
    return res.status(400).json({ error: "a file with that name already exists" });
  } catch {
    // not present — good, we can create it
  }
  try {
    await mkdirp(resolved);
    res.json({ ok: true, path: sub });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/skills/move { scope, cwd, skill, from, to } -> rename or move a
// file/folder inside the skill dir. Both paths confined via safe(); refuses to
// move the skill dir itself and blocks moving a folder into its own descendant.
router.post("/skills/move", async (req, res) => {
  const dir = skillsDir(req.body?.scope, req.body?.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  const target = skillDir(dir, req.body?.skill);
  if (!target) return res.status(400).json({ error: "invalid skill name" });
  const from = req.body?.from ? String(req.body.from).replace(/^\/+|\/+$/g, "") : "";
  const to = req.body?.to ? String(req.body.to).replace(/^\/+|\/+$/g, "") : "";
  if (!from || !to) return res.status(400).json({ error: "from and to required" });
  if (from === to) return res.status(400).json({ error: "source and destination are the same" });
  const src = safe(target, from);
  const dst = safe(target, to);
  if (!src || src === target) return res.status(400).json({ error: "source outside skill" });
  if (!dst || dst === target) return res.status(400).json({ error: "destination outside skill" });
  // Block moving a folder into its own descendant (e.g. a/ -> a/b/c).
  if (to.startsWith(from + "/")) return res.status(400).json({ error: "cannot move a folder into itself" });
  try {
    const st = await stat(dst);
    return res.status(400).json({ error: "destination already exists" });
  } catch {
    // dst absent — fine
  }
  try {
    await mkdirp(join(dst, ".."));
    await rename(src, dst);
    res.json({ ok: true, from, to });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run a git command with a hard timeout. Throws an Error carrying the trimmed
// stderr (git writes its human-readable failures there) so callers can map it.
// GIT_TERMINAL_PROMPT=0 makes a 404 (non-existent/private repo) fail fast with
// a credential error instead of hanging on an interactive prompt.
async function runGit(args, cwd, timeoutMs) {
  try {
    const { stderr } = await execFileP("git", args, {
      cwd: cwd || undefined,
      timeout: timeoutMs,
      maxBuffer: 1 << 20,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return (stderr || "").toString().trim();
  } catch (e) {
    const raw = (e.stderr ? e.stderr.toString() : "") + " " + (e.message || "");
    // Drop git's "Cloning into '...'" progress lines and the promisify wrapper.
    const clean = raw
      .split("\n")
      .filter((l) => !/^Cloning into/.test(l) && !/Command failed/.test(l) && !/exited with code/.test(l))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    throw new Error(clean || "git error");
  }
}

// Clone only the skill's files from GitHub into `tmp` (a freshly mkdtemp'd
// dir). Uses a partial clone (--filter=blob:none) plus a sparse cone checkout
// so only `basePath`'s blobs are fetched (≈300 KiB .git for a typical skill, not
// the whole repo). Falls back to a plain depth-1 clone if this git is too old
// for cone-mode sparse-checkout. Returns the source dir to copy from: basePath
// inside the clone, or the clone root when basePath is empty.
async function gitCloneSkill(owner, repo, branch, basePath, tmp) {
  const url = `https://github.com/${owner}/${repo}.git`;
  await runGit(
    ["clone", "--depth", "1", "--filter=blob:none", "--no-checkout", "--branch", branch, url, tmp],
    null, 120000,
  );
  if (basePath) {
    try {
      await runGit(["sparse-checkout", "init", "--cone"], tmp, 15000);
      await runGit(["sparse-checkout", "set", basePath], tmp, 15000);
    } catch {
      // Older git without cone-mode sparse — re-clone the whole repo (depth 1).
      await rm(tmp, { recursive: true, force: true });
      await runGit(["clone", "--depth", "1", "--branch", branch, url, tmp], null, 120000);
      return join(tmp, basePath);
    }
  }
  await runGit(["checkout", branch], tmp, 60000);
  return basePath ? join(tmp, basePath) : tmp;
}

// Walk a local directory (the cloned skill path) into a flat list of
// { rel, src } where rel is relative to absRoot and src is the absolute source
// path. Bounded by depth/count/size; skips `.git`. Rejects unsafe rels.
async function collectFiles(absRoot, rel, out, state, depth) {
  if (depth > MAX_DEPTH) throw new Error(`skill directory too deep (limit ${MAX_DEPTH} levels)`);
  let entries;
  try {
    entries = await readdir(absRoot, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot read skill path: ${e.message}`);
  }
  for (const e of entries) {
    if (e.name === ".git") continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (childRel.includes("..") || childRel.includes("\\") || childRel.startsWith("/"))
      throw new Error(`refusing unsafe path: ${childRel}`);
    if (e.isDirectory()) {
      await collectFiles(join(absRoot, e.name), childRel, out, state, depth + 1);
    } else if (e.isFile()) {
      if (out.length >= MAX_FILES) throw new Error(`too many files in skill directory (limit ${MAX_FILES})`);
      let st;
      try { st = await stat(join(absRoot, e.name)); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) { state.skipped += 1; continue; }
      if (state.total + st.size > MAX_TOTAL_BYTES)
        throw new Error(`skill directory too large (limit ${Math.round(MAX_TOTAL_BYTES / 1048576)} MB)`);
      state.total += st.size;
      out.push({ rel: childRel, src: join(absRoot, e.name) });
    }
  }
}

// Locate SKILL.md anywhere in a collected file list and treat its containing
// directory as the skill root, returning the files re-rooted under it. Handles
// archives where the skill is nested at any depth — e.g. a GitHub "download
// folder" zip like `repo-main/skills/pdf/SKILL.md`, a single wrapper folder
// `my-skill/SKILL.md`, or a flat `SKILL.md` at the root. Files outside the
// chosen skill root are dropped (returned in `dropped`) so unrelated clutter
// (a top-level README, license, CI config) isn't copied into the skill.
//
// When several SKILL.md exist (e.g. the zip also bundles example sub-skills),
// the shallowest one wins; ties are broken toward the subtree holding the most
// files (the real skill, not a tiny nested example). Matching is case-sensitive
// `SKILL.md` first, falling back to a case-insensitive `skill.md`.
function reRootToSkillMd(collected) {
  const baseName = (rel) => rel.split("/").pop();
  let candidates = collected.filter((f) => baseName(f.rel) === "SKILL.md");
  if (candidates.length === 0)
    candidates = collected.filter((f) => baseName(f.rel).toLowerCase() === "skill.md");
  if (candidates.length === 0)
    throw new Error("no SKILL.md found anywhere in the archive — not a valid skill");

  let chosen;
  if (candidates.length === 1) {
    chosen = candidates[0];
  } else {
    const depth = (f) => f.rel.split("/").length;
    const minD = Math.min(...candidates.map(depth));
    const shallow = candidates.filter((f) => depth(f) === minD);
    if (shallow.length === 1) {
      chosen = shallow[0];
    } else {
      chosen = shallow
        .map((f) => {
          const root = f.rel.slice(0, f.rel.length - baseName(f.rel).length).replace(/\/+$/, "");
          const pref = root ? root + "/" : "";
          const cnt = collected.filter((c) => pref !== "" && c.rel.startsWith(pref)).length;
          return { f, cnt };
        })
        .sort((a, b) => b.cnt - a.cnt)[0].f;
    }
  }

  const rootRel = chosen.rel.slice(0, chosen.rel.length - baseName(chosen.rel).length).replace(/\/+$/, "");
  const prefix = rootRel ? rootRel + "/" : "";
  const stripped = [];
  const dropped = [];
  for (const f of collected) {
    if (prefix === "" || f.rel.startsWith(prefix)) {
      const rel = prefix === "" ? f.rel : f.rel.slice(prefix.length);
      if (rel.length > 0) stripped.push({ rel, src: f.src });
    } else {
      dropped.push(f.rel);
    }
  }
  if (!stripped.some((f) => f.rel === "SKILL.md"))
    throw new Error("no SKILL.md found at the skill root — not a valid skill");
  return { stripped, dropped, rootRel };
}

// GET /api/skills/remote/search?q=&limit=&page=&sort=&... -> { skills:[...], page }
// Proxy to the skillhub registry. We normalize to a slim shape and cap limit.
router.get("/skills/remote/search", async (req, res) => {
  const u = new URL(SKILLHUB + "/api/skills");
  for (const k of REMOTE_PARAMS) {
    if (req.query[k] != null && req.query[k] !== "") u.searchParams.set(k, String(req.query[k]));
  }
  let limit = Number.parseInt(u.searchParams.get("limit") || "30", 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 30;
  if (limit > 60) limit = 60;
  u.searchParams.set("limit", String(limit));
  try {
    const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
    const text = await r.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: `skillhub returned non-JSON (HTTP ${r.status})` });
    }
    if (!r.ok) return res.status(502).json({ error: j.error || `skillhub HTTP ${r.status}` });
    const skills = (j.skills || []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      owner: s.githubOwner,
      repo: s.githubRepo,
      path: s.skillPath || "",
      branch: s.branch || "main",
      version: s.version || null,
      license: s.license || null,
      stars: s.githubStars || 0,
      downloads: s.downloadCount || 0,
      security: s.securityStatus,
      securityScore: typeof s.securityScore === "number" ? s.securityScore : null,
      verified: !!s.isVerified,
    }));
    res.json({ skills, page: Number.parseInt(req.query.page, 10) || 1 });
  } catch (e) {
    res.status(502).json({ error: `skillhub unreachable: ${e.message}` });
  }
});

// POST /api/skills/import { scope, cwd, name, owner, repo, path, branch, force? }
//   -> { ok, name, files:[...], skipped }
// Clones a remote GitHub skill's files into a confined skill directory. Uses git
// (not the GitHub REST API) to avoid the 60-req/hour unauthenticated rate limit
// that a shared egress IP exhausts. Requires a SKILL.md at the base path;
// refuses to overwrite an existing skill unless `force` is set. Every file is
// confined under the skill dir via safe().
router.post("/skills/import", async (req, res) => {
  const dir = skillsDir(req.body?.scope, req.body?.cwd);
  if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
  const name = String(req.body?.name || "");
  const target = skillDir(dir, name);
  if (!target) return res.status(400).json({ error: "invalid skill name" });
  const owner = String(req.body?.owner || "");
  const repo = String(req.body?.repo || "");
  if (!GH_OWNER_RE.test(owner) || !GH_OWNER_RE.test(repo))
    return res.status(400).json({ error: "invalid owner or repo" });
  const path = String(req.body?.path || "").replace(/^\/+|\/+$/g, "");
  const branch = String(req.body?.branch || "main") || "main";
  const force = !!req.body?.force;

  // Refuse to clobber an existing skill unless force.
  try {
    await stat(target);
    if (!force) return res.status(409).json({ error: "skill already exists (force to overwrite)" });
    await rm(target, { recursive: true, force: true });
  } catch {
    // not present — fine
  }

  // Clone into a temp dir, then walk the skill path into a flat file list.
  let tmp;
  const collected = [];
  const state = { skipped: 0, total: 0 };
  try {
    tmp = await mkdtemp(join(tmpdir(), "skill-import-"));
    let srcRoot;
    try {
      srcRoot = await gitCloneSkill(owner, repo, branch, path, tmp);
    } catch (e) {
      const m = (e.message || "").trim();
      if (e.code === "ENOENT" || /spawn git ENOENT/i.test(m))
        throw new Error("git is not installed on the server (required to install skills from GitHub)");
      // Clone-phase failures: nonexistent/private repo (credential prompt) or a
      // bad branch. GitHub answers both as a 404-ish "not found".
      if (/could not read Username|not found|Repository not found|Remote branch/i.test(m))
        throw new Error("GitHub repository or branch not found");
      throw new Error(m || "failed to clone skill from GitHub");
    }
    try {
      await stat(srcRoot);
    } catch {
      throw new Error("skill path not found on GitHub (no such folder at the given path in this repo)");
    }
    await collectFiles(srcRoot, "", collected, state, 0);
  } catch (e) {
    if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
    return res.status(400).json({ error: (e.message || "").trim() || "failed to fetch skill from GitHub" });
  }

  if (!collected.some((f) => f.rel === "SKILL.md")) {
    if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
    return res.status(400).json({ error: "no SKILL.md found at the given GitHub path — not a valid skill" });
  }

  const written = [];
  try {
    await mkdirp(target); // so safe() can realpath the skill root
    for (const f of collected) {
      const resolved = safe(target, f.rel);
      if (!resolved) throw new Error(`path escapes skill dir: ${f.rel}`);
      await mkdirp(dirname(resolved));
      await copyFile(f.src, resolved); // binary-safe, streamed
      written.push(f.rel);
    }
  } catch (e) {
    if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
    try { await rm(target, { recursive: true, force: true }); } catch {}
    return res.status(500).json({ error: e.message, written });
  }
  if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
  res.json({ ok: true, name, files: written, skipped: state.skipped });
});

// POST /api/skills/upload?scope=&cwd=&name=&force=  body: raw .zip bytes
//   (Content-Type: application/zip) -> { ok, name, files:[...], skipped }
// Extracts an uploaded zip into a confined skill directory. Reuses the same
// collectFiles() guards (depth/count/size, zip-slip rel rejection) and the same
// safe()-confined write loop as the GitHub import. SKILL.md is located anywhere
// in the archive (at any depth) and its containing folder becomes the skill
// root, so nested layouts like `repo-main/skills/pdf/SKILL.md` land correctly
// without the user having to pre-flatten the zip.
router.post(
  "/skills/upload",
  rawBody({ type: ["application/zip", "application/x-zip-compressed", "application/octet-stream"], limit: `${MAX_UPLOAD_BYTES}` }),
  async (req, res) => {
    const dir = skillsDir(req.query.scope, req.query.cwd);
    if (!dir) return res.status(400).json({ error: "invalid scope or workspace outside WORKSPACE_ROOT" });
    const name = String(req.query.name || "");
    const target = skillDir(dir, name);
    if (!target) return res.status(400).json({ error: "invalid skill name" });
    const force = String(req.query.force || "") === "1" || req.query.force === "true";
    const buf = Buffer.isBuffer(req.body) ? req.body : null;
    if (!buf || buf.length === 0)
      return res.status(400).json({ error: "no zip body received (send the .zip as the request body with Content-Type: application/zip)" });
    if (buf.length > MAX_UPLOAD_BYTES)
      return res.status(413).json({ error: `zip too large (limit ${Math.round(MAX_UPLOAD_BYTES / 1048576)} MB)` });

    // Refuse to clobber an existing skill unless force.
    try {
      await stat(target);
      if (!force) return res.status(409).json({ error: "skill already exists (force to overwrite)" });
      await rm(target, { recursive: true, force: true });
    } catch {
      // not present — fine
    }

    let tmp;
    const collected = [];
    const state = { skipped: 0, total: 0 };
    try {
      tmp = await mkdtemp(join(tmpdir(), "skill-upload-"));
      const zipPath = join(tmp, "upload.zip");
      await writeFile(zipPath, buf);
      const extractDir = join(tmp, "extracted");
      try {
        await execFileP("unzip", ["-qq", "-o", zipPath, "-d", extractDir], {
          timeout: 30000,
          maxBuffer: 1 << 20,
        });
      } catch (e) {
        const m = (e.message || "").toString();
        if (/ENOENT|spawn unzip/i.test(m))
          throw new Error("unzip is not installed on the server (required to extract uploaded skills)");
        throw new Error("could not extract the .zip — not a valid zip archive");
      }
      await collectFiles(extractDir, "", collected, state, 0);
    } catch (e) {
      if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
      return res.status(400).json({ error: (e.message || "").trim() || "failed to extract zip" });
    }

    // Find SKILL.md anywhere in the extracted tree and re-root under its folder.
    let stripped;
    try {
      const r = reRootToSkillMd(collected);
      stripped = r.stripped;
      state.skipped += r.dropped.length;
    } catch (e) {
      if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
      return res.status(400).json({ error: (e.message || "").trim() || "no SKILL.md found — not a valid skill" });
    }

    const written = [];
    try {
      await mkdirp(target);
      for (const f of stripped) {
        const resolved = safe(target, f.rel);
        if (!resolved) throw new Error(`path escapes skill dir: ${f.rel}`);
        await mkdirp(dirname(resolved));
        await copyFile(f.src, resolved); // binary-safe
        written.push(f.rel);
      }
    } catch (e) {
      if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
      try { await rm(target, { recursive: true, force: true }); } catch {}
      return res.status(500).json({ error: e.message, written });
    }
    if (tmp) try { await rm(tmp, { recursive: true, force: true }); } catch {}
    res.json({ ok: true, name, files: written, skipped: state.skipped });
  },
);
// The chat backend spawns the real `claude` CLI per session with cwd = the
// selected workspace, so skills are loaded natively (global from
// ~/.claude/skills for every session; workspace from <cwd>/.claude/skills for
// that workspace only). Native AUTO-invocation, though, depends on the model
// emitting a skill-match signal — unreliable for a non-Claude model on a custom
// gateway. To make the conversation actually use a skill, the send path
// (sessions.js) matches the user's message against the skills available to that
// session and prepends the matched skill's body to the message so the model
// follows it regardless. Matching is keyword/trigger-phrase based (no extra
// model calls), conservative (needs a clear winner), and respects
// `disable-model-invocation` (manual-only skills are never auto-injected) and
// slash commands (`/name` is left for the CLI to handle).

// Parse the YAML frontmatter of a SKILL.md into the fields matching needs, plus
// the body (everything after the closing `---`). Single-line values only —
// multi-line frontmatter values are rare for description/when_to_use and we use
// them only for trigger extraction, so first-line is enough.
function fmLine(block, key) {
  const re = new RegExp("^" + key.replace(/-/g, "\\-") + ":\\s*(.+?)\\s*$", "m");
  const m = block.match(re);
  return m ? m[1].replace(/^["']|["']$/g, "") : "";
}
function parseSkillMd(raw) {
  const text = String(raw || "");
  let body = text;
  let description = "";
  let whenToUse = "";
  let disableModelInvocation = false;
  let userInvocable = true;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) {
      const block = text.slice(3, end);
      body = text.slice(end + 4).replace(/^\r?\n/, "");
      description = fmLine(block, "description");
      whenToUse = fmLine(block, "when_to_use");
      disableModelInvocation = /^\s*true\s*$/i.test(fmLine(block, "disable-model-invocation"));
      userInvocable = !/^\s*false\s*$/i.test(fmLine(block, "user-invocable"));
    }
  }
  return { description, whenToUse, disableModelInvocation, userInvocable, body };
}

// Read every skill under `dir` (subdirs containing SKILL.md) into `out`, tagged
// with its scope. Missing dir is a no-op (no skills there yet).
async function loadSkillsIn(dir, scope, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    let raw;
    try {
      raw = await readFile(join(dir, e.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    out.push({ name: e.name, scope, dir: join(dir, e.name), ...parseSkillMd(raw) });
  }
}

// Per-cwd cache of the parsed skill list (global + this workspace). Skills are
// re-read on a short TTL so edits / installs are picked up without a restart,
// while a burst of sends in one turn doesn't re-read the files every message.
const SKILL_CACHE_TTL = 10000;
const skillCache = new Map();

// Skills available to a chat session with the given cwd: GLOBAL skills
// (~/.claude/skills, every workspace) plus THIS WORKSPACE's skills
// (<cwd>/.claude/skills, only when cwd is inside WORKSPACE_ROOT). A workspace
// skill shadows a same-named global one (matches CLI precedence). Each entry:
// { name, scope, dir, description, whenToUse, disableModelInvocation,
//   userInvocable, body }.
export async function availableSkillsForCwd(cwd) {
  const now = Date.now();
  const c = skillCache.get(cwd);
  if (c && now - c.t < SKILL_CACHE_TTL) return c.list;
  const out = [];
  await loadSkillsIn(join(homedir(), ".claude", "skills"), "global", out);
  const wsRoot = confineCwd(cwd);
  if (wsRoot) await loadSkillsIn(join(wsRoot, ".claude", "skills"), "workspace", out);
  // Dedupe by name: a workspace skill overrides a global skill of the same name.
  const byName = new Map();
  for (const s of out) {
    const ex = byName.get(s.name);
    if (!ex || (ex.scope === "global" && s.scope === "workspace")) byName.set(s.name, s);
  }
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  skillCache.set(cwd, { t: now, list });
  return list;
}

// Light suffix stemming so "merge"/"merging"/"merged" and "pdf"/"pdfs" map to
// the same key. Crude but enough for keyword overlap matching.
function stem(w) {
  let s = String(w || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.length <= 3) return s;
  s = s.replace(/(ations|ation|ting|ing|edly|ied|ies|ed|es|ly|ment|ness|s)$/, "");
  s = s.replace(/e$/, "");
  return s;
}

// Generic filler words that appear in almost every description ("use when the
// user wants to…") and carry no signal — exclude them from keyword matching so
// they don't inflate overlap with unrelated messages.
const STOP = new Set(
  ("the a an and or but nor so yet of to in on at by for with from into about as like via " +
    "is are was were be been being do does did done have has had can could will would should " +
    "may might must shall this that these those there here now then than too very just only " +
    "also any all each every some such no not own same more most few both either neither " +
    "i you he she it we they me him her us them my your his its our their what which who whom " +
    "when where why how if then else use using used uses user users want wants wanted ask asks " +
    "asked requesting request requests task tasks help helps need needs make makes making get gets " +
    "skill skills file files anything something everything thing things stuff etc and/or one two " +
    "new old first last next previous other another same different such")
    .split(/\s+/)
    .filter(Boolean),
);

// Significant keyword stems for a skill, drawn from its name, description, and
// when_to_use. Stopwords and very short tokens are dropped; plurals/conjugations
// collapse via stem().
function keywordsFor(skill) {
  const kw = new Set();
  const addText = (val) => {
    if (!val) return;
    for (const raw of String(val).toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3) continue;
      if (STOP.has(raw)) continue;
      const s = stem(raw);
      if (s.length < 2) continue;
      if (STOP.has(s)) continue;
      kw.add(s);
    }
  };
  addText(skill.name);
  addText(skill.description);
  addText(skill.whenToUse);
  return kw;
}

// Pick the single skill whose keywords best overlap the user's text.
// Conservative by design (a false injection derails the answer; a missed one
// just means the user types /name):
//   - never inject for slash commands (let the CLI handle /name)
//   - skip skills with no body or disable-model-invocation: true
//   - score = number of the skill's keyword stems present in the message
//   - require score >= 2 (two significant keywords, e.g. "merge" + "pdf")
//   - on a tie, only inject if the winner is the workspace skill beating a
//     global one (workspace wins by precedence); otherwise ambiguous -> none
export function pickSkill(text, skills) {
  if (typeof text !== "string" || !text.trim() || text.trim().startsWith("/")) return null;
  const userWords = new Set();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw) continue;
    userWords.add(stem(raw));
  }
  const scored = [];
  for (const s of skills) {
    if (s.disableModelInvocation) continue;
    if (!s.body || !s.body.trim()) continue;
    let score = 0;
    for (const k of keywordsFor(s)) if (userWords.has(k)) score += 1;
    if (score > 0) scored.push({ s, score });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.s.scope !== b.s.scope) return a.s.scope === "workspace" ? -1 : 1;
    return b.s.name.length - a.s.name.length;
  });
  const top = scored[0];
  if (top.score < 2) return null;
  if (scored.length > 1 && scored[1].score === top.score) {
    if (!(top.s.scope === "workspace" && scored[1].s.scope === "global")) return null;
  }
  return top.s;
}

export default router;