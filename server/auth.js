import { randomBytes, createHmac, timingSafeEqual, createHash } from "node:crypto";
import { config } from "./config.js";

// Session cookie auth. A logged-in client holds a cookie `session=<sid>.<sig>`
// where sig = HMAC-SHA256(secret, sid). Verification is stateless (no server
// session store) and constant-time. The cookie is HttpOnly + SameSite=Lax.

const COOKIE_NAME = "session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, in seconds

const SECRET = config.authSecret || randomBytes(32).toString("hex");
if (!config.authSecret) {
  // eslint-disable-next-line no-console
  console.warn("[auth] AUTH_SECRET not set — using an ephemeral secret; sessions reset on restart.");
}

// Resolve the login password. If AUTH_PASSWORD is empty, generate a random one
// once per process and log it so the operator can actually log in. This
// guarantees anonymous access is never possible.
let password = config.authPassword;
if (!password) {
  password = randomBytes(12).toString("base64url");
  // eslint-disable-next-line no-console
  console.log(`[auth] No AUTH_PASSWORD set — generated a temporary login password: ${password}`);
}

export function getPassword() {
  return password;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function sign(sid) {
  return createHmac("sha256", SECRET).update(sid).digest("base64url");
}

export function createSession() {
  const sid = randomBytes(24).toString("base64url");
  return `${sid}.${sign(sid)}`;
}

// Returns the sid if the token is valid, otherwise null.
export function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const sid = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = sign(sid);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return sid;
}

function tokenFromRequest(req) {
  const cookies = parseCookies(req.headers?.cookie);
  return cookies[COOKIE_NAME] || null;
}

export function isAuthed(req) {
  return verifyToken(tokenFromRequest(req)) !== null;
}

// Express middleware: deny with 401 JSON if not authed.
export function requireAuth(req, res, next) {
  if (isAuthed(req)) return next();
  res.status(401).json({ error: "unauthorized" });
}

// Set/Clear the session cookie on a response. Add `Secure` when the request is
// served over TLS (directly or behind a proxy that set X-Forwarded-Proto) so the
// cookie can't be intercepted by an HTTP downgrade.
export function setSessionCookie(res, token, secure = false) {
  const flags = `HttpOnly; SameSite=Lax; Path=/${secure ? "; Secure" : ""}`;
  const val = token
    ? `${COOKIE_NAME}=${token}; ${flags}; Max-Age=${COOKIE_MAX_AGE}`
    : `${COOKIE_NAME}=; ${flags}; Max-Age=0`;
  res.setHeader("Set-Cookie", val);
}

// Constant-time password comparison. Both inputs are hashed to fixed-length
// digests before comparing, so the comparison time doesn't leak the password
// length (the previous early `length !== length` return did).
export function checkPassword(given) {
  if (!given) return false;
  const a = createHash("sha256").update(String(given)).digest();
  const b = createHash("sha256").update(password).digest();
  return timingSafeEqual(a, b);
}