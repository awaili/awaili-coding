// Live model catalog for the Ollama gateway: which models exist, and which of
// them accept image (vision) input.
//
// Capability is READ FROM THE GATEWAY, not hand-maintained. Both endpoints
// report a `capabilities` array that includes "vision" when the model takes
// image blocks:
//   - GET  /api/tags  — locally available (pulled) models. Each entry already
//     carries `capabilities`, so no extra request is needed for these.
//   - POST /api/show  — cloud models aren't always enumerated by /api/tags, so
//     each configured AVAILABLE_MODELS candidate that tags didn't cover is
//     probed. The response carries `capabilities` too.
//
// Cached with a TTL because Session.send() consults it for every message that
// carries attachments; probing per message would be wasteful. A hand-written
// list is still honoured, but only as an override (see config.visionModels /
// visionModelsExclude) — the gateway is the source of truth.
import { config } from "./config.js";

const TTL_MS = Number(process.env.MODEL_CATALOG_TTL_MS) || 5 * 60 * 1000;

function gatewayBase() {
  return (config.ollamaBaseUrl || config.anthropicBaseUrl).replace(/\/+$/, "");
}

async function fetchTaggedModels(base) {
  const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`ollama /api/tags → ${res.status}`);
  const j = await res.json();
  return (j.models || [])
    .filter((m) => m && m.name)
    .map((m) => ({
      name: m.name,
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
    }));
}

async function probeModel(base, name) {
  try {
    const res = await fetch(`${base}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return { name, capabilities: Array.isArray(j.capabilities) ? j.capabilities : [] };
  } catch {
    return null; // candidate unreachable — skip it
  }
}

// Model names match on a `:` tag boundary, so an alias like `gemma4:cloud`
// still matches a listed `gemma4:31b-cloud` and vice versa. This is the same
// semantics the frontend used when it owned this check.
export function matchesModel(a, b) {
  return a === b || a.startsWith(b + ":") || b.startsWith(a + ":");
}

export function isVisionCapable(name, visionModels) {
  return visionModels.some((v) => matchesModel(name, v));
}

let cache = { at: 0, data: null, inflight: null };

async function build() {
  const base = gatewayBase();
  let tagged = [];
  try {
    tagged = await fetchTaggedModels(base);
  } catch {
    /* gateway unreachable — fall through to the configured list */
  }
  const have = new Set(tagged.map((m) => m.name));
  const probed = (
    await Promise.all(
      config.availableModels.filter((n) => !have.has(n)).map((n) => probeModel(base, n)),
    )
  ).filter(Boolean);
  const entries = [...tagged, ...probed];

  const detected = entries
    .filter((e) => e.capabilities.includes("vision"))
    .map((e) => e.name);
  // Detected ∪ force-include, then minus force-exclude. Excludes are applied
  // last so they win over both — detection can only trust what it's told, and
  // a model can claim "vision" while its gateway rejects image blocks anyway.
  const visionModels = [...new Set([...detected, ...config.visionModels])].filter(
    (v) => !config.visionModelsExclude.some((x) => matchesModel(v, x)),
  );

  const models = [...new Set(entries.map((e) => e.name))];
  if (!models.length) {
    // Nothing discovered — serve the configured list so the dropdown is never
    // empty (matches the pre-catalog fallback behavior).
    return { models: config.availableModels, visionModels, source: "config" };
  }
  return { models, visionModels, source: "ollama" };
}

export async function getCatalog({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  // Collapse concurrent rebuilds so a burst of sends doesn't each probe.
  if (!cache.inflight) {
    cache.inflight = build().then(
      (data) => {
        cache = { at: Date.now(), data, inflight: null };
        return data;
      },
      (err) => {
        cache.inflight = null;
        throw err;
      },
    );
  }
  try {
    return await cache.inflight;
  } catch {
    // Gateway unreachable: still hand callers a usable vision set rather than
    // throwing into the send path.
    return {
      models: config.availableModels,
      visionModels: config.visionModels,
      source: "config",
    };
  }
}

// Does this model accept image blocks? Consulted by Session.send() before it
// builds an image content block.
export async function isVisionModel(name) {
  const { visionModels } = await getCatalog();
  return isVisionCapable(name, visionModels);
}
