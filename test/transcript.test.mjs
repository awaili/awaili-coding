// Regression net for server/transcript.js — the streaming transcript reader.
//
// This covers the pagination contract (whose cursor is opaque to the client, so
// a silent change here shows up as missing/duplicated history), the tool_use ↔
// tool_result merge across the window boundary, multi-byte UTF-8 split across
// read chunks, the image byte index, and the incremental append rescan.
//
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
let transcript;
let util;
let cwd;
let sessionId;
let logPath;

// sessionLogPath() resolves ~/.claude/projects/<sanitized cwd>/<id>.jsonl via
// os.homedir() AT CALL TIME, so pointing HOME at a temp dir in a hook (after
// the ESM imports have already run) is enough to keep the real ~/.claude
// untouched.
before(async () => {
  home = await mkdtemp(join(tmpdir(), "coding-ui-test-"));
  process.env.HOME = home;
  transcript = await import("../server/transcript.js");
  util = await import("../server/util.js");
  cwd = "/data/coding-dev-ui/workspace/demo";
  sessionId = "11111111-2222-3333-4444-555555555555";
  logPath = util.sessionLogPath(cwd, sessionId);
  await mkdir(join(logPath, ".."), { recursive: true });
});

after(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

const rec = (o) => JSON.stringify(o) + "\n";
const userText = (t, uuid = "u-" + Math.random().toString(36).slice(2)) =>
  rec({ type: "user", uuid, message: { role: "user", content: [{ type: "text", text: t }] } });
const assistantText = (t, id) =>
  rec({ type: "assistant", uuid: "a-" + id, message: { id, content: [{ type: "text", text: t }] } });

async function writeLog(...lines) {
  await writeFile(logPath, lines.join(""));
}

// --- pagination -----------------------------------------------------------

test("tail page returns the last `limit` messages with a usable cursor", async () => {
  await writeLog(userText("m0"), userText("m1"), userText("m2"), userText("m3"), userText("m4"));
  const page = await transcript.readHistory(cwd, sessionId, { limit: 2 });
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m3", "m4"],
  );
  assert.equal(page.oldestIndex, 3);
  assert.equal(page.hasMore, true);
});

test("older page ends just before the cursor", async () => {
  await writeLog(userText("m0"), userText("m1"), userText("m2"), userText("m3"), userText("m4"));
  const page = await transcript.readHistory(cwd, sessionId, { limit: 2, beforeIndex: 3 });
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m1", "m2"],
  );
  assert.equal(page.oldestIndex, 1);
  assert.equal(page.hasMore, true);
});

test("reaching the start of the transcript clears hasMore", async () => {
  await writeLog(userText("m0"), userText("m1"), userText("m2"));
  const page = await transcript.readHistory(cwd, sessionId, { limit: 5, beforeIndex: 2 });
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m0", "m1"],
  );
  assert.equal(page.oldestIndex, 0);
  assert.equal(page.hasMore, false);
});

test("walking the cursor back covers every message exactly once", async () => {
  const n = 25;
  await writeLog(...Array.from({ length: n }, (_, i) => userText(`m${i}`)));
  const seen = [];
  let page = await transcript.readHistory(cwd, sessionId, { limit: 4 });
  seen.unshift(...page.messages.map((m) => m.text));
  while (page.hasMore) {
    page = await transcript.readHistory(cwd, sessionId, { limit: 4, beforeIndex: page.oldestIndex });
    seen.unshift(...page.messages.map((m) => m.text));
  }
  assert.deepEqual(
    seen,
    Array.from({ length: n }, (_, i) => `m${i}`),
  );
});

test("a cursor past the end behaves like a tail read", async () => {
  await writeLog(userText("m0"), userText("m1"), userText("m2"));
  const page = await transcript.readHistory(cwd, sessionId, { limit: 2, beforeIndex: 999 });
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m1", "m2"],
  );
  assert.equal(page.oldestIndex, 1);
});

test("missing transcript yields an empty page, not a throw", async () => {
  const page = await transcript.readHistory(cwd, "99999999-0000-0000-0000-000000000000", { limit: 5 });
  assert.deepEqual(page, { messages: [], oldestIndex: 0, hasMore: false });
});

// --- tool_use / tool_result ----------------------------------------------

test("a tool_result merges into its card even when it lands outside the window", async () => {
  // The result record is NEWER than the window end, so a reader that stopped
  // scanning at the window boundary would leave the card stuck on `pending`.
  await writeLog(
    userText("ask"),
    rec({
      type: "assistant",
      uuid: "a1",
      message: { id: "m-a1", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } }] },
    }),
    rec({
      type: "user",
      uuid: "u2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body" }] },
    }),
    userText("next"),
    userText("newest"),
  );
  // Window = [1,3): the assistant card plus "next". The result record sits at
  // message-index boundary and the trailing "newest" is outside.
  const page = await transcript.readHistory(cwd, sessionId, { limit: 2, beforeIndex: 3 });
  const card = page.messages.find((m) => m.role === "assistant")?.blocks[0];
  assert.equal(card.type, "tool_use");
  assert.equal(card.result, "file body");
  assert.equal(card.pending, false);
  assert.equal(card.isError, false);
});

