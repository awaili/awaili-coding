// OpenAI→Anthropic protocol shim: exposes an Anthropic Messages API
// (/v1/messages) locally and forwards to OpenAI-protocol chat/completions
// upstreams. Lets the claude CLI (which only speaks Anthropic) use
// OpenAI-protocol backends — e.g. the HY4 gateway, later xAI Grok — via
// MODEL_ROUTES: `hy4=http://127.0.0.1:11435` injects ANTHROPIC_BASE_URL, and
// claude never knows the difference.
//
// Upstream mapping comes from SHIM_ROUTES (comma-separated):
//   <modelPrefix>=<upstreamBase>[|<apiKey>][|<upstreamModel>]
// First matching prefix wins (same semantics as MODEL_ROUTES). The request's
// model field is sent upstream as `upstreamModel` when given, otherwise
// passed through unchanged.
//
// Translation notes:
// - claude CLI always streams, so the streaming path (OpenAI SSE deltas →
//   Anthropic message_start/content_block_*/message_delta/message_stop) is
//   the load-bearing one; non-streaming is included for curl/debugging.
// - Anthropic tool_use blocks ↔ OpenAI tool_calls; tool_result ↔ role:tool.
// - Image blocks pass through as OpenAI image_url data URLs (upstream may
//   reject them; that error surfaces verbatim).
// - max_tokens maps to OpenAI max_tokens (not max_completion_tokens: the
//   claude CLI caps it anyway and older gateways only know the former).
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.SHIM_PORT) || 11435;
const HOST = process.env.SHIM_HOST || "127.0.0.1";

// ── config ───────────────────────────────────────────────────────────────────
const routes = (process.env.SHIM_ROUTES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((rule) => {
    const eq = rule.indexOf("=");
    if (eq < 0) return null;
    const prefix = rule.slice(0, eq).trim();
    const parts = rule.slice(eq + 1).split("|").map((p) => p.trim());
    return {
      prefix,
      base: parts[0].replace(/\/+$/, ""),
      key: parts[1] || "",
      upstreamModel: parts[2] || "",
    };
  })
  .filter(Boolean);

function routeFor(model) {
  for (const r of routes) if (model && model.startsWith(r.prefix)) return r;
  return null;
}

// ── request translation: anthropic → openai ─────────────────────────────────
function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) return system.map((b) => b?.text || "").join("\n");
  return "";
}

// One OpenAI wire message per Anthropic message, EXCEPT tool_result-only user
// messages which may need splitting into several role:tool entries.
function messagesToOpenAI(messages) {
  const out = [];
  for (const m of messages || []) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
    const text = [];
    const toolCalls = [];
    const toolResults = [];
    const images = [];
    for (const b of blocks) {
      if (b.type === "text") text.push(b.text);
      else if (b.type === "tool_use")
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
        });
      else if (b.type === "tool_result") {
        const content = Array.isArray(b.content)
          ? b.content.map((c) => c?.text || "").join("\n")
          : String(b.content ?? "");
        toolResults.push({ tool_call_id: b.tool_use_id, content, ...(b.is_error ? { _error: true } : {}) });
      } else if (b.type === "image" && b.source?.type === "base64")
        images.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    }
    if (m.role === "assistant") {
      const msg = { role: "assistant", content: text.join("\n") || null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }
    // user: text+images stay one message; each tool_result becomes its own
    // role:tool message (OpenAI requires one per tool_call_id).
    if (text.length || images.length) {
      const parts = [];
      if (text.length) parts.push({ type: "text", text: text.join("\n") });
      parts.push(...images);
      out.push({ role: "user", content: parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts });
    }
    for (const tr of toolResults) out.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
  }
  return out;
}

function toolsToOpenAI(tools) {
  return (tools || []).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } },
  }));
}

// ── response translation: openai → anthropic ─────────────────────────────────
function anthropicId() {
  return "msg-shim-" + Math.random().toString(36).slice(2, 14);
}

function openaiToAnthropic(model, reply, usage) {
  const content = [];
  // Reasoning models (DeepSeek-style) expose thinking in `reasoning`/
  // `reasoning_content` instead of `content` — surface it as a thinking block
  // so the UI shows the reasoning the way gateway thinking models already do.
  const reasoning = reply?.reasoning || reply?.reasoning_content;
  if (typeof reasoning === "string" && reasoning) content.push({ type: "thinking", thinking: reasoning });
  const text = reply?.content;
  if (typeof text === "string" && text) content.push({ type: "text", text });
  const hasTools = Array.isArray(reply?.tool_calls) && reply.tool_calls.length > 0;
  const stopReason = hasTools ? "tool_use" : "end_turn";
  if (hasTools) {
    for (const tc of reply.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function?.arguments || "{}");
      } catch {
        input = { _raw: tc.function?.arguments };
      }
      content.push({ type: "tool_use", id: tc.id || "toolu_" + Math.random().toString(36).slice(2, 12), name: tc.function?.name, input });
    }
  }
  return {
    id: anthropicId(),
    type: "message",
    role: "assistant",
    model,
    content: content.length ? content : [{ type: "text", text: "" }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  };
}

