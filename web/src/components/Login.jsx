import { useState } from "react";

// Single-password login. Posts to /api/login, which sets the HttpOnly session
// cookie; on success the parent flips to the main app. The cookie is HttpOnly
// so JS never touches it — the browser just sends it on subsequent requests.
export default function Login({ onSuccess }) {
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pw }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        onSuccess();
      } else {
        setErr(j.error || "login failed");
      }
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1>Coding UI</h1>
        <p className="login-sub">Enter your password to continue.</p>
        <input
          type="password"
          className="login-input"
          placeholder="Password"
          value={pw}
          autoFocus
          onChange={(e) => setPw(e.target.value)}
          disabled={busy}
        />
        {err && <div className="login-err">{err}</div>}
        <button type="submit" className="login-btn" disabled={busy || !pw}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}