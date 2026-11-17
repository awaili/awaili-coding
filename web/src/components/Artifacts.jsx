import { useEffect, useState } from "react";

// Artifacts panel: WHICH workspace files this chat touched, straight from the
// session transcript (GET /api/artifacts — server/artifacts.js aggregates the
// Edit/Write/MultiEdit/NotebookEdit tool calls). Gives the post-turn answer to
// "what did it actually change?" without eyeballing the file tree, plus a
// one-click zip of every still-existing touched file.
//
// `rel` is the path relative to the session cwd (null when a tool touched a
// file outside the workspace — listed, but not openable in the editor nor
// included in the zip).
const OP_LABEL = { Edit: "edit", Write: "write", MultiEdit: "edit", NotebookEdit: "nb" };

function opsText(ops) {
  const parts = Object.entries(ops || {})
    .map(([k, n]) => `${OP_LABEL[k] || k}${n > 1 ? `×${n}` : ""}`);
  return parts.join(" · ");
}

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("en-GB", { hour12: false, month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function Artifacts({ sessionId, cwd, onOpenFile, onClose }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!sessionId || !cwd) return;
    let alive = true;
    setItems(null);
    setError("");
    fetch(`/api/artifacts?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sessionId)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) setError(j.error);
        else setItems(j.items || []);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, cwd]);

  const zipUrl =
    sessionId && cwd
      ? `/api/artifacts/zip?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(sessionId)}`
      : null;

  return (
    <div className="art-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="art-panel">
        <div className="art-head">
          <span className="art-title">Session artifacts</span>
          <span className="art-sub">
            {sessionId ? `files touched by this chat (${(sessionId || "").slice(0, 8)})` : "no chat selected"}
          </span>
          <span className="spacer" />
          {zipUrl && items && items.length > 0 && (
            <a className="art-zip" href={zipUrl} download title="Download every still-existing touched file as a zip">
              ⬇ Download zip
            </a>
          )}
          <button className="art-close" onClick={onClose}>✕ close</button>
        </div>
        {error && <div className="art-error">{error}</div>}
        <div className="art-body">
          {!sessionId && (
            <div className="art-empty">Open a chat to see which files it touched.</div>
          )}
          {sessionId && items === null && !error && (
            <div className="art-empty">Loading…</div>
          )}
          {items && items.length === 0 && (
            <div className="art-empty">
              This chat hasn't touched any files yet (Edit / Write / MultiEdit / NotebookEdit calls appear here).
            </div>
          )}
          {items && items.length > 0 && (
            <table className="art-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Ops</th>
                  <th>Last touched</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((it) => (
                  <tr key={it.path} title={it.path}>
                    <td className="art-path">
                      {it.rel ? (
                        <button className="art-open" onClick={() => onOpenFile?.(it.rel)} title="Open in editor">
                          {it.rel}
                        </button>
                      ) : (
                        <span className="art-outside" title="Outside the workspace — not openable in the editor">
                          {it.path}
                        </span>
                      )}
                    </td>
                    <td className="art-ops">{opsText(it.ops)}</td>
                    <td className="art-time">{fmtTime(it.lastAt)}</td>
                    <td className="art-count" title="total calls touching this file">{it.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