// ── upstream call ────────────────────────────────────────────────────────────
async function upstreamChat(route, openaiBody) {
  const url = route.base + "/chat/completions";
  const headers = { "Content-Type": "application/json" };
  if (route.key) headers["Authorization"] = `Bearer ${route.key}`;
  return fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(openaiBody),
    signal: AbortSignal.timeout(Number(process.env.SHIM_UPSTREAM_TIMEOUT_MS) || 300000),
  });
}

async function upstreamError(res) {
  let detail = "";
  try {
    const j = await res.json();
    detail = typeof j.error === "string" ? j.error : j.error?.message || JSON.stringify(j).slice(0, 300);
  } catch {
    detail = (await res.text().catch(() => "")).slice(0, 300);
  }
  return new Error(`upstream ${res.status}: ${detail || res.statusText}`);
}

// ── streaming translation ────────────────────────────────────────────────────
// Emits Anthropic SSE events by consuming the OpenAI SSE stream. Tool-call
// argument fragments arrive as delta.tool_calls[index].function.arguments and
// must be accumulated per index before the content_block can be closed.
async function streamToAnthropic(res, model, clientRes) {
  const sse = (event, data) => {
    clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  clientRes.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  sse("message_start", {
    type: "message_start",
    message: {
      id: anthropicId(), type: "message", role: "assistant", model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  });

  let open = null; // {kind: 'thinking'|'text', index} — the currently-open block
  // tool calls in progress: OpenAI tool-call index → {id, name, args, blockIndex}
  const tools = new Map();
  let nextBlock = 0;
  let finishReason = null;

  // Blocks arrive in order (thinking → text → tool_use); only one non-tool
  // block is open at a time. Opening a different kind closes the previous.
  const openBlock = (kind) => {
    if (open && open.kind === kind) return open.index;
    if (open) closeBlock();
    const index = nextBlock++;
    sse("content_block_start", {
      type: "content_block_start",
      index,
      content_block: kind === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" },
    });
    open = { kind, index };
    return index;
  };
  function closeBlock() {
    if (!open) return;
    sse("content_block_stop", { type: "content_block_stop", index: open.index });
    open = null;
  }

  try {
    for await (const chunk of sseChunks(res)) {
      if (chunk.usage) Object.assign(usage, chunk.usage);
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      const reasoning = delta.reasoning || delta.reasoning_content;
      if (typeof reasoning === "string" && reasoning) {
        const index = openBlock("thinking");
        sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: reasoning } });
      }
      if (typeof delta.content === "string" && delta.content) {
        const index = openBlock("text");
        sse("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: delta.content } });
      }
      for (const tc of delta.tool_calls || []) {
        closeBlock(); // tool blocks come after text
        const idx = tc.index ?? 0;
        let t = tools.get(idx);
        if (!t) {
          t = { id: tc.id || "toolu_" + idx + "-" + Math.random().toString(36).slice(2, 10), name: "", args: "", blockIndex: -1 };
          tools.set(idx, t);
        }
        if (tc.id) t.id = tc.id;
        if (tc.function?.name) t.name += tc.function.name;
        if (tc.function?.arguments) t.args += tc.function.arguments;
        // OpenAI sends the name/id in the first fragment only — open the block
        // once we can name it, then stream argument fragments as they come.
        if (t.blockIndex < 0 && t.name) {
          t.blockIndex = nextBlock++;
          sse("content_block_start", {
            type: "content_block_start", index: t.blockIndex,
            content_block: { type: "tool_use", id: t.id, name: t.name, input: {} },
          });
        }
        if (t.blockIndex >= 0 && tc.function?.arguments) {
          sse("content_block_delta", {
            type: "content_block_delta", index: t.blockIndex,
            delta: { type: "input_json_delta", partial_json: tc.function.arguments },
          });
        }
      }
    }

    closeBlock();
    // Any tool that never got a name (malformed upstream) still needs a block.
    for (const t of tools.values()) {
      if (t.blockIndex < 0) {
        t.blockIndex = nextBlock++;
        sse("content_block_start", {
          type: "content_block_start", index: t.blockIndex,
          content_block: { type: "tool_use", id: t.id, name: t.name || "unknown", input: {} },
        });
      }
      sse("content_block_stop", { type: "content_block_stop", index: t.blockIndex });
    }

    const stopReason = tools.size > 0 ? "tool_use" : finishReason === "length" ? "max_tokens" : "end_turn";
    sse("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: usage.prompt_tokens || 0, output_tokens: usage.completion_tokens || 0 },
    });
    sse("message_stop", { type: "message_stop" });
  } catch (err) {
    // Everything after writeHead must be exception-safe: an uncaught throw here
    // would kill the whole shim process and every other in-flight stream with it.
    try {
      closeBlock();
      sse("error", { type: "error", error: { type: "upstream_error", message: String(err.message || err) } });
    } catch {
      /* response already gone */
    }
  } finally {
    clientRes.end();
  }
}

