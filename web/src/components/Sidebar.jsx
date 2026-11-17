// Compact cumulative-metrics string for a sidebar row: cost · duration ·
// turns. Returns "" when the session has no metrics yet (no completed turn).
function sessionMeta(metrics) {
  if (!metrics) return "";
  const parts = [];
  if (metrics.totalCostUsd != null) {
    const usd = metrics.totalCostUsd;
    parts.push(`$${usd < 0.01 ? usd.toFixed(4) : usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`);
  }
  if (metrics.totalDurationMs != null) {
    const ms = metrics.totalDurationMs;
    if (ms < 1000) parts.push(`${ms}ms`);
    else if (ms < 60000) parts.push(`${(ms / 1000).toFixed(0)}s`);
    else parts.push(`${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`);
  }
  if (metrics.totalTurns != null) parts.push(`${metrics.totalTurns}t`);
  return parts.join(" · ");
}

// Human byte count for the transcript-size column (b / kb / mb).
function fmtBytes(n) {
  if (!n || n < 0) return "";
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}kb`;
  return `${(n / (1024 * 1024)).toFixed(1)}mb`;
}

// "just now" / "5m ago" / "3h ago" / "2d ago" for the last-activity column.
function relTime(iso) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// Context-occupancy badge for a sidebar row, only when it's high (≥75% of the
// model's window per the server's context-high threshold). Below that the
// metrics bar in the chat shows the number; the sidebar stays quiet.
function ctxBadge(s) {
  const pct = s?.context?.pct;
  if (!pct || pct < 0.75) return null;
  return (
    <span
      className={"ctx-badge" + (pct >= 0.9 ? " critical" : "")}
      title={`context ~${Math.round(pct * 100)}% full — compact this chat`}
    >
      ~{Math.round(pct * 100)}% ctx
    </span>
  );
}

export default function Sidebar({
  sessions,
  activeId,
  metricsBy,
  onPick,
  onNew,
  onRemove,
  onStop,
  workspaces,
  cwd,
  onPickWorkspace,
  onCreateWorkspace,
  onDeleteWorkspace,
  canDeleteWorkspace,
}) {
  return (
    <div className="sidebar">
      <h2>Workspace</h2>
      <div className="ws-row">
        <select className="workspace-pick" value={cwd || ""} onChange={(e) => onPickWorkspace(e.target.value)}>
          {workspaces.length === 0 && <option value="">(none)</option>}
          {workspaces.map((w) => (
            <option key={w.path} value={w.path}>
              {w.name}
            </option>
          ))}
        </select>
        <button className="ws-btn" title="New workspace folder" onClick={onCreateWorkspace}>+</button>
        <button
          className="ws-btn"
          title={canDeleteWorkspace ? "Delete this empty workspace" : "Root workspace can't be deleted"}
          onClick={onDeleteWorkspace}
          disabled={!canDeleteWorkspace}
        >
          ✕
        </button>
      </div>

      <button className="new-btn" onClick={onNew}>
        + New chat
      </button>

      <h2>Sessions</h2>
      {sessions.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: 12 }}>No sessions in this workspace.</div>
      )}
      {sessions.map((s) => (
        <div
          key={s.id}
          className={"session-item" + (s.id === activeId ? " active" : "")}
          onClick={() => onPick(s.id)}
          title={s.cwd}
        >
          <div className="session-row">
            <span className="session-label">{s.title || s.id.slice(0, 8)}</span>
            {onStop && s.busy && (
              <button
                className="session-stop"
                title="Stop this session"
                onClick={(e) => {
                  e.stopPropagation();
                  onStop(s.id);
                }}
              >
                ⏹
              </button>
            )}
            {onRemove && (
              <button
                className="session-rm"
                title="Delete this chat"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(s.id);
                }}
              >
                ✕
              </button>
            )}
          </div>
          <div className="meta">
            {s.id.slice(0, 8)} {s.model ? `· ${s.model}` : ""} {s.busy ? "· working" : s.ended ? "· ended" : ""}
          </div>
          {/* Engine badge only for non-claude engines (claude is the unmarked
              default — a badge on every row would be noise); transcript size
              and last activity come from the sessions broadcast. */}
          {(s.engine && s.engine !== "claude") || s.bytes || s.lastActivity || s.context ? (
            <div className="meta">
              {s.engine && s.engine !== "claude" && <span className="engine-badge">{s.engine}</span>}
              {s.bytes ? `· ${fmtBytes(s.bytes)}` : ""}
              {s.lastActivity ? ` · ${relTime(s.lastActivity)}` : ""}
              {ctxBadge(s)}
            </div>
          ) : null}
          {(() => {
            const m = sessionMeta(metricsBy?.[s.id]);
            return m ? <div className="meta metrics" title="cumulative cost · duration · turns">{m}</div> : null;
          })()}
        </div>
      ))}
    </div>
  );
}