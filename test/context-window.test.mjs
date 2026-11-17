// Regression net for the per-model context-window declaration in config.js —
// the number the context gauge in the metrics bar and the context-high
// warning are measured against. It's an operator-declared approximation
// (CONTEXT_WINDOWS), so what needs pinning is the prefix matching order and
// the fallback, not any model's true window.
//
// Run: npm test
import { test, before } from "node:test";
import assert from "node:assert/strict";

let config;

before(async () => {
  // Parsed once at import time, so the rules must be in the env first.
  process.env.CONTEXT_WINDOWS = "claude-sonnet=1000000,claude-=200000,glm=128000";
  process.env.DEFAULT_CONTEXT_WINDOW = "200000";
  process.env.CONTEXT_HIGH_PCT = "0.75";
  config = await import("../server/config.js");
});

test("longest matching prefix wins, then the default", () => {
  // claude-sonnet-* hits the specific rule, not the claude- one.
  assert.equal(config.contextWindowFor("claude-sonnet-5"), 1000000);
  // Any other claude-* falls to the broader prefix.
  assert.equal(config.contextWindowFor("claude-opus-5"), 200000);
  // Unprefixed models get their own rule or the default.
  assert.equal(config.contextWindowFor("glm-5.2:cloud"), 128000);
  assert.equal(config.contextWindowFor("kimi-k2"), 200000);
  assert.equal(config.contextWindowFor(""), 200000);
  assert.equal(config.contextWindowFor(null), 200000);
});

test("the high-watermark threshold parses once with its fallback", () => {
  assert.equal(config.config.contextHighPct, 0.75);
});
