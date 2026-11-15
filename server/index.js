import express from "express";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";
import { config, routeForModel } from "./config.js";
import { getCatalog, matchesModel } from "./catalog.js";
import { attachWebSocket } from "./ws.js";
import { attachTerm } from "./term.js";
import { internalToken } from "./internal-token.js";
import filesRouter from "./files.js";
import skillsRouter from "./skills.js";
import { confineCwd } from "./util.js";
import { readTranscriptImage } from "./sessions.js";
import {
  requireAuth,
  isAuthed,
  checkPassword,
  createSession,
  setSessionCookie,
} from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const isProd = process.env.NODE_ENV === "production";

const app = express();
// Match nginx's client_max_body_size (20m). Express's default body limit is
// only 100kb, so without this, saving any file whose content pushes the JSON
// body past ~100kb makes express.json() throw PayloadTooLargeError — and with
// no JSON error handler below, Express emits its HTML error page, so the
// frontend's `await res.json()` throws "Unexpected token '<', \"<!DOCTYPE ...\"".
app.use(express.json({ limit: "20mb" }));

// Trust proxy headers (X-Forwarded-Proto) so cookie `Secure` is set correctly
// when served behind a TLS-terminating reverse proxy.
app.set("trust proxy", true);

// --- Public auth endpoints (must be registered before requireAuth) ---
// Simple per-IP login throttle: a small in-memory failure counter with
// exponential lockout. Prevents brute-forcing a weak operator-set password.
const loginFails = new Map(); // ip -> { count, lockedUntil }
const LOCK_BASE_MS = 1000;
const LOCK_MAX_MS = 60_000;
function loginRateCheck(ip) {
  const now = Date.now();
  const f = loginFails.get(ip);
  if (f && f.lockedUntil && f.lockedUntil > now) return false;
  return true;
}
function loginFail(ip) {
  const f = loginFails.get(ip) || { count: 0, lockedUntil: 0 };
  f.count += 1;
  f.lockedUntil = Date.now() + Math.min(LOCK_MAX_MS, LOCK_BASE_MS * 2 ** Math.min(f.count, 10));
  loginFails.set(ip, f);
}
function loginSuccess(ip) {
  loginFails.delete(ip);
}
const secureCookie = (req) => req.secure || req.headers["x-forwarded-proto"] === "https";

app.post("/api/login", (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || "?";
  if (!loginRateCheck(ip)) {
    res.setHeader("Retry-After", "60");
    return res.status(429).json({ error: "too many attempts, try again shortly" });
  }
  if (!checkPassword(req.body?.password)) {
    loginFail(ip);
    return res.status(401).json({ error: "invalid password" });
  }
  loginSuccess(ip);
  setSessionCookie(res, createSession(), secureCookie(req));
  res.json({ ok: true });
});

app.post("/api/logout", (_req, res) => {
  setSessionCookie(res, null);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  res.json({ ok: isAuthed(req) });
});

// --- Everything else under /api requires a valid session cookie ---
app.use("/api", requireAuth);

app.use("/api", filesRouter);
app.use("/api", skillsRouter);