// Iterate OpenAI SSE `data:` payloads as parsed objects (stops at [DONE]).
async function* sseChunks(res) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        yield JSON.parse(data);
      } catch {
        /* skip junk */
      }
    }
  }
}

// ── server ───────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  // Anthropic error shape, so the claude CLI surfaces it cleanly.
  const sendErr = (code, type, message) => send(code, { type: "error", error: { type, message } });

  if (req.method === "POST" && (req.url === "/v1/messages" || req.url.startsWith("/v1/messages?"))) {
    let reqBody;
    try {
      reqBody = JSON.parse(body || "{}");
    } catch {
      return sendErr(400, "invalid_request_error", "request body is not valid JSON");
    }
    const route = routeFor(reqBody.model);
    if (!route) return sendErr(404, "not_found_error", `no SHIM_ROUTES prefix matches model "${reqBody.model}"`);

    const openaiBody = {
      model: route.upstreamModel || reqBody.model,
      messages: [
        ...(() => {
          const s = systemText(reqBody.system);
          return s ? [{ role: "system", content: s }] : [];
        })(),
        ...messagesToOpenAI(reqBody.messages),
      ],
      stream: !!reqBody.stream,
      // Ask OpenAI-compat upstreams to include a final usage chunk (spec field;
      // upstreams that don't know it just ignore it).
      ...(reqBody.stream ? { stream_options: { include_usage: true } } : {}),
    };
    if (reqBody.max_tokens) openaiBody.max_tokens = reqBody.max_tokens;
    if (typeof reqBody.temperature === "number") openaiBody.temperature = reqBody.temperature;
    const openaiTools = toolsToOpenAI(reqBody.tools);
    if (openaiTools.length) openaiBody.tools = openaiTools;
    if (reqBody.tool_choice?.type === "auto") openaiBody.tool_choice = "auto";
    else if (reqBody.tool_choice?.type === "any" || reqBody.tool_choice?.type === "tool")
      openaiBody.tool_choice = { type: "function", function: { name: reqBody.tool_choice.name } };

    let upstream;
    try {
      upstream = await upstreamChat(route, openaiBody);
    } catch (e) {
      return sendErr(502, "api_error", `upstream unreachable: ${e.message}`);
    }
    if (!upstream.ok) {
      const err = await upstreamError(upstream);
      return sendErr(upstream.status === 401 || upstream.status === 403 ? "authentication_error" : "api_error", err.message);
    }

    if (reqBody.stream) return streamToAnthropic(upstream, reqBody.model, res);
    let data;
    try {
      data = await upstream.json();
    } catch (e) {
      return sendErr(502, "api_error", `upstream returned invalid JSON: ${e.message}`);
    }
    if (data.error) return sendErr(502, "api_error", typeof data.error === "string" ? data.error : data.error?.message || "upstream error");
    const reply = data.choices?.[0]?.message || {};
    return send(200, openaiToAnthropic(reqBody.model, reply, data.usage));
  }

  // claude CLI may probe this for token accounting — an estimate is fine.
  if (req.method === "POST" && req.url === "/v1/messages/count_tokens") {
    try {
      const reqBody = JSON.parse(body || "{}");
      const text = JSON.stringify(reqBody.messages || "");
      return send(200, { input_tokens: Math.ceil(text.length / 4) });
    } catch {
      return send(200, { input_tokens: 0 });
    }
  }

  if (req.method === "GET" && (req.url === "/" || req.url === "/healthz")) {
    return send(200, { ok: true, routes: routes.map((r) => ({ prefix: r.prefix, base: r.base, model: r.upstreamModel || "(passthrough)" })) });
  }

  sendErr(404, "not_found_error", `no such endpoint: ${req.method} ${req.url}`);
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`[openai-shim] listening on ${HOST}:${PORT}`);
  for (const r of routes) console.log(`[openai-shim]   ${r.prefix}* -> ${r.base}${r.upstreamModel ? ` (model ${r.upstreamModel})` : ""}${r.key ? " [keyed]" : ""}`);
});
