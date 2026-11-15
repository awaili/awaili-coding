// Cross-provider usage/quota aggregation for the UI's Usage panel.
//
// The four model channels this server routes to (see config.modelRoutes) each
// meter usage differently, and only three expose a queryable quota at all:
//
//   claude  — Claude subscription (native OAuth). Two sources:
//             (a) every /v1/messages response carries the unified rate-limit
//                 headers (`anthropic-ratelimit-unified-5h-utilization`,
//                 `-7d-utilization`, resets, fallback/overage status) — the
//                 same numbers the CLI's /usage shows. Read via a 1-token
//                 probe request, which is what makes this cheap and reliable.
//             (b) GET /api/oauth/usage returns a richer payload, but it is
//                 rate-limited to roughly one call per hour per token (429 +
//                 Retry-After ~56min), so it can only ever be an enrichment —
//                 never the primary source. Its shape is undocumented, so it
//                 is surfaced as `extra` and mined defensively.
//   codex   — ChatGPT plan. GET chatgpt.com/backend-api/codex/usage with the
//             Codex CLI's own access token: plan type, the 5-hour + weekly
//             window percentages with reset timestamps, credit balance.
//             Free, no probe needed.
//   grok    — grok.com subscription. GET cli-chat-proxy.grok.com/v1/billing
//             gives the monthly credit/on-demand picture; the weekly token and
//             request allowance only shows up as `x-ratelimit-*` response
//             headers, so that half needs a 1-token probe like claude's.
//   ollama  — the local gateway fronting ollama.com cloud models. POST
//             /api/me identifies the account and plan tier, but ollama.com
//             exposes NO usage/quota API and its completions carry no
//             rate-limit headers (verified 2026-11-15). So this provider
//             reports account + plan only, and its consumption is shown from
//             our own transcript ledger below instead.
//
// Tokens are read from each official CLI's credential file and never leave
// this module (nothing token-shaped is returned to the client). Expired
// credentials are reported as `stale` rather than refreshed: the CLIs rotate
// their own refresh tokens, and racing them risks invalidating a working
// login.
//
// Beside the provider quotas, `ledger()` aggregates what WE actually spent, by
// scanning the Claude Code transcripts (~/.claude/projects/**/*.jsonl) that
// every engine in this server writes into. claude-engine sessions (native +
// all gateway models) carry `message.usage` natively; codex.js/grok.js append
// a `{type:"usage"}` sidecar record per turn (loadHistory ignores unknown
// record types) so their turns land in the same ledger.
import { readFileSync, statSync, readdirSync, createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { config } from "./config.js";

const UA_CLAUDE = "claude-cli/2.1.268 (external, cli)";
const UA_CODEX = "codex_cli_rs";
const UA_GROK = "grok-cli";

// ── small helpers ───────────────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// `exp` claim of a JWT, in ms. Returns null for opaque (non-JWT) tokens.
function jwtExpiryMs(token) {
  try {
    const [, payload] = String(token).split(".");
    if (!payload) return null;
    const j = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof j.exp === "number" ? j.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function fetchJson(url, { method = "GET", headers = {}, body = null, timeout = 10000 } = {}) {
  const res = await fetch(url, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON (HTML error page, empty body) — keep the text for diagnostics */
  }
  return { res, json, text };
}

// Cache entries are per-source so a cheap call isn't held back by an
// expensive/rate-limited one. { at, value, until } — `until` wins over ttl
// when a server told us when to come back (Retry-After).
const cache = new Map();
function cached(key, ttlMs, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.value !== undefined) {
    const fresh = hit.until ? now < hit.until : now - hit.at < ttlMs;
    if (fresh) return Promise.resolve(hit.value);
  }
  if (hit?.inflight) return hit.inflight;
  const inflight = Promise.resolve().then(fn).then(
    ({ value, until = 0 }) => {
      cache.set(key, { at: Date.now(), value, until });
      return value;
    },
    (err) => {
      // Negative-cache briefly so a dead endpoint can't be hammered by reloads.
      const value = { status: "error", error: String(err?.message || err).slice(0, 300) };
      cache.set(key, { at: Date.now(), value, until: Date.now() + 30_000 });
      return value;
    },
  );
  cache.set(key, { at: hit?.at || 0, value: hit?.value, until: hit?.until || 0, inflight });
  return inflight;
}

export function clearUsageCache() {
  cache.clear();
}

// ── claude: Claude subscription ─────────────────────────────────────────────

function claudeToken() {
  if (config.nativeOAuthToken) return config.nativeOAuthToken;
  // Fallback for boxes that logged in interactively instead of using
  // `claude setup-token`: the CLI stores the OAuth token here.
  const creds = readJson(join(homedir(), ".claude", ".credentials.json"));
  return creds?.claudeAiOauth?.accessToken || "";
}

// One-token /v1/messages call purely to read the unified rate-limit headers.
// ~22 input tokens per probe, cached, so it's noise against any plan.
async function claudeHeaderProbe(token) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
      "user-agent": UA_CLAUDE,
      "x-app": "cli",
    },
    body: JSON.stringify({
      model: config.anthropicHaikuModel?.startsWith("claude-")
        ? config.anthropicHaikuModel
        : "claude-haiku-4-5-20251001",
      max_tokens: 1,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }],
      messages: [{ role: "user", content: "hi" }],
    }),
    signal: AbortSignal.timeout(30000),
  });
  const h = (name) => res.headers.get(name);
  const num = (name) => {
    const v = h(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (!res.ok && !h("anthropic-ratelimit-unified-status")) {
    const body = await res.text();
    throw new Error(`probe ${res.status}: ${body.slice(0, 160)}`);
  }
  await res.arrayBuffer().catch(() => {});
  return {
    limitStatus: h("anthropic-ratelimit-unified-status"),
    windows: [
      { id: "5h", label: "5 hours", usedPercent: num("anthropic-ratelimit-unified-5h-utilization"), resetAt: num("anthropic-ratelimit-unified-5h-reset"), state: h("anthropic-ratelimit-unified-5h-status") },
      { id: "7d", label: "7 days", usedPercent: num("anthropic-ratelimit-unified-7d-utilization"), resetAt: num("anthropic-ratelimit-unified-7d-reset"), state: h("anthropic-ratelimit-unified-7d-status") },
    ].filter((w) => w.usedPercent !== null || w.state),
    fallback: h("anthropic-ratelimit-unified-fallback"),
    overageStatus: h("anthropic-ratelimit-unified-overage-status"),
    representativeClaim: h("anthropic-ratelimit-unified-representative-claim"),
  };
}

// GET /api/oauth/usage — richer, but ~1 call/hour. On 429 we park the result
// until Retry-After so reloads don't keep burning the allowance.
async function claudeOauthUsage(token) {
  const { res, json, text } = await fetchJson("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "user-agent": UA_CLAUDE,
      "x-app": "cli",
      accept: "application/json",
    },
    timeout: 15000,
  });
  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after")) || 900;
    return {
      value: { status: "rate_limited", retryAfterSec: retry },
      until: Date.now() + Math.min(retry, 3600) * 1000,
    };
  }
  if (!res.ok) {
    return {
      value: { status: "error", error: `HTTP ${res.status}: ${(text || "").slice(0, 160)}` },
      until: Date.now() + 10 * 60 * 1000,
    };
  }
  return { value: { status: "ok", data: json }, until: Date.now() + 60 * 60 * 1000 };
}