// Serve a single image block from a session transcript as raw bytes, so resumed
// conversations can render past images via <img src> without embedding large
// base64 in the history WS payload. Same-origin + cookie auth applies.
// sessionId/uuid are validated against a strict charset: they're joined into a
// path under ~/.claude/projects, so without this `session=../../foo` would read
// arbitrary .jsonl files.
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
app.get("/api/transcript/image", (req, res) => {
  const cwd = confineCwd(String(req.query.cwd || ""));
  const session = String(req.query.session || "");
  const uuid = String(req.query.uuid || "");
  const idx = Number.parseInt(req.query.idx, 10);
  if (!cwd || !ID_RE.test(session) || !ID_RE.test(uuid) || Number.isNaN(idx) || idx < 0) {
    return res.status(400).type("text/plain").send("missing or invalid cwd, session, uuid, or idx");
  }
  const img = readTranscriptImage(cwd, session, uuid, idx);
  if (!img) return res.status(404).type("text/plain").send("image not found");
  res.setHeader("Content-Type", img.mediaType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(img.buffer);
});

// Health/diagnostics. NEVER spread `config` here — it carries authSecret (the
// HMAC key signing session cookies) and authPassword, so leaking it lets any
// authed user forge a session cookie for anyone. Expose only safe, non-secret
// fields explicitly.
app.get("/api/health", (_req, res) =>
  res.json({
    ok: true,
    port: config.port,
    anthropicModel: config.anthropicModel,
    anthropicBaseUrl: config.anthropicBaseUrl,
    ollamaBaseUrl: config.ollamaBaseUrl,
    availableModels: config.availableModels,
    workspaceRoot: config.workspaceRoot,
    skipPermissions: config.skipPermissions,
  }),
);

// Models the UI offers in its dropdown, plus which of them accept images.
// Discovery + capability detection live in catalog.js (which caches); the
// configured AVAILABLE_MODELS list is only the fallback, and the configured
// default model is always kept selectable even if the gateway omits it.
// `describeModel` is the vision model the server transcribes images with when
// the active model can't take them (see sessions.js / vision.js).
app.get("/api/models", async (_req, res) => {
  const { models: discovered, visionModels, source } = await getCatalog();
  let models = discovered;
  const has = new Set(models);
  if (config.anthropicModel && !has.has(config.anthropicModel)) {
    models = [config.anthropicModel, ...models];
  }
  // Per-model capability descriptors for the dropdown (web/src
  // ModelPicker.jsx): vision = accepts image attachments (catalog's vision
  // set, gateway-sourced); imagegen/video = can GENERATE images/video — the
  // engine-routed CLI harnesses' built-in tools (grok's Imagine suite has
  // image+video, codex's imagegen skill images only), both drawing from the
  // subscription plan, not API billing. source = which subscription/channel
  // the model rides on, shown as the dropdown's group headers.
  const capabilities = {};
  for (const m of models) {
    const route = routeForModel(m);
    const engine = route.engine;
    let source = "本地网关模型";
    if (route.native) source = "Claude Pro 订阅";
    else if (engine === "codex") source = "ChatGPT 套餐（Codex）";
    else if (engine === "grok") source = "Grok 月包订阅";
    else if (route.baseUrl && route.baseUrl !== (config.ollamaBaseUrl || config.anthropicBaseUrl)) source = "外部网关";
    capabilities[m] = {
      vision: visionModels.some((v) => matchesModel(m, v)),
      imagegen: engine === "grok" || engine === "codex",
      video: engine === "grok",
      source,
    };
  }
  res.json({
    default: config.anthropicModel,
    models,
    visionModels,
    capabilities,
    describeModel: config.visionDescribeModel,
    source,
  });
});

if (isProd) {
  const dist = resolve(root, "web", "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    // SPA fallback — but only for non-/api paths, so an unknown /api/* route
    // returns a proper 404 JSON instead of index.html (200, text/html).
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(resolve(dist, "index.html")));
  } else {
    app.get("/", (_req, res) =>
      res.type("text/plain").send("Build the frontend first: npm run build"),
    );
  }
}

// Last-resort error handler. Without this, a thrown error (e.g. express.json
// rejecting an oversized body) falls through to Express's default HTML error
// page, which starts with <!DOCTYPE html> and makes the frontend's
// `res.json()` throw a confusing "Unexpected token '<'" instead of surfacing
// the real problem. Always reply with JSON for /api routes.
app.use((err, req, res, _next) => {
  if (req.path.startsWith("/api")) {
    const status = err.status || 500;
    res.status(status).json({ error: err.message || `HTTP ${status}` });
    return;
  }
  res.status(err.status || 500).type("text/plain").send(err.message || "Internal Server Error");
});

const server = app.listen(config.port, config.host, () => {
  // eslint-disable-next-line no-console
  console.log(
    `coding-ui server on http://localhost:${config.port} (model=${config.anthropicModel} via ${config.anthropicBaseUrl}) [${isProd ? "prod" : "dev"}]`,
  );
});

const wsServer = attachWebSocket(server);
const { term: termServer, shell: shellServer } = attachTerm(server);

// Constant-time comparison for the internal WS token (used by the spawned
// TUI). Avoids a timing-leakable `===` string compare; the token is ephemeral
// and local-only, but defense-in-depth is cheap.
function tokenOk(token) {
  if (!token || typeof token !== "string") return false;
  const a = Buffer.from(token);
  const b = Buffer.from(internalToken);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Reject cross-origin WebSocket upgrades (WS CSRF defense). Browser cookie auth
// is SameSite=Lax, which already blocks most cross-site WS, but an explicit
// Origin check closes the gap regardless of cookie attributes. The token path
// (local TUI on 127.0.0.1) has no Origin header and is allowed separately.
function originOk(req, url) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client (e.g. the local TUI)
  try {
    const o = new URL(origin);
    const host = req.headers.host || "";
    // Allow same-origin only. ws/wss scheme matches the incoming request.
    return o.host === host;
  } catch {
    return false;
  }
}

// Single upgrade dispatcher: routes /ws, /term, /shell to their WSS. All WSS
// run in noServer mode — without this dispatcher none would receive upgrades.
server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://dummy");
  } catch {
    socket.destroy();
    return;
  }
  const pathname = url.pathname;

  if (!originOk(req, url)) {
    socket.destroy();
    return;
  }

  // Auth: a valid session cookie (browser), OR the server-internal token,
  // which authorizes only /ws and is used by the locally-spawned TUI (it has
  // no browser cookie). /term and /shell stay cookie-gated so the token can't
  // be used to spawn PTYs.
  const hasToken = pathname === "/ws" && tokenOk(url.searchParams.get("token"));
  if (!isAuthed(req) && !hasToken) {
    socket.destroy();
    return;
  }

  const target =
    pathname === "/ws" ? wsServer
    : pathname === "/term" ? termServer
    : pathname === "/shell" ? shellServer
    : null;
  if (!target) {
    socket.destroy();
    return;
  }
  target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
});