test("an error tool_result is flagged", async () => {
  await writeLog(
    rec({
      type: "assistant",
      uuid: "a1",
      message: { id: "m-a1", content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }] },
    }),
    rec({
      type: "user",
      uuid: "u2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "boom", is_error: true }] },
    }),
  );
  const page = await transcript.readHistory(cwd, sessionId, { limit: 5 });
  const card = page.messages[0].blocks[0];
  assert.equal(card.isError, true);
  assert.equal(card.result, "boom");
});

test("a tool_result whose tool_use fell out of the window is ignored", async () => {
  await writeLog(
    rec({
      type: "assistant",
      uuid: "a1",
      message: { id: "m-a1", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: {} }] },
    }),
    rec({
      type: "user",
      uuid: "u2",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "body" }] },
    }),
    userText("m1"),
    userText("m2"),
  );
  const page = await transcript.readHistory(cwd, sessionId, { limit: 1 });
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m2"],
  );
});

// --- record filtering, encoding, robustness -------------------------------

test("sidechain records, unknown types and corrupt lines are skipped", async () => {
  await writeLog(
    userText("keep1"),
    rec({ type: "user", isSidechain: true, uuid: "s1", message: { role: "user", content: [{ type: "text", text: "subagent" }] } }),
    rec({ type: "codex_thread", uuid: "x1", thread_id: "t" }),
    "{ this is not json }\n",
    "\n",
    userText("keep2"),
  );
  const page = await transcript.readHistory(cwd, sessionId, { limit: 10 });
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["keep1", "keep2"],
  );
});

test("multi-byte UTF-8 split across read chunks is not corrupted", async () => {
  // > 256 KB (the reader's chunk size) of CJK, so the line is reassembled from
  // several chunks and a 3-byte character is guaranteed to straddle a boundary.
  const big = "中文测试".repeat(30000);
  await writeLog(userText("before"), userText(big), userText("after"));
  const page = await transcript.readHistory(cwd, sessionId, { limit: 3 });
  assert.equal(page.messages[1].text, big);
  assert.equal(page.messages[1].text.length, big.length);
});

test("a half-written trailing line is picked up once it completes", async () => {
  await writeLog(userText("m0"));
  // claude appends the record, then the newline.
  const partial = JSON.stringify({
    type: "user",
    uuid: "u-partial",
    message: { role: "user", content: [{ type: "text", text: "m1" }] },
  });
  await appendFile(logPath, partial);
  let page = await transcript.readHistory(cwd, sessionId, { limit: 10 });
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m0", "m1"],
  );
  await appendFile(logPath, "\n" + userText("m2"));
  page = await transcript.readHistory(cwd, sessionId, { limit: 10 });
  assert.deepEqual(
    page.messages.map((m) => m.text),
    ["m0", "m1", "m2"],
  );
});

test("assistant thinking and text blocks survive, tool_use starts pending", async () => {
  await writeLog(
    rec({
      type: "assistant",
      uuid: "a1",
      message: {
        id: "m-a1",
        content: [
          { type: "thinking", thinking: "hmm" },
          { type: "text", text: "answer" },
          { type: "tool_use", id: "tu_9", name: "Glob", input: { pattern: "*" } },
        ],
      },
    }),
  );
  const page = await transcript.readHistory(cwd, sessionId, { limit: 5 });
  const blocks = page.messages[0].blocks;
  assert.deepEqual(blocks.map((b) => b.type), ["thinking", "text", "tool_use"]);
  assert.equal(blocks[0].thinking, "hmm");
  assert.equal(blocks[2].pending, true);
  assert.equal(page.messages[0].streaming, false);
});

test("an injected skill preamble is stripped back off for display", async () => {
  const wrapped = util.injectSkill(
    { name: "deploy-site", scope: "global", body: "# steps\n1. do the thing" },
    "上线 example.com",
  );
  await writeLog(userText(wrapped));
  const page = await transcript.readHistory(cwd, sessionId, { limit: 5 });
  assert.equal(page.messages[0].text, "上线 example.com");
  // And a normal message is untouched.
  assert.equal(util.stripSkillInjection("plain [Active skill: no] text"), "plain [Active skill: no] text");
});

// --- images ---------------------------------------------------------------

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

test("image blocks become lazy URL refs, not embedded base64", async () => {
  await writeLog(
    rec({
      type: "user",
      uuid: "img-1",
      message: {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
        ],
      },
    }),
  );
  const page = await transcript.readHistory(cwd, sessionId, { limit: 5 });
  const m = page.messages[0];
  assert.equal(m.text, "look");
  assert.equal(m.images.length, 1);
  assert.equal(m.images[0].mediaType, "image/png");
  assert.match(m.images[0].url, /^\/api\/transcript\/image\?cwd=/);
  assert.match(m.images[0].url, /uuid=img-1&idx=1/);
  assert.ok(!JSON.stringify(m).includes(PNG_B64), "history payload must not embed base64");
});