async function claudeProvider({ probe }) {
  const token = claudeToken();
  const base = {
    id: "claude",
    name: "Claude subscription",
    detail: "claude-* native engine (CLAUDE_CODE_OAUTH_TOKEN)",
    source: "api.anthropic.com",
  };
  if (!token) {
    return { ...base, status: "unavailable", notes: ["CLAUDE_CODE_OAUTH_TOKEN is not set (.env.auth)"] };
  }
  const expiry = jwtExpiryMs(token);
  const notes = [];
  const [headerRes, oauthRes] = await Promise.all([
    probe
      ? cached("claude:probe", 10 * 60 * 1000, async () => ({
          value: { status: "ok", ...(await claudeHeaderProbe(token)) },
        }))
      : Promise.resolve(cache.get("claude:probe")?.value || { status: "skipped" }),
    cached("claude:oauth-usage", 60 * 60 * 1000, () => claudeOauthUsage(token)),
  ]);

  if (oauthRes?.status === "rate_limited") {
    notes.push(
      `Official /api/oauth/usage is rate-limited (retry in ~${Math.round(oauthRes.retryAfterSec / 60)} min); window figures come from the response headers instead`,
    );
  }
  if (headerRes?.status === "skipped") notes.push("Not probed (probe=0) — hit Refresh for current window utilization");
  if (headerRes?.status === "error") notes.push(`Probe failed: ${headerRes.error}`);
  if (expiry) notes.push(`Subscription token valid until ${new Date(expiry).toISOString().slice(0, 10)}`);

  const windows = headerRes?.windows || [];
  return {
    ...base,
    status: headerRes?.status === "ok" ? "ok" : headerRes?.status === "skipped" ? "stale" : "error",
    error: headerRes?.status === "error" ? headerRes.error : null,
    windows,
    facts: [
      headerRes?.limitStatus ? { label: "Limit status", value: headerRes.limitStatus } : null,
      headerRes?.overageStatus ? { label: "Overage", value: headerRes.overageStatus } : null,
      headerRes?.fallback ? { label: "Fallback model", value: headerRes.fallback } : null,
    ].filter(Boolean),
    extra: oauthRes?.status === "ok" ? oauthRes.data : null,
    notes,
  };
}

