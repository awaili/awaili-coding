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
          {(() => {
            const m = sessionMeta(metricsBy?.[s.id]);
            return m ? <div className="meta metrics" title="cumulative cost · duration · turns">{m}</div> : null;
          })()}
        </div>
      ))}
    </div>
  );
}