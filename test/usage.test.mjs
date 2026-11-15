// Regression net for server/usage.js's local ledger — the transcript scan
// behind the Usage panel's local-ledger section.
//
// The provider halves (claude/codex/grok/ollama) are thin HTTP calls against
// live subscription APIs and are not covered here; the ledger is the part with
// real logic: per-turn deduplication (claude rewrites the same message.id as a
// turn streams, each time with a fuller usage snapshot — counting every record
// would multiply usage several-fold), the engine sidecar records codex.js and
// grok.js append, and the per-file memoization that must still notice a
// transcript that grew.
//
// Run: npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home;
let usage;
let projectDir;

const today = new Date().toISOString().slice(0, 10);
const ts = (hhmm) => `${today}T${hhmm}:00.000Z`;

// usage.js resolves ~/.claude/projects via os.homedir() at module load, so HOME
// must be pointed at a temp dir BEFORE the dynamic import (same trick as
// transcript.test.mjs).
before(async () => {
  home = await mkdtemp(join(tmpdir(), "coding-ui-usage-"));
  process.env.HOME = home;
  projectDir = join(home, ".claude", "projects", "-data-coding-dev-ui-workspace");
  await mkdir(projectDir, { recursive: true });
  usage = await import("../server/usage.js");
});

after(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

function line(obj) {
  return JSON.stringify(obj) + "\n";
}

// One streamed claude turn: the same message.id three times, usage growing.
function claudeTurn(id, model, { input, output, cacheRead = 0, cacheCreate = 0 }, at) {
  return [0.3, 0.7, 1]
    .map((f) =>
      line({
        type: "assistant",
        timestamp: at,
        message: {
          id,
          model,
          role: "assistant",
          usage: {
            input_tokens: Math.round(input * f),
            output_tokens: Math.round(output * f),
            cache_read_input_tokens: Math.round(cacheRead * f),
            cache_creation_input_tokens: Math.round(cacheCreate * f),
          },
        },
      }),
    )
    .join("");
}

test("ledger dedupes streamed records, keeps the fullest snapshot per turn", async () => {
  await writeFile(
    join(projectDir, "aaaaaaaa-1111-2222-3333-444444444444.jsonl"),
    claudeTurn("msg_1", "glm-5.3", { input: 1000, output: 100, cacheRead: 5000 }, ts("01:00")) +
      claudeTurn("msg_2", "glm-5.3", { input: 2000, output: 200 }, ts("02:00")),
  );
  const led = await usage.ledger({ days: 7 });
  const glm = led.byModel.find((m) => m.model === "glm-5.3");
  assert.ok(glm, "glm-5.3 should be in the ledger");
  assert.equal(glm.turns, 2, "two turns, not six records");
  assert.equal(glm.input, 3000);
  assert.equal(glm.output, 300);
  assert.equal(glm.cacheRead, 5000);
  assert.equal(glm.total, 8300);
  assert.equal(led.total.turns, 2);
  assert.equal(led.today.turns, 2);
});

test("usage sidecars from the codex/grok engines land in the ledger", async () => {
  await writeFile(
    join(projectDir, "bbbbbbbb-1111-2222-3333-444444444444.jsonl"),
    line({ type: "codex_thread", thread_id: "t1" }) +
      line({
        type: "usage",
        uuid: "u1",
        engine: "codex",
        model: "gpt-5.6-sol",
        timestamp: ts("03:00"),
        usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
      }) +
      line({
        type: "usage",
        uuid: "u2",
        engine: "grok",
        model: "grok-4.7",
        timestamp: ts("04:00"),
        usage: { input_tokens: 700, output_tokens: 70 },
      }),
  );
  const led = await usage.ledger({ days: 7 });
  const codex = led.byModel.find((m) => m.model === "gpt-5.6-sol");
  const grok = led.byModel.find((m) => m.model === "grok-4.7");
  assert.equal(codex.total, 560);
  assert.equal(grok.total, 770);
  const engines = Object.fromEntries(led.byEngine.map((e) => [e.engine, e.turns]));
  assert.equal(engines.codex, 1);
  assert.equal(engines.grok, 1);
  assert.equal(engines.claude, 2, "the claude-engine turns from the first file are still counted");
});

test("synthetic and zero-usage records are skipped", async () => {
  await writeFile(
    join(projectDir, "cccccccc-1111-2222-3333-444444444444.jsonl"),
    line({ type: "assistant", timestamp: ts("05:00"), message: { id: "s1", model: "<synthetic>", usage: { input_tokens: 9999, output_tokens: 9999 } } }) +
      line({ type: "assistant", timestamp: ts("05:01"), message: { id: "z1", model: "glm-5.3", usage: { input_tokens: 0, output_tokens: 0 } } }) +
      "not json at all\n",
  );
  const led = await usage.ledger({ days: 7 });
  assert.ok(!led.byModel.some((m) => m.model === "<synthetic>"));
  assert.equal(led.byModel.find((m) => m.model === "glm-5.3").turns, 2, "zero-usage record adds no turn");
});

test("an appended transcript is rescanned, an unchanged one is not", async () => {
  const path = join(projectDir, "aaaaaaaa-1111-2222-3333-444444444444.jsonl");
  const before = await usage.ledger({ days: 7 });
  assert.equal(before.rescanned, 0, "nothing changed since the last call");
  await appendFile(path, claudeTurn("msg_3", "glm-5.3", { input: 10, output: 1 }, ts("06:00")));
  const after2 = await usage.ledger({ days: 7 });
  assert.equal(after2.rescanned, 1, "only the grown file is re-read");
  assert.equal(after2.byModel.find((m) => m.model === "glm-5.3").turns, 3);
});

test("byDay carries one bucket per calendar day, newest last", async () => {
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  await writeFile(
    join(projectDir, "dddddddd-1111-2222-3333-444444444444.jsonl"),
    claudeTurn("msg_y", "kimi-k3", { input: 400, output: 40 }, `${yesterday}T10:00:00.000Z`),
  );
  const led = await usage.ledger({ days: 7 });
  const dates = led.byDay.map((d) => d.date);
  assert.deepEqual(dates, [...dates].sort(), "byDay is chronological");
  assert.ok(dates.includes(yesterday) && dates.includes(today));
  assert.equal(led.byDay.find((d) => d.date === yesterday).total, 440);
  assert.equal(led.today.turns, 5, "yesterday's turn is not in today's bucket");
});
