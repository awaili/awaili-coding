// Regression net for util.js transcriptEngine() — the check that decides
// whether the claude CLI may be pointed at a session's transcript.
//
// Why it matters: all three engines write to the same JSONL file in claude's
// record shape, but `claude --resume <id>` only knows conversations the CLI
// wrote itself (its records carry `sessionId`). Pointed at a codex/grok
// adapter transcript it exits with "No conversation found with session ID",
// and `--session-id <id>` is refused once the file exists — so misclassifying
// a transcript here makes a chat unopenable. That is exactly the failure that
// hit a live codex chat whose model was switched to a gateway model.
//
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir;
let transcriptEngine;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "coding-ui-engine-"));
  ({ transcriptEngine } = await import("../server/util.js"));
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

const line = (o) => JSON.stringify(o) + "\n";

// A claude-CLI record: every one carries sessionId/cwd/version/parentUuid.
const claudeRec = (id, text) =>
  line({
    parentUuid: null,
    isSidechain: false,
    userType: "external",
    cwd: "/data/coding-dev-ui/workspace",
    sessionId: id,
    version: "2.1.268",
    type: "assistant",
    uuid: "u-" + text,
    timestamp: new Date().toISOString(),
    message: { id: "msg_" + text, role: "assistant", model: "claude-opus-5", content: [{ type: "text", text }] },
  });

// What codex.js / grok.js write: claude-SHAPED, but only {type, uuid, message}.
const adapterRec = (text) =>
  line({ type: "assistant", uuid: "u-" + text, message: { id: "item_0", role: "assistant", content: [{ type: "text", text }] } });

async function fixture(name, body) {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
}

test("claude-CLI transcripts are recognized as resumable", async () => {
  const p = await fixture("claude.jsonl", claudeRec("11111111-2222-3333-4444-555555555555", "hi"));
  assert.equal(transcriptEngine(p), "claude");
});

test("a codex transcript is identified by its codex_thread sidecar", async () => {
  const p = await fixture(
    "codex.jsonl",
    line({ type: "user", uuid: "u0", message: { role: "user", content: [{ type: "text", text: "make an image" }] } }) +
      line({ type: "codex_thread", thread_id: "thread_abc" }) +
      adapterRec("on it"),
  );
  assert.equal(transcriptEngine(p), "codex");
});

test("a grok transcript is identified by its grok_session sidecar", async () => {
  const p = await fixture("grok.jsonl", adapterRec("hello") + line({ type: "grok_session", session_id: "s-1" }));
  assert.equal(transcriptEngine(p), "grok");
});

test("a usage sidecar also identifies the engine", async () => {
  const p = await fixture(
    "usage.jsonl",
    adapterRec("hello") +
      line({ type: "usage", uuid: "u1", engine: "grok", model: "grok-4.7", usage: { input_tokens: 10, output_tokens: 1 } }),
  );
  assert.equal(transcriptEngine(p), "grok");
});

test("a claude marker wins over an appended adapter sidecar", async () => {
  // The reverse switch (claude chat → codex model) appends codex records to a
  // claude-written transcript. That file is still claude-resumable.
  const p = await fixture(
    "mixed.jsonl",
    claudeRec("99999999-8888-7777-6666-555555555555", "first") + line({ type: "codex_thread", thread_id: "t2" }) + adapterRec("later"),
  );
  assert.equal(transcriptEngine(p), "claude");
});

test("missing, empty, unmarked and corrupt files report null (treated as resumable)", async () => {
  assert.equal(transcriptEngine(join(dir, "nope.jsonl")), null);
  assert.equal(transcriptEngine(null), null);
  assert.equal(transcriptEngine(await fixture("empty.jsonl", "")), null);
  assert.equal(transcriptEngine(await fixture("plain.jsonl", adapterRec("no marker yet"))), null);
  assert.equal(transcriptEngine(await fixture("junk.jsonl", "not json\n{\n")), null);
});

test("the marker is found past a huge first record", async () => {
  // A pasted screenshot makes record 1 megabytes long; the sniff must not stop
  // at the read cap before reaching the sidecar.
  const big = line({ type: "user", uuid: "u0", message: { role: "user", content: [{ type: "text", text: "x".repeat(300 * 1024) }] } });
  const p = await fixture("big.jsonl", big + line({ type: "codex_thread", thread_id: "t3" }));
  assert.equal(transcriptEngine(p), null, "beyond the sniff window the engine is simply unknown, never misreported");
});
