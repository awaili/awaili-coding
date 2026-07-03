import { useEffect, useState, useCallback, Fragment } from "react";

// File browser for the right panel, rendered as a lazy expand/collapse tree:
// click a folder's ▸ twisty (or its row) to reveal its contents inline rather
// than navigating into it and losing the surrounding context. Each folder is
// fetched one level at a time (GET /api/files) the first time it's expanded.
//
// Opening a *file* is delegated to the parent via onOpenFile so it can be
// edited in the main area. Deleting and moving are delegated via onDeleteFile /
// onMoveFile so the parent can close or follow the editor if the affected path
// was open. Drag a file/folder onto a folder (or the empty area for the root)
// to move it.
export default function FileTree({ cwd, onOpenFile, onDeleteFile, onMoveFile, activePath }) {
  // Tree cache keyed by rel path: "" is the workspace root. Each entry holds the
  // one-level listing plus loaded/expanded/loading flags. Centralizing it (vs.
  // per-node component state) lets a move/delete refresh exactly the affected
  // parents by re-fetching their entries.
  const [nodes, setNodes] = useState({}); // path -> { items, loaded, expanded, loading }
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(null); // path currently being deleted/moved
  const [dragPath, setDragPath] = useState(null);
  const [dropOver, setDropOver] = useState(null); // folder path or "" (root zone)

  const loadNode = useCallback(async (path) => {
    setNodes((prev) => ({ ...prev, [path]: { ...(prev[path] || {}), loading: true } }));
    const res = await fetch(`/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`);
    const json = await res.json();
    if (json.error) {
      setError(json.error);
      setNodes((prev) => ({ ...prev, [path]: { ...(prev[path] || {}), loading: false } }));
      return;
    }
    if (json.type === "dir") {
      setError(null);
      setNodes((prev) => ({
        ...prev,
        [path]: { items: json.items, loaded: true, expanded: prev[path]?.expanded ?? false, loading: false },
      }));
    }
  }, [cwd]);

  // (Re)load the root whenever the workspace changes.
  useEffect(() => {
    setNodes({});
    setError(null);
    setLoading(true);
    loadNode("").finally(() => setLoading(false));
  }, [loadNode]);

  async function onToggle(item) {
    if (!item.dir) return;
    const node = nodes[item.path];
    if (node?.expanded) {
      setNodes((prev) => ({ ...prev, [item.path]: { ...prev[item.path], expanded: false } }));
      return;
    }
    if (!node?.loaded) await loadNode(item.path);
    setNodes((prev) => ({ ...prev, [item.path]: { ...(prev[item.path] || {}), expanded: true } }));
  }

  // Re-fetch a node's listing if it's already loaded (so an open folder updates
  // after a move/delete without collapsing it).
  async function refresh(path) {
    if (nodes[path]?.loaded) await loadNode(path);
  }

  function openItem(item) {
    if (item.dir) onToggle(item);
    else onOpenFile?.(item.path);
  }

  function downloadUrl(path) {
    return `/api/files/download?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;
  }

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
      setNodes((prev) => {
        const next = { ...prev };
        delete next[item.path]; // drop the deleted folder's cached children
        return next;
      });
      refresh(parentOf(item.path));
    } finally {
      setBusy(null);
    }
  }

  async function moveItem(from, to) {
    if (!from || !to || from === to) return;
    setBusy(from);
    try {
      const res = await fetch("/api/files/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, from, to }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || j.error) {
        window.alert(j.error || `move failed (HTTP ${res.status})`);
        return;
      }
      onMoveFile?.(from, to);
      // Drop the moved subtree's cached children (paths are now stale) and
      // refresh both the source and destination folders so the tree reflects
      // the move. Ensure the destination folder is expanded so the item is seen.
      setNodes((prev) => {
        const next = {};
        for (const [k, v] of Object.entries(prev)) {
          if (k === from || k.startsWith(from + "/")) continue; // drop stale subtree
          next[k] = v;
        }
        return next;
      });
      const srcParent = parentOf(from);
      const dstParent = parentOf(to);
      await refresh(srcParent);
      if (dstParent !== srcParent) {
        if (!nodes[dstParent]?.loaded) await loadNode(dstParent);
        setNodes((prev) => ({ ...prev, [dstParent]: { ...(prev[dstParent] || {}), expanded: true } }));
        await refresh(dstParent);
      }
    } finally {
      setBusy(null);
    }
  }

  const baseName = (p) => p.split("/").filter(Boolean).pop();

  function onDragStart(item, e) {
    setDragPath(item.path);
    setDropOver(null);
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", item.path); } catch {}
  }
  function onFolderDragOver(item, e) {
    if (!dragPath || !item.dir) return;
    if (item.path === dragPath || item.path.startsWith(dragPath + "/")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (dropOver !== item.path) setDropOver(item.path);
  }
  async function onFolderDrop(item, e) {
    e.preventDefault();
    e.stopPropagation();
    const from = dragPath;
    setDragPath(null);
    setDropOver(null);
    if (!from || !item.dir || item.path === from || item.path.startsWith(from + "/")) return;
    const to = item.path ? `${item.path}/${baseName(from)}` : baseName(from);
    if (to === from) return;
    moveItem(from, to);
  }
  function onZoneDragOver(e) {
    if (!dragPath) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropOver !== "") setDropOver("");
  }
  async function onZoneDrop(e) {
    e.preventDefault();
    const from = dragPath;
    setDragPath(null);
    setDropOver(null);
    if (!from) return;
    if (parentOf(from) === "") return; // already at root
    const to = baseName(from);
    if (to === from || to.startsWith(from + "/")) return;
    moveItem(from, to);
  }
  function onDragEnd() {
    setDragPath(null);
    setDropOver(null);
  }

  // Refresh every currently-loaded folder (picks up external changes).
  function refreshAll() {
    for (const p of Object.keys(nodes)) if (nodes[p]?.loaded) loadNode(p);
  }

  function renderItems(items, depth) {
    return items.map((it) => {
      const node = nodes[it.path];
      const expanded = it.dir && node?.expanded;
      const isDropTarget = it.dir && dropOver === it.path;
      const rowActive = !it.dir && activePath === it.path;
      return (
        <Fragment key={it.path}>
          <div
            draggable
            onDragStart={(e) => onDragStart(it, e)}
            onDragEnd={onDragEnd}
            onDragOver={it.dir ? (e) => onFolderDragOver(it, e) : undefined}
            onDrop={it.dir ? (e) => onFolderDrop(it, e) : undefined}
            className={
              "tree-item" +
              (it.dir ? " dir" : "") +
              (rowActive ? " active" : "") +
              (isDropTarget ? " drop-target" : "") +
              (dragPath === it.path ? " dragging" : "")
            }
            style={{ paddingLeft: depth * 14 + 6 }}
            onClick={() => openItem(it)}
            title={it.dir ? (expanded ? `Collapse ${it.name}` : `Expand ${it.name}`) : `Open ${it.name}`}
          >
            <span className="tree-twisty">{it.dir ? (expanded ? "▾" : "▸") : ""}</span>
            <span className="tree-name">{it.name}</span>
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
          {expanded && node?.loading && (
            <div className="tree-item tree-loading" style={{ paddingLeft: (depth + 1) * 14 + 6 }}>…</div>
          )}
          {expanded && node?.items && renderItems(node.items, depth + 1)}
        </Fragment>
      );
    });
  }

  const root = nodes[""];

  return (
    <div className="file-panel">
      <h2>Files</h2>
      <div className="path-breadcrumb">{cwd}</div>
      {error && <div style={{ color: "var(--err)", fontSize: 12 }}>{error}</div>}
      {loading && !root && !error && (
        <div style={{ color: "var(--muted)", fontSize: 12 }}>Loading…</div>
      )}
      {root && (
        <div
          className={"tree" + (dropOver === "" && dragPath ? " drop-zone" : "")}
          onDragOver={onZoneDragOver}
          onDrop={onZoneDrop}
        >
          {renderItems(root.items || [], 0)}
          {(!root.items || root.items.length === 0) && (
            <div style={{ color: "var(--muted)", fontSize: 12, padding: "6px 2px" }}>
              Empty workspace.
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <button onClick={refreshAll}>Refresh</button>
      </div>
    </div>
  );
}

function parentOf(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}