// ── codex: ChatGPT plan ─────────────────────────────────────────────────────

async function codexProvider() {
  const base = {
    id: "codex",
    name: "ChatGPT plan (Codex)",
    detail: "gpt-* via the official codex CLI",
    source: "chatgpt.com/backend-api/codex/usage",
  };
  const auth = readJson(join(homedir(), ".codex", "auth.json"));
  const token = auth?.tokens?.access_token;
  const accountId = auth?.tokens?.account_id || "";
  if (!token) return { ...base, status: "unavailable", notes: ["Not signed in — run `codex login`"] };

  const result = await cached("codex:usage", 60 * 1000, async () => {
    const { res, json, text } = await fetchJson("https://chatgpt.com/backend-api/codex/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        "chatgpt-account-id": accountId,
        originator: UA_CODEX,
        "user-agent": UA_CODEX,
        accept: "application/json",
      },
      timeout: 15000,
    });
    if (res.status === 401) {
      return { value: { status: "stale", error: "Token expired (the codex CLI refreshes it on its next session)" }, until: Date.now() + 60_000 };
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(text || "").slice(0, 160)}`);
    return { value: { status: "ok", data: json } };
  });

  if (result.status !== "ok") {
    return { ...base, status: result.status === "stale" ? "stale" : "error", error: result.error, notes: [] };
  }
  const d = result.data || {};
  const rl = d.rate_limit || {};
  const mkWindow = (w, id, label) =>
    w
      ? {
          id,
          label: w.limit_window_seconds ? `${label} (${Math.round(w.limit_window_seconds / 3600)}h)` : label,
          usedPercent: typeof w.used_percent === "number" ? w.used_percent : null,
          resetAt: w.reset_at || (w.reset_after_seconds ? Math.floor(Date.now() / 1000) + w.reset_after_seconds : null),
        }
      : null;
  const notes = [];
  if (rl.limit_reached) notes.push("Limit reached — unavailable for the rest of this window");
  const credits = d.credits || {};
  return {
    ...base,
    status: "ok",
    windows: [mkWindow(rl.primary_window, "primary", "Primary window"), mkWindow(rl.secondary_window, "secondary", "Secondary window")].filter(Boolean),
    facts: [
      d.plan_type ? { label: "Plan", value: d.plan_type } : null,
      d.email ? { label: "Account", value: d.email } : null,
      { label: "Extra credits", value: credits.unlimited ? "unlimited" : `${credits.balance ?? 0}` },
      d.rate_limit_reset_credits
        ? { label: "Reset credits", value: String(d.rate_limit_reset_credits.available_count ?? 0) }
        : null,
    ].filter(Boolean),
    notes,
  };
}

// ── grok: grok.com subscription ─────────────────────────────────────────────

// cli-chat-proxy rejects requests from an unknown client version with HTTP 426
// ("Your Grok CLI version (none) is outdated"), so every call must claim the
// installed CLI's version. Read from the npm package so an update carries over.
let grokVersion = null;
function grokClientVersion() {
  if (grokVersion) return grokVersion;
  for (const p of [
    "/usr/local/lib/node_modules/@xai-official/grok/package.json",
    join(homedir(), ".grok", "bundled", "package.json"),
  ]) {
    const v = readJson(p)?.version;
    if (v) return (grokVersion = v);
  }
  return (grokVersion = "1.0.77");
}

function grokHeaders(token) {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "x-grok-client-version": grokClientVersion(),
    "x-grok-client-mode": "cli",
    "user-agent": `${UA_GROK}/${grokClientVersion()}`,
  };
}

function grokAuth() {
  const auth = readJson(join(homedir(), ".grok", "auth.json"));
  if (!auth || typeof auth !== "object") return null;
  // Keyed by "<issuer>::<client id>"; take the newest entry that has a key.
  const entries = Object.values(auth).filter((v) => v && typeof v === "object" && v.key);
  if (!entries.length) return null;
  entries.sort((a, b) => String(b.create_time || "").localeCompare(String(a.create_time || "")));
  return entries[0];
}

// Same trick as claude's probe: the weekly token/request allowance is only
// reported as x-ratelimit-* headers on a completion response.
async function grokHeaderProbe(token) {
  const res = await fetch("https://cli-chat-proxy.grok.com/v1/chat/completions", {
    method: "POST",
    headers: { ...grokHeaders(token), "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-4.5",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    }),
    signal: AbortSignal.timeout(60000),
  });
  const num = (name) => {
    const v = res.headers.get(name);
    const n = v == null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  if (!res.ok && num("x-ratelimit-limit-tokens") === null) {
    const body = await res.text();
    throw new Error(`probe ${res.status}: ${body.slice(0, 160)}`);
  }
  await res.arrayBuffer().catch(() => {});
  return {
    limitTokens: num("x-ratelimit-limit-tokens"),
    remainingTokens: num("x-ratelimit-remaining-tokens"),
    limitRequests: num("x-ratelimit-limit-requests"),
    remainingRequests: num("x-ratelimit-remaining-requests"),
  };
}

async function grokProvider({ probe }) {
  const base = {
    id: "grok",
    name: "Grok subscription",
    detail: "grok-* via the official Grok Build CLI",
    source: "cli-chat-proxy.grok.com",
  };
  const auth = grokAuth();
  if (!auth) return { ...base, status: "unavailable", notes: ["Not signed in — run `grok login`"] };
  const token = auth.key;
  const expired = auth.expires_at && new Date(auth.expires_at).getTime() < Date.now();
  const notes = [];
  if (expired) notes.push("Credentials expired — the grok CLI refreshes them on its next session; figures update after that");

  const [billing, rate] = await Promise.all([
    cached("grok:billing", 5 * 60 * 1000, async () => {
      const { res, json, text } = await fetchJson("https://cli-chat-proxy.grok.com/v1/billing", {
        headers: grokHeaders(token),
        timeout: 15000,
      });
      if (res.status === 401) return { value: { status: "stale" }, until: Date.now() + 60_000 };
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(text || "").slice(0, 160)}`);
      return { value: { status: "ok", data: json?.config || json || {} } };
    }),
    probe
      ? cached("grok:probe", 15 * 60 * 1000, async () => ({
          value: { status: "ok", ...(await grokHeaderProbe(token)) },
        }))
      : Promise.resolve(cache.get("grok:probe")?.value || { status: "skipped" }),
  ]);

  if (rate?.status === "error") notes.push(`Quota probe failed: ${rate.error}`);
  if (rate?.status === "skipped") notes.push("Not probed (probe=0) — the remaining allowance needs one 1-token probe request to read");
  if (rate?.status === "ok" && rate.limitTokens) {
    notes.push(
      "xAI returns only x-ratelimit-limit/remaining — no window length, no reset time. Observed: remaining refills quickly (a short window), so read this as the CURRENT allowance left, not cumulative spend.",
    );
  }
  const windows = [];
  if (rate?.status === "ok" && rate.limitTokens) {
    windows.push({
      id: "tokens",
      label: "Token allowance used",
      usedPercent: ((rate.limitTokens - (rate.remainingTokens ?? rate.limitTokens)) / rate.limitTokens) * 100,
      used: rate.limitTokens - (rate.remainingTokens ?? rate.limitTokens),
      limit: rate.limitTokens,
    });
  }
  if (rate?.status === "ok" && rate.limitRequests) {
    windows.push({
      id: "requests",
      label: "Request allowance used",
      usedPercent: ((rate.limitRequests - (rate.remainingRequests ?? rate.limitRequests)) / rate.limitRequests) * 100,
      used: rate.limitRequests - (rate.remainingRequests ?? rate.limitRequests),
      limit: rate.limitRequests,
    });
  }
  const b = billing?.status === "ok" ? billing.data : null;
  const val = (x) => (x && typeof x === "object" && "val" in x ? x.val : x);
  if (b && Number(val(b.monthlyLimit)) > 0) {
    windows.push({
      id: "monthly",
      label: "Monthly allowance",
      usedPercent: (Number(val(b.used)) / Number(val(b.monthlyLimit))) * 100,
      used: Number(val(b.used)),
      limit: Number(val(b.monthlyLimit)),
    });
  } else if (b) {
    notes.push("Monthly allowance is 0 — this subscription is not credit-billed; spend only shows up in the allowance above.");
  }
  return {
    ...base,
    status: billing?.status === "ok" || rate?.status === "ok" ? (expired ? "stale" : "ok") : "error",
    error: billing?.error || null,
    windows,
    facts: [
      auth.email ? { label: "Account", value: auth.email } : null,
      b?.billingPeriodStart
        ? { label: "Billing period", value: `${String(b.billingPeriodStart).slice(0, 10)} → ${String(b.billingPeriodEnd || "").slice(0, 10)}` }
        : null,
      b && val(b.prepaidBalance) != null ? { label: "Prepaid balance", value: String(val(b.prepaidBalance)) } : null,
      b && val(b.onDemandCap) != null ? { label: "On-demand cap", value: String(val(b.onDemandCap)) } : null,
    ].filter(Boolean),
    notes,
  };
}