test("readTranscriptImage decodes the addressed block only", async () => {
  await writeLog(
    userText("filler"),
    rec({
      type: "user",
      uuid: "img-2",
      message: {
        role: "user",
        content: [
          { type: "text", text: "two" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
        ],
      },
    }),
  );
  const got = await transcript.readTranscriptImage(cwd, sessionId, "img-2", 1);
  assert.equal(got.mediaType, "image/png");
  assert.deepEqual(got.buffer, Buffer.from(PNG_B64, "base64"));
  // Wrong index / unknown uuid / a non-image block → null, never a throw.
  assert.equal(await transcript.readTranscriptImage(cwd, sessionId, "img-2", 0), null);
  assert.equal(await transcript.readTranscriptImage(cwd, sessionId, "nope", 1), null);
});

test("embedded image bytes count nested tool_result images and grow with appends", async () => {
  await writeLog(
    rec({
      type: "user",
      uuid: "img-3",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }],
      },
    }),
  );
  const first = await transcript.embeddedImageBytes(cwd, sessionId);
  assert.equal(first, PNG_B64.length);

  // A screenshot arriving as a tool_result (the flow that produced a 40MB
  // transcript) must count too, and the cache must extend incrementally.
  await appendFile(
    logPath,
    rec({
      type: "user",
      uuid: "img-4",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_x",
            content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }],
          },
        ],
      },
    }),
  );
  const second = await transcript.embeddedImageBytes(cwd, sessionId);
  assert.equal(second, PNG_B64.length * 2);

  // Repeated reads are stable (cache hit path).
  assert.equal(await transcript.embeddedImageBytes(cwd, sessionId), second);
});

test("a rewritten (shrunk) transcript is fully rescanned, not extended", async () => {
  await writeLog(
    rec({
      type: "user",
      uuid: "img-5",
      message: {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } }],
      },
    }),
  );
  assert.equal(await transcript.embeddedImageBytes(cwd, sessionId), PNG_B64.length);
  await writeLog(userText("no images here"));
  assert.equal(await transcript.embeddedImageBytes(cwd, sessionId), 0);
});

// --- readConversationText (compact summarizer input) -----------------------
// Renders the transcript to plain text for the one-shot `claude -p` handoff
// summary in SessionManager.compact. The contract that matters: every turn is
// there (user says, assistant says, one-line tool traces) but tool RESULTS and
// skill preambles are not — results would blow the prompt budget, and the
// preamble would make the summarizer re-inject the skill.

test("readConversationText renders user/assistant/tool lines and skips results", async () => {
  await writeLog(
    userText("fix the bug"),
    rec({
      type: "user",
      uuid: "r1",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "40 KB of file body".repeat(500) }] },
    }),
    rec({
      type: "assistant",
      uuid: "a1",
      message: {
        id: "m-a1",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "tu_1", name: "Edit", input: { file_path: "/data/x.js", old_string: "a", new_string: "b" } },
        ],
      },
    }),
    userText("done?"),
    rec({
      type: "assistant",
      uuid: "a2",
      message: { id: "m-a2", content: [{ type: "text", text: "yes, fixed" }] },
    }),
  );
  const { text, count } = await transcript.readConversationText(cwd, sessionId);
  assert.equal(count, 4);
  assert.match(text, /USER: fix the bug/);
  assert.match(text, /ASSISTANT: on it\nTOOL Edit \/data\/x\.js/);
  assert.match(text, /USER: done\?/);
  assert.match(text, /ASSISTANT: yes, fixed/);
  // The tool_result body must not ride along into the summarizer prompt.
  assert.ok(!text.includes("file body"));
});

test("readConversationText strips the injected skill preamble and clips long turns", async () => {
  const wrapped = util.injectSkill(
    { name: "deploy-site", scope: "global", body: "# steps\n1. do the thing" },
    "上线 example.com",
  );
  const long = "x".repeat(50);
  await writeLog(userText(wrapped), userText(long.repeat(200)));
  const { text, count } = await transcript.readConversationText(cwd, sessionId, { maxChars: 1000, perMsg: 6000 });
  assert.equal(count, 2);
  assert.match(text, /USER: 上线 example\.com/);
  assert.ok(!text.includes("[Active skill:"));
  assert.ok(!text.includes("[SKILL CONTENT]"));
  // The 10000-char turn is clipped to perMsg with a marker, and the total
  // stays within budget.
  assert.match(text, /\[…truncated\]/);
  assert.ok(text.length < 7000);
  // A missing transcript is an empty render, not a throw.
  assert.deepEqual(
    await transcript.readConversationText(cwd, "eeeeeeee-0000-0000-0000-000000000000"),
    { text: "", count: 0 },
  );
});
