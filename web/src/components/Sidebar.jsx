export default function Sidebar({
  sessions,
  activeId,
  onPick,
  onNew,
  onRemove,
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
        </div>
      ))}
    </div>
  );
}