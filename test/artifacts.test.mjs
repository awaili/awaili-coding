// Regression net for server/artifacts.js — the transcript-derived session
// artifact index (which workspace files a chat's Edit/Write/MultiEdit/
// NotebookEdit calls touched) and its one-click zip.
//
// sessionLogPath() resolves ~/.claude/projects/<sanitized cwd>/<id>.jsonl via
// os.homedir() AT CALL TIME and artifactsZip confines cwd under
// config.workspaceRoot AT CALL TIME, so pointing HOME and WORKSPACE_ROOT at
// temp dirs in a hook (after the ESM imports have already run) keeps both the
// real ~/.claude and the real workspace untouched.
//
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

let home;
let wsRoot;
let artifacts;
let util;
let cwd;
let sessionId;
let logPath;

before(async () => {
  home = await mkdtemp(join(tmpdir(), "coding-ui-home-"));
  wsRoot = await mkdtemp(join(tmpdir(), "coding-ui-ws-"));
  process.env.HOME = home;
  process.env.WORKSPACE_ROOT = wsRoot;
  artifacts = await import("../server/artifacts.js");
  util = await import("../server/util.js");
  cwd = join(wsRoot, "demo");
  sessionId = "aaaaaaaa-1111-2222-3333-444444444444";
  logPath = util.sessionLogPath(cwd, sessionId);
  await mkdir(join(logPath, ".."), { recursive: true });
});

after(async () => {
  if (home) await rm(home, { recursive: true, force: true });
  if (wsRoot) await rm(wsRoot, { recursive: true, force: true });
});

const rec = (o) => JSON.stringify(o) + "\n";
const toolUse = (id, name, input, timestamp) =>
  rec({
    type: "assistant",
    uuid: "a-" + id,
    timestamp: timestamp || "2026-11-17T10:00:00.000Z",
    message: { id: "m-" + id, content: [{ type: "tool_use", id: "tu_" + id, name, input }] },
  });

async function writeLog(...lines) {
  await writeFile(logPath, lines.join(""));
}

test("file-mutating tool calls are aggregated per file, newest first", async () => {
  await writeLog(
    toolUse("1", "Read", { file_path: join(cwd, "read-only.txt") }, "2026-11-17T09:00:00.000Z"),
    toolUse("2", "Write", { file_path: join(cwd, "a.txt"), content: "x" }, "2026-11-17T09:10:00.000Z"),
    toolUse("3", "Edit", { file_path: join(cwd, "a.txt"), old_string: "x", new_string: "y" }, "2026-11-17T09:20:00.000Z"),
    toolUse("4", "MultiEdit", { file_path: join(cwd, "b/c.txt"), edits: [] }, "2026-11-17T09:30:00.000Z"),
    // Sidechain (subagent) records are private scratch, not user-visible edits.
    rec({
      type: "assistant",
      isSidechain: true,
      uuid: "a-side",
      timestamp: "2026-11-17T09:40:00.000Z",
      message: { id: "m-side", content: [{ type: "tool_use", id: "tu_side", name: "Write", input: { file_path: join(cwd, "side.txt") } }] },
    }),
  );
  const items = await artifacts.sessionArtifacts(cwd, sessionId);
  assert.equal(items.length, 2);
  // Newest lastAt first.
  assert.equal(items[0].rel, "b/c.txt");
  assert.equal(items[1].rel, "a.txt");
  // Per-file aggregation: ops counted per tool, count summed.
  assert.deepEqual(items[1].ops, { Write: 1, Edit: 1 });
  assert.equal(items[1].count, 2);
  assert.equal(items[1].firstAt, "2026-11-17T09:10:00.000Z");
  assert.equal(items[1].lastAt, "2026-11-17T09:20:00.000Z");
  // Read never appears (not file-mutating), sidechain is skipped.
  assert.ok(!items.some((i) => i.path.includes("read-only") || i.path.includes("side.txt")));
});

test("a path outside the session cwd is listed but not workspace-relative", async () => {
  await writeLog(toolUse("1", "Write", { file_path: "/etc/hostname", content: "x" }));
  const items = await artifacts.sessionArtifacts(cwd, sessionId);
  assert.equal(items.length, 1);
  assert.equal(items[0].path, "/etc/hostname");
  assert.equal(items[0].rel, null);
});

test("an unchanged transcript is served from the memo cache", async () => {
  await writeLog(toolUse("1", "Write", { file_path: join(cwd, "a.txt") }));
  const first = await artifacts.sessionArtifacts(cwd, sessionId);
  const second = await artifacts.sessionArtifacts(cwd, sessionId);
  // Same array instance — no rescan happened.
  assert.equal(first, second);
});

test("a missing or empty transcript yields an empty index, not a throw", async () => {
  assert.deepEqual(await artifacts.sessionArtifacts(cwd, "eeeeeeee-0000-0000-0000-000000000000"), []);
});

test("artifactsZip bundles still-existing files under cwd by rel path", async () => {
  await mkdir(join(cwd, "b"), { recursive: true });
  await writeFile(join(cwd, "a.txt"), "hello a");
  await writeFile(join(cwd, "b", "c.txt"), "hello c");
  await writeLog(
    toolUse("1", "Write", { file_path: join(cwd, "a.txt") }, "2026-11-17T09:10:00.000Z"),
    toolUse("2", "MultiEdit", { file_path: join(cwd, "b/c.txt") }, "2026-11-17T09:30:00.000Z"),
    // Deleted since the transcript recorded it — excluded from the zip.
    toolUse("3", "Write", { file_path: join(cwd, "gone.txt") }, "2026-11-17T09:40:00.000Z"),
    // Outside the workspace — listed by the index but never downloadable.
    toolUse("4", "Write", { file_path: "/etc/hostname" }, "2026-11-17T09:50:00.000Z"),
  );
  const z = await artifacts.artifactsZip(cwd, sessionId);
  assert.ok(z, "expected a zip");
  assert.equal(z.files, 2);
  assert.match(z.name, /^artifacts-aaaaaaaa\.zip$/);
  // Local-file zip magic.
  assert.equal(z.buffer.subarray(0, 2).toString("latin1"), "PK");
  // The entries are laid out by rel path (ask the system unzip rather than
  // pulling a zip library into the tests).
  const tmpZip = join(tmpdir(), `artifacts-test-${Date.now()}.zip`);
  await writeFile(tmpZip, z.buffer);
  try {
    const { stdout } = await execFileP("unzip", ["-Z1", tmpZip], { maxBuffer: 1 << 20 });
    const names = stdout.split("\n").filter(Boolean).sort();
    assert.deepEqual(names, ["a.txt", "b/", "b/c.txt"]);
  } finally {
    await rm(tmpZip, { force: true });
  }
  // A session with nothing zippable returns null rather than an empty zip.
  const none = await artifacts.artifactsZip(cwd, "eeeeeeee-0000-0000-0000-000000000000");
  assert.equal(none, null);
});