// ── ollama: the local gateway (no quota API) ────────────────────────────────

async function ollamaProvider() {
  const baseUrl = (config.ollamaBaseUrl || config.anthropicBaseUrl).replace(/\/+$/, "");
  const base = {
    id: "ollama",
    name: "Ollama cloud gateway",
    detail: "glm/kimi/minimax/… via the local Ollama gateway",
    source: baseUrl,
  };
  const me = await cached("ollama:me", 5 * 60 * 1000, async () => {
    const { res, json, text } = await fetchJson(`${baseUrl}/api/me`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      timeout: 8000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(text || "").slice(0, 120)}`);
    return { value: { status: "ok", data: json || {} } };
  });
  if (me.status !== "ok") {
    return { ...base, status: "error", error: me.error, windows: [], facts: [], notes: [] };
  }
  const d = me.data;
  return {
    ...base,
    status: "no-quota-api",
    windows: [],
    facts: [
      d.email ? { label: "Account", value: d.email } : null,
      d.plan ? { label: "Plan", value: d.plan } : null,
    ].filter(Boolean),
    notes: [
      "ollama.com publishes no usage/quota API, and its completions carry no rate-limit headers (verified 2026-11-15), so only the account and plan tier can be shown here.",
      "Actual consumption is in the local ledger below — gateway-model tokens are counted from the session transcripts.",
    ],
  };
}

// ── local ledger: what we actually spent, from the transcripts ──────────────

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const LEDGER_WINDOW_DAYS = 45; // files older than this are skipped entirely
const fileAggCache = new Map(); // path -> { mtimeMs, size, agg }

function emptyAgg() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}
function addAgg(into, u) {
  into.turns += 1;
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheCreate += u.cacheCreate;
  return into;
}
function totalOf(u) {
  return u.input + u.output + u.cacheRead + u.cacheCreate;
}

// Aggregate one transcript: { byDayModel: { "YYYY-MM-DD": { model: agg } } }.
// Records repeat the same message.id as a turn streams, each carrying a
// growing usage snapshot, so keep the largest snapshot per id and only fold it
// in at the end.
async function aggregateFile(path) {
  const perId = new Map(); // message.id -> { date, model, engine, usage }
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap pre-filter: only usage-bearing records are worth parsing.
    if (line.length < 20 || !line.includes('"usage"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const sidecar = rec?.type === "usage";
    const msg = sidecar ? rec : rec?.message;
    const u = msg?.usage;
    if (!u || typeof u !== "object") continue;
    const model = (sidecar ? rec.model : msg.model) || "unknown";
    if (model === "<synthetic>") continue;
    const usage = {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheCreate: Number(u.cache_creation_input_tokens) || 0,
    };
    if (totalOf(usage) === 0) continue;
    const ts = rec.timestamp || rec.ts || null;
    const date = typeof ts === "string" && ts.length >= 10 ? ts.slice(0, 10) : "unknown";
    const id = (sidecar ? `sc:${rec.uuid || ts}:${model}` : msg.id) || `${date}:${Math.random()}`;
    const prev = perId.get(id);
    if (!prev || totalOf(usage) > totalOf(prev.usage)) {
      perId.set(id, { date, model, engine: sidecar ? rec.engine || "unknown" : "claude", usage });
    }
  }
  const byDayModel = {};
  const byEngine = {};
  for (const { date, model, engine, usage } of perId.values()) {
    byDayModel[date] = byDayModel[date] || {};
    byDayModel[date][model] = addAgg(byDayModel[date][model] || emptyAgg(), usage);
    byEngine[engine] = addAgg(byEngine[engine] || emptyAgg(), usage);
  }
  return { byDayModel, byEngine };
}

function listTranscripts() {
  const out = [];
  let projects;
  try {
    projects = readdirSync(PROJECTS_DIR, { withFileTypes: true });
  } catch {
    return out;
  }
  const cutoff = Date.now() - LEDGER_WINDOW_DAYS * 86400_000;
  for (const d of projects) {
    if (!d.isDirectory()) continue;
    const dir = join(PROJECTS_DIR, d.name);
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = join(dir, f);
      try {
        const st = statSync(p);
        if (st.mtimeMs < cutoff || !st.size) continue;
        out.push({ path: p, project: d.name, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        /* vanished mid-scan */
      }
    }
  }
  return out;
}

// Token ledger for the last `days` days, grouped by model and by day. Per-file
// aggregates are memoized on (size, mtime), so a reload only re-reads the
// transcripts that actually changed.
export async function ledger({ days = 30 } = {}) {
  const files = listTranscripts();
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
  const byModel = {};
  const byDay = {};
  const byEngine = {};
  let scanned = 0;
  let bytes = 0;
  for (const f of files) {
    const hit = fileAggCache.get(f.path);
    let agg;
    if (hit && hit.mtimeMs === f.mtimeMs && hit.size === f.size) {
      agg = hit.agg;
    } else {
      agg = await aggregateFile(f.path).catch(() => ({ byDayModel: {}, byEngine: {} }));
      fileAggCache.set(f.path, { mtimeMs: f.mtimeMs, size: f.size, agg });
      scanned += 1;
      bytes += f.size;
    }
    for (const [date, models] of Object.entries(agg.byDayModel)) {
      if (date !== "unknown" && date < since) continue;
      for (const [model, a] of Object.entries(models)) {
        byModel[model] = addAgg2(byModel[model] || emptyAgg(), a);
        byDay[date] = addAgg2(byDay[date] || emptyAgg(), a);
      }
    }
    for (const [engine, a] of Object.entries(agg.byEngine)) {
      byEngine[engine] = addAgg2(byEngine[engine] || emptyAgg(), a);
    }
  }
  const total = Object.values(byModel).reduce((acc, a) => addAgg2(acc, a), emptyAgg());
  const today = new Date().toISOString().slice(0, 10);
  return {
    days,
    since,
    files: files.length,
    rescanned: scanned,
    rescannedBytes: bytes,
    total,
    today: byDay[today] || emptyAgg(),
    byModel: Object.entries(byModel)
      .map(([model, a]) => ({ model, ...a, total: totalOf(a) }))
      .sort((x, y) => y.total - x.total),
    byDay: Object.entries(byDay)
      .filter(([d]) => d !== "unknown")
      .map(([date, a]) => ({ date, ...a, total: totalOf(a) }))
      .sort((x, y) => x.date.localeCompare(y.date)),
    byEngine: Object.entries(byEngine).map(([engine, a]) => ({ engine, ...a, total: totalOf(a) })),
  };
}

// Sum two aggregates (the per-file aggregates are cached and must stay
// immutable, so this never mutates its right-hand side).
function addAgg2(into, a) {
  into.turns += a.turns;
  into.input += a.input;
  into.output += a.output;
  into.cacheRead += a.cacheRead;
  into.cacheCreate += a.cacheCreate;
  return into;
}

// ── public entry point ─────────────────────────────────────────────────────

export async function getUsage({ probe = true, days = 30, withLedger = true } = {}) {
  const [claude, codex, grok, ollama, led] = await Promise.all([
    claudeProvider({ probe }).catch((e) => ({ id: "claude", name: "Claude subscription", status: "error", error: String(e.message || e) })),
    codexProvider().catch((e) => ({ id: "codex", name: "ChatGPT plan (Codex)", status: "error", error: String(e.message || e) })),
    grokProvider({ probe }).catch((e) => ({ id: "grok", name: "Grok subscription", status: "error", error: String(e.message || e) })),
    ollamaProvider().catch((e) => ({ id: "ollama", name: "Ollama cloud gateway", status: "error", error: String(e.message || e) })),
    withLedger ? ledger({ days }).catch(() => null) : Promise.resolve(null),
  ]);
  return { at: Date.now(), probed: probe, providers: [claude, codex, grok, ollama], ledger: led };
}
