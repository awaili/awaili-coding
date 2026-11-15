import { useCallback, useEffect, useMemo, useState } from "react";

// Usage panel: the official quota/usage numbers for every model channel this
// server routes to, in one place, plus a local ledger of what we actually
// spent.
//
// Everything comes from GET /api/usage (server/usage.js):
//   • claude / codex / grok — each subscription's own quota API, plus the
//     rate-limit response headers for the windows those APIs don't expose
//   • ollama cloud gateway — no usage API exists, so the card shows the
//     account/plan only and says so
//   • ledger — token totals scanned out of the session transcripts
//
// Form choices (dataviz order: pick the form first, color last):
//   • a quota is a bounded ratio   → horizontal progress bar, status color
//     paired with the number so nothing is color-alone
//   • ledger totals are headlines  → stat tiles, no chart
//   • daily spend is one series    → column chart, single accent hue, no legend
//   • per-model detail             → table, which doubles as the chart's
//     accessible alternative view
const STATUS = {
  ok: { label: "ok", cls: "ok" },
  stale: { label: "stale", cls: "warn" },
  "no-quota-api": { label: "no quota API", cls: "muted" },
  unavailable: { label: "not configured", cls: "muted" },
  error: { label: "failed", cls: "err" },
};

function fmtTokens(n) {
  if (!n) return "0";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

function fmtInt(n) {
  return (n || 0).toLocaleString("en-US");
}

// Time left in the window — the number that actually matters when a quota is
// running out — with the absolute timestamp alongside it.
function fmtReset(sec) {
  if (!sec) return null;
  const ms = sec * 1000 - Date.now();
  const abs = new Date(sec * 1000).toLocaleString("en-GB", { hour12: false });
  if (ms <= 0) return `reset (${abs})`;
  const h = Math.floor(ms / 3600000);
  const m = Math.round((ms % 3600000) / 60000);
  return `resets in ${h > 0 ? `${h}h ` : ""}${m}m (${abs})`;
}

// Status color for a quota bar: <60% ok, <85% warning, else critical. Color
// only reinforces — the percentage is always right next to it.
function levelOf(pct) {
  if (pct == null) return "muted";
  if (pct >= 85) return "err";
  if (pct >= 60) return "warn";
  return "ok";
}

function QuotaBar({ w }) {
  const pct = typeof w.usedPercent === "number" ? Math.max(0, Math.min(100, w.usedPercent)) : null;
  const lvl = levelOf(pct);
  const reset = fmtReset(w.resetAt);
  return (
    <div className="ug-win">
      <div className="ug-win-head">
        <span className="ug-win-label">{w.label}</span>
        <span className={`ug-win-pct ${lvl}`}>
          {pct == null ? "—" : `${pct < 1 && pct > 0 ? pct.toFixed(2) : pct.toFixed(1)}%`}
        </span>
      </div>
      <div className="ug-track" role="img" aria-label={`${w.label}: ${pct ?? "unknown"}% used`}>
        <div className={`ug-fill ${lvl}`} style={{ width: `${pct == null ? 0 : Math.max(pct, pct > 0 ? 1.5 : 0)}%` }} />
      </div>
      <div className="ug-win-foot">
        {w.limit ? (
          <span>
            {fmtTokens(w.used)} / {fmtTokens(w.limit)}
          </span>
        ) : (
          <span />
        )}
        {reset ? <span>{reset}</span> : <span />}
      </div>
    </div>
  );
}

function ProviderCard({ p }) {
  const st = STATUS[p.status] || { label: p.status || "unknown", cls: "muted" };
  const [rawOpen, setRawOpen] = useState(false);
  return (
    <div className="ug-card">
      <div className="ug-card-head">
        <span className="ug-card-name">{p.name}</span>
        <span className={`ug-pill ${st.cls}`}>{st.label}</span>
      </div>
      <div className="ug-card-sub">{p.detail}</div>
      {p.error && <div className="ug-err">{p.error}</div>}
      {(p.windows || []).length > 0 ? (
        <div className="ug-wins">
          {p.windows.map((w) => (
            <QuotaBar key={w.id} w={w} />
          ))}
        </div>
      ) : (
        !p.error && <div className="ug-nowin">no window quota reported</div>
      )}
      {(p.facts || []).length > 0 && (
        <div className="ug-facts">
          {p.facts.map((f) => (
            <span className="ug-chip" key={f.label}>
              <b>{f.label}</b> {f.value}
            </span>
          ))}
        </div>
      )}
      {(p.notes || []).map((n, i) => (
        <div className="ug-note" key={i}>
          {n}
        </div>
      ))}
      <div className="ug-src">source: {p.source}</div>
      {p.extra && (
        <>
          <button className="ug-raw-btn" onClick={() => setRawOpen((v) => !v)}>
            {rawOpen ? "hide raw response" : "raw API response"}
          </button>
          {rawOpen && <pre className="ug-raw">{JSON.stringify(p.extra, null, 2)}</pre>}
        </>
      )}
    </div>
  );
}

// Single-series time columns: one hue, 2px gaps, rounded data ends, hover
// tooltip per column. The per-model table below is its alternative view.
function DayBars({ byDay, days }) {
  const series = useMemo(() => {
    // Fill the gaps, otherwise idle days collapse and the shape lies.
    const map = new Map(byDay.map((d) => [d.date, d]));
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      out.push(map.get(date) || { date, total: 0, input: 0, output: 0, cacheRead: 0, turns: 0 });
    }
    return out;
  }, [byDay, days]);
  const max = Math.max(1, ...series.map((d) => d.total));
  return (
    <div className="ug-chart">
      <div className="ug-bars">
        {series.map((d) => (
          <div
            className="ug-bar-slot"
            key={d.date}
            title={`${d.date}\n${fmtInt(d.total)} tokens total\nin ${fmtInt(d.input)} · out ${fmtInt(d.output)} · cache read ${fmtInt(d.cacheRead)}\n${d.turns} turns`}
          >
            <div className="ug-bar" style={{ height: `${(d.total / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="ug-axis">
        <span>{series[0]?.date.slice(5)}</span>
        <span className="ug-axis-max">peak {fmtTokens(max)}</span>
        <span>{series[series.length - 1]?.date.slice(5)}</span>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }) {
  return (
    <div className="ug-tile">
      <div className="ug-tile-label">{label}</div>
      <div className="ug-tile-value">{value}</div>
      {sub && <div className="ug-tile-sub">{sub}</div>}
    </div>
  );
}

export default function Usage({ onClose }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [days, setDays] = useState(30);

  const load = useCallback(
    async ({ force = false, probe = true, d = days } = {}) => {
      setLoading(true);
      setErr("");
      try {
        const qs = new URLSearchParams({ days: String(d), probe: probe ? "1" : "0" });
        if (force) qs.set("force", "1");
        const res = await fetch(`/api/usage?${qs}`, { credentials: "same-origin" });
        const j = await res.json();
        if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
        setData(j);
      } catch (e) {
        setErr(String(e.message || e));
      } finally {
        setLoading(false);
      }
    },
    [days],
  );

  useEffect(() => {
    load({ d: days });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const led = data?.ledger;

  return (
    <div className="ug-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ug-panel">
        <div className="ug-head">
          <span className="ug-title">Usage</span>
          <span className="ug-head-sub">
            {data ? `updated ${new Date(data.at).toLocaleTimeString("en-GB", { hour12: false })}` : "loading…"}
          </span>
          <span className="spacer" />
          <div className="ug-days">
            {[7, 14, 30].map((d) => (
              <button key={d} className={d === days ? "active" : ""} onClick={() => setDays(d)}>
                {d}d
              </button>
            ))}
          </div>
          <button disabled={loading} onClick={() => load({ force: true })}>
            {loading ? "refreshing…" : "Refresh"}
          </button>
          <button className="ug-close" onClick={onClose}>
            ✕ close
          </button>
        </div>

        {err && <div className="ug-error">{err}</div>}

        <div className="ug-body">
          <div className="ug-section-title">Subscription quotas (each provider&apos;s own API)</div>
          <div className="ug-grid">
            {(data?.providers || []).map((p) => (
              <ProviderCard key={p.id} p={p} />
            ))}
            {!data && !err && <div className="ug-nowin">querying the provider APIs…</div>}
          </div>

          <div className="ug-section-title">
            Local ledger (last {days} days)
            <span className="ug-section-note">
              Scanned from the Claude Code transcripts in ~/.claude/projects: claude-engine turns (including every
              gateway model) carry their own token counts, while codex / grok turns are recorded by this server. Note
              that it also covers sessions run directly from the CLI on this box.
            </span>
          </div>
          {led ? (
            <>
              <div className="ug-tiles">
                <Tile
                  label="tokens today"
                  value={fmtTokens(led.today.input + led.today.output + led.today.cacheRead + led.today.cacheCreate)}
                  sub={`${fmtInt(led.today.turns)} turns`}
                />
                <Tile
                  label={`tokens, last ${days}d`}
                  value={fmtTokens(led.total.input + led.total.output + led.total.cacheRead + led.total.cacheCreate)}
                  sub={`${fmtInt(led.total.turns)} turns`}
                />
                <Tile
                  label="input / output"
                  value={`${fmtTokens(led.total.input)} / ${fmtTokens(led.total.output)}`}
                  sub={`cache read ${fmtTokens(led.total.cacheRead)}`}
                />
                <Tile label="transcripts" value={fmtInt(led.files)} sub={`${led.rescanned} re-scanned now`} />
              </div>
              <DayBars byDay={led.byDay} days={days} />
              <table className="ug-table">
                <thead>
                  <tr>
                    <th>model</th>
                    <th>share</th>
                    <th>total</th>
                    <th>input</th>
                    <th>output</th>
                    <th>cache read</th>
                    <th>turns</th>
                  </tr>
                </thead>
                <tbody>
                  {led.byModel.map((m) => {
                    const top = led.byModel[0]?.total || 1;
                    return (
                      <tr key={m.model}>
                        <td className="ug-model">{m.model}</td>
                        <td className="ug-share">
                          <div className="ug-share-track">
                            <div className="ug-share-fill" style={{ width: `${Math.max(1.5, (m.total / top) * 100)}%` }} />
                          </div>
                        </td>
                        <td>{fmtTokens(m.total)}</td>
                        <td>{fmtTokens(m.input)}</td>
                        <td>{fmtTokens(m.output)}</td>
                        <td>{fmtTokens(m.cacheRead)}</td>
                        <td>{fmtInt(m.turns)}</td>
                      </tr>
                    );
                  })}
                  {!led.byModel.length && (
                    <tr>
                      <td colSpan={7} className="ug-nowin">
                        nothing recorded in this window
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </>
          ) : (
            !err && <div className="ug-nowin">building the ledger…</div>
          )}
        </div>
      </div>
    </div>
  );
}
