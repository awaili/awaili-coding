import { useEffect, useState, useCallback } from "react";

// File browser for the right panel. Browsing stays local to this component,
// but opening a *file* is delegated to the parent via onOpenFile so the file
// can be edited in the main area instead of this narrow sidebar. Deleting a
// file or directory is delegated via onDeleteFile so the parent can close the
// editor if the deleted path was open.
export default function FileTree({ cwd, onOpenFile, onDeleteFile, activePath }) {
  const [tree, setTree] = useState(null); // {path, items}
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // path currently being deleted

  const loadDir = useCallback(async (path = "") => {
    if (!cwd) return;
    setLoading(true);
    const res = await fetch(`/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`);
    const json = await res.json();
    if (json.error) {
      setError(json.error);
      setLoading(false);
      return;
    }
    if (json.type === "dir") {
      setTree(json);
      setError(null);
    }
    setLoading(false);
  }, [cwd]);

  useEffect(() => {
    setTree(null);
    loadDir("");
  }, [loadDir]);

  function openItem(item) {
    if (item.dir) {
      loadDir(item.path);
    } else {
      onOpenFile?.(item.path);
    }
  }

  // Direct same-origin GET carries the session cookie, so an <a download> is
  // enough to trigger a browser download — no fetch+blob needed.
  function downloadUrl(path) {
    return `/api/files/download?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
  }

  // Delete a file or directory (recursively for dirs) via DELETE /api/files.
  // Confirm first — recursive deletion is destructive and undoable. After it
  // succeeds, refresh the current dir and notify the parent in case the open
  // editor was showing the deleted path.
  async function removeItem(item, e) {
    e.stopPropagation();
    const what = item.dir ? `folder "${item.name}" and all its contents` : `file "${item.name}"`;
    if (!window.confirm(`Delete ${what}? This cannot be undone.`)) return;
    setBusy(item.path);
    try {
      const res = await fetch(
        `/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(item.path)}`,
        { method: "DELETE" },
      );
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) {
        window.alert(j.error || `delete failed (HTTP ${res.status})`);
        return;
      }
      onDeleteFile?.(item.path);
      // If we deleted the currently viewed folder, step back to its parent.
      const dir = tree?.path === item.path ? parentOf(item.path) : tree?.path || "";
      loadDir(dir);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="file-panel">
      <h2>Files</h2>
      <div className="path-breadcrumb">{cwd}</div>
      {error && <div style={{ color: "var(--err)", fontSize: 12 }}>{error}</div>}

      {loading && !tree && !error && (
        <div style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</div>
      )}

      {tree && (
        <div className="tree">
          {tree.path !== "" && (
            <div className="tree-item" onClick={() => loadDir(parentOf(tree.path))}>
              ../
            </div>
          )}
          {tree.items.map((it) => (
            <div
              key={it.path}
              className={
                "tree-item" +
                (it.dir ? " dir" : "") +
                (!it.dir && activePath === it.path ? " active" : "")
              }
              onClick={() => openItem(it)}
            >
              <span className="tree-name">{it.dir ? "▸ " : "  "}{it.name}</span>
              {!it.dir && (
                <a
                  className="tree-dl"
                  href={downloadUrl(it.path)}
                  download={it.name}
                  onClick={(e) => e.stopPropagation()}
                  title={`Download ${it.name}`}
                >
                  ⬇
                </a>
              )}
              <button
                className="tree-rm"
                onClick={(e) => removeItem(it, e)}
                disabled={busy === it.path}
                title={`Delete ${it.name}`}
              >
                {busy === it.path ? "…" : "✕"}
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <button onClick={() => loadDir(tree?.path || "")}>Refresh</button>
      </div>
    </div>
  );
}

function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}