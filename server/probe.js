// Quick end-to-end probe: spawns `claude` in stream-json mode against the
// configured gateway, sends one user message, prints the raw events, exits.
// Run: npm run probe
import { spawn } from "node:child_process";
import { config, childEnv } from "./config.js";
import { buildClaudeArgs } from "./claude-args.js";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "..", "workspace");
mkdirSync(cwd, { recursive: true });

const args = buildClaudeArgs({ cwd, resume: undefined });
console.log("argv: claude", args.join(" "));
console.log("env ANTHROPIC_BASE_URL =", config.anthropicBaseUrl, "model =", config.anthropicModel);

const proc = spawn("claude", args, { cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });

let buffer = "";
let count = 0;
const stopAt = 12; // events to collect before exiting

proc.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      console.log("[non-json]", line.slice(0, 200));
      continue;
    }
    count++;
    console.log(`\n--- event #${count} type=${evt.type}${evt.subtype ? "/" + evt.subtype : ""} ---`);
    console.log(JSON.stringify(evt, null, 2).slice(0, 1200));
    if (evt.type === "result" || count >= stopAt) {
      proc.stdin.end();
      proc.kill("SIGTERM");
    }
  }
});
proc.stderr.on("data", (c) => process.stderr.write(`[stderr] ${c}`));
proc.on("exit", (code, sig) => {
  console.log(`\n[exit] code=${code} signal=${sig} events=${count}`);
  process.exit(0);
});

// Send one user message via stream-json stdin.
const line = JSON.stringify({
  type: "user",
  message: { role: "user", content: [{ type: "text", text: "Say hello in one short sentence." }] },
});
proc.stdin.write(line + "\n");

setTimeout(() => {
  console.log("\n[timeout] killing");
  proc.kill("SIGKILL");
  process.exit(1);
}, 30000).unref();