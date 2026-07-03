import { useEffect, useState, useCallback, useRef, Fragment } from "react";
import Markdown from "./Markdown.jsx";
import GUIDE from "./skill-guide.md?raw";

// Skills manager overlay: create / list / edit / delete Claude Code skills at
// two scopes — global (~/.claude/skills) and workspace (<cwd>/.claude/skills).
// Each skill is a directory with a SKILL.md entrypoint plus optional supporting
// files; selecting a skill shows a one-level file browser + a text editor for
// any file in that skill directory.
//
// Three tabs:
//   • Manage — local skills (list / create / edit / delete) — the original UI.
//   • Browse — search the skillhub registry (proxy) + install a skill (full
//     supporting-file tree copied via the GitHub contents API), or paste a
//     GitHub owner/repo/path to install from any repo.
//   • Guide — in-app docs on how to author a SKILL.md (loaded from
//     skill-guide.md so it's editable as real markdown, no escaping headaches).
//
// The backend (server/skills.js) confines every path to the chosen skills dir
// via safe(); the client just passes scope/cwd/skill/path identifiers. Remote
// install is one code path driven by GitHub coordinates; skillhub only feeds
// coords + a security badge.

const MD_RE = /\.(md|markdown|mdx)$/i;

function qs(scope, cwd, skill, path) {
  const p = new URLSearchParams();
  p.set("scope", scope);
  if (scope === "workspace" && cwd) p.set("cwd", cwd);
  if (skill) p.set("skill", skill);
  if (path) p.set("path", path);
  return p.toString();
}

// Color the security badge from the skillhub score. skillhub scores skills for
// prompt-injection / exfil patterns; we surface it as guidance, not a hard gate.
function secBadge(s) {
  const score = typeof s.securityScore === "number" ? s.securityScore : null;
  if (s.security === "fail" || (score !== null && score < 50)) return { cls: "err", label: `low${score != null ? " · " + score : ""}` };
  if (score === null) return { cls: "muted", label: s.security || "no score" };
  if (score < 80) return { cls: "warn", label: `medium · ${score}` };
  return { cls: "ok", label: `pass · ${score}` };
}

export default function Skills({ cwd, workspaceRoot, onClose }) {
  const [tab, setTab] = useState("manage"); // "manage" | "browse" | "guide"
  const [scope, setScope] = useState("workspace"); // "workspace" | "global"
  const [skills, setSkills] = useState([]);
  const [selSkill, setSelSkill] = useState(null); // skill name
  // File browser within the selected skill as a lazy expand/collapse tree.
  // `nodes` is a cache keyed by rel path ("" = skill root) holding the
  // one-level listing plus loaded/expanded/loading flags, so a move/delete can
  // refresh just the affected parents. `currentDir` is the folder new files /
  // folders are created in (the last folder row clicked; "" = skill root).
  const [nodes, setNodes] = useState({});
  const [currentDir, setCurrentDir] = useState("");
  // Editor state for the active file inside the selected skill.
  const [activeFile, setActiveFile] = useState(null); // relative path
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // path being deleted/moved
  // Drag-and-drop move state (see FileTree for the same pattern). dragPath is
  // the rel path of the dragged item; dropOver is the folder it's hovering, or
  // "" for the current directory zone.
  const [dragPath, setDragPath] = useState(null);
  const [dropOver, setDropOver] = useState(null);
  const noteTimer = useRef(null);

  // --- Browse tab state ---
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("stars");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [minStars, setMinStars] = useState("");
  const [results, setResults] = useState([]);
  const [resultsPage, setResultsPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loadingSearch, setLoadingSearch] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [installing, setInstalling] = useState(null); // skill id
  const [ghInput, setGhInput] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const searchTimer = useRef(null);
  const [uploading, setUploading] = useState(false);
  const zipInputRef = useRef(null);

  const dirty = content !== original;

  useEffect(() => () => { clearTimeout(noteTimer.current); clearTimeout(searchTimer.current); }, []);

  function flash(msg) {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(""), 2500);
  }

  const refreshSkills = useCallback(async (s) => {
    setError(null);
    try {
      const r = await fetch(`/api/skills?${qs(s, cwd)}`);
      const j = await r.json();
      if (j.error) setError(j.error);
      else setSkills(j.skills || []);
    } catch (e) {
      setError(String(e));
    }
  }, [cwd]);

  // (Re)load the skill list whenever scope or workspace changes.
  useEffect(() => {
    setSelSkill(null);
    setNodes({});
    setCurrentDir("");
    setActiveFile(null);
    refreshSkills(scope);
  }, [scope, refreshSkills]);

  const loadNode = useCallback(async (sub = "") => {
    if (!selSkill) return;
    setNodes((prev) => ({ ...prev, [sub]: { ...(prev[sub] || {}), loading: true } }));
    try {
      const r = await fetch(`/api/skills/file?${qs(scope, cwd, selSkill, sub)}`);
      const j = await r.json();
      if (j.error) {
        setError(j.error);
        setNodes((prev) => ({ ...prev, [sub]: { ...(prev[sub] || {}), loading: false } }));
        return;
      }
      if (j.type === "dir") {
        setError(null);
        setNodes((prev) => ({
          ...prev,
          [sub]: { items: j.items, loaded: true, expanded: prev[sub]?.expanded ?? false, loading: false },
        }));
      }
    } catch (e) {
      setError(String(e));
      setNodes((prev) => ({ ...prev, [sub]: { ...(prev[sub] || {}), loading: false } }));
    }
  }, [selSkill, scope, cwd]);

  // Re-fetch a node's listing if already loaded (keeps an open folder current
  // after a create/move/delete without collapsing it).
  const refreshNode = useCallback(async (sub) => {
    if (nodes[sub]?.loaded) await loadNode(sub);
  }, [nodes, loadNode]);

  // Expand/collapse a folder; load its children lazily on first expand.
  async function onToggle(item) {
    if (!item.dir) return;
    setCurrentDir(item.path);
    const node = nodes[item.path];
    if (node?.expanded) {
      setNodes((prev) => ({ ...prev, [item.path]: { ...prev[item.path], expanded: false } }));
      return;
    }
    if (!node?.loaded) await loadNode(item.path);
    setNodes((prev) => ({ ...prev, [item.path]: { ...(prev[item.path] || {}), expanded: true } }));
  }

  function openItem(item) {
    if (item.dir) onToggle(item);
    else openFile(item.path);
  }

  // When a skill is selected, load its root listing.
  useEffect(() => {
    if (!selSkill) {
      setNodes({});
      setCurrentDir("");
      setActiveFile(null);
      return;
    }
    setNodes({});
    setCurrentDir("");
    setActiveFile(null);
    setContent("");
    setOriginal("");
    loadNode("");
  }, [selSkill, loadNode]);

  async function openFile(path) {
    setLoadingFile(true);
    setError(null);
    try {
      const r = await fetch(`/api/skills/file?${qs(scope, cwd, selSkill, path)}`);
      const j = await r.json();
      if (j.error) {
        setError(j.error);
        setLoadingFile(false);
        return;
      }
      setContent(j.content ?? "");
      setOriginal(j.content ?? "");
      setActiveFile(path);
      setPreview(MD_RE.test(path));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingFile(false);
    }
  }

  async function save() {
    if (!activeFile || !dirty || saving) return;
    setSaving(true);
    setNote("");
    const savedContent = content;
    try {
      const r = await fetch("/api/skills/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, skill: selSkill, path: activeFile, content: savedContent }),
      });
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setOriginal(savedContent);
      flash("saved");
    } catch (e) {
      flash(`save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  }

  async function newSkill() {
    const name = window.prompt("New skill name (used as /<name>):");
    if (!name) return;
    try {
      const r = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, name }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        window.alert(j.error || `failed (HTTP ${r.status})`);
        return;
      }
      await refreshSkills(scope);
      setSelSkill(name);
    } catch (e) {
      window.alert(String(e));
    }
  }

  async function removeSkill(name) {
    if (!window.confirm(`Delete skill "${name}" and all its files? This cannot be undone.`))
      return;
    try {
      const r = await fetch(`/api/skills?${qs(scope, cwd, undefined, undefined)}&name=${encodeURIComponent(name)}`, {
        method: "DELETE",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        window.alert(j.error || `delete failed (HTTP ${r.status})`);
        return;
      }
      if (selSkill === name) {
        setSelSkill(null);
        setActiveFile(null);
      }
      refreshSkills(scope);
    } catch (e) {
      window.alert(String(e));
    }
  }

  async function removeFile(item, e) {
    e.stopPropagation();
    if (!window.confirm(`Delete ${item.dir ? "folder" : "file"} "${item.name}"?`)) return;
    setBusy(item.path);
    try {
      const r = await fetch(
        `/api/skills/file?${qs(scope, cwd, selSkill, item.path)}`,
        { method: "DELETE" },
      );
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        window.alert(j.error || `delete failed (HTTP ${r.status})`);
        return;
      }
      if (activeFile === item.path || (item.dir && activeFile && activeFile.startsWith(item.path + "/"))) {
        setActiveFile(null);
        setContent("");
        setOriginal("");
      }
      setNodes((prev) => {
        const next = {};
        for (const [k, v] of Object.entries(prev)) {
          if (k === item.path || k.startsWith(item.path + "/")) continue; // drop deleted subtree
          next[k] = v;
        }
        return next;
      });
      refreshNode(parentOf(item.path));
    } finally {
      setBusy(null);
    }
  }

  // Create a new file. The entered path is relative to the current folder
  // (currentDir — the last folder row clicked, or the skill root), so "+ file"
  // while a subfolder is selected puts the file there, not at the skill root.
  async function newItem() {
    const inFolder = currentDir ? ` inside "${currentDir}/"` : "";
    const input = window.prompt(`New file${inFolder} (e.g. notes.md, or sub/notes.md):`, "notes.md");
    if (!input) return;
    const rel = input.replace(/^\/+|\/+$/g, "");
    if (!rel) return;
    const path = currentDir ? `${currentDir}/${rel}` : rel;
    try {
      const r = await fetch("/api/skills/file", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, skill: selSkill, path, content: "" }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        window.alert(j.error || `failed (HTTP ${r.status})`);
        return;
      }
      // Reload + expand the current folder so the new file shows, then open it.
      await loadNode(currentDir);
      setNodes((prev) => ({ ...prev, [currentDir]: { ...(prev[currentDir] || {}), expanded: true } }));
      openFile(path);
    } catch (e) {
      window.alert(String(e));
    }
  }

  // Create an empty folder. Like newItem, the entered path is relative to the
  // current folder (currentDir); parents are created server-side.
  async function newFolder() {
    const inFolder = currentDir ? ` inside "${currentDir}/"` : "";
    const input = window.prompt(`New folder${inFolder} (e.g. utils, or utils/sub):`, "new-folder");
    if (!input) return;
    const rel = input.replace(/^\/+|\/+$/g, "");
    if (!rel) return;
    const path = currentDir ? `${currentDir}/${rel}` : rel;
    try {
      const r = await fetch("/api/skills/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, skill: selSkill, path }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        window.alert(j.error || `failed (HTTP ${r.status})`);
        return;
      }
      await loadNode(currentDir);
      setNodes((prev) => ({ ...prev, [currentDir]: { ...(prev[currentDir] || {}), expanded: true } }));
    } catch (e) {
      window.alert(String(e));
    }
  }

  // Rename a file/folder in place (same directory). The open editor follows the
  // file to its new name so a later save writes to the right path.
  async function renameItem(item, e) {
    e.stopPropagation();
    const next = window.prompt(`Rename "${item.name}" to:`, item.name);
    if (!next) return;
    const clean = next.replace(/^\/+|\/+$/g, "");
    if (!clean || clean === item.name) return;
    // Keep the rename within the same directory: combine parent + new name.
    const to = item.path.includes("/") ? `${parentOf(item.path)}/${clean}` : clean;
    try {
      const r = await fetch("/api/skills/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, skill: selSkill, from: item.path, to }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        window.alert(j.error || `failed (HTTP ${r.status})`);
        return;
      }
      if (activeFile === item.path) setActiveFile(to);
      else if (item.dir && activeFile && activeFile.startsWith(item.path + "/"))
        setActiveFile(to + activeFile.slice(item.path.length));
      setNodes((prev) => {
        const next2 = {};
        for (const [k, v] of Object.entries(prev)) {
          if (k === item.path || k.startsWith(item.path + "/")) continue; // drop stale subtree
          next2[k] = v;
        }
        return next2;
      });
      refreshNode(parentOf(item.path));
    } catch (e2) {
      window.alert(String(e2));
    }
  }

  // Move a file/folder to a new path within the skill via POST /api/skills/move.
  // If the open editor was showing the moved file (or a file inside a moved
  // folder), follow it to the new path so the editor keeps working.
  async function moveItem(from, to) {
    if (!from || !to || from === to) return;
    setBusy(from);
    try {
      const r = await fetch("/api/skills/move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, cwd, skill: selSkill, from, to }),
      });
      const j = await r.json();
      if (!r.ok || j.error) {
        window.alert(j.error || `move failed (HTTP ${r.status})`);
        return;
      }
      if (activeFile === from) {
        setActiveFile(to);
      } else if (activeFile && activeFile.startsWith(from + "/")) {
        setActiveFile(to + activeFile.slice(from.length));
      }
      // Drop the moved subtree's now-stale cache, then refresh both parents and
      // expand the destination so the item is visible in its new location.
      setNodes((prev) => {
        const next = {};
        for (const [k, v] of Object.entries(prev)) {
          if (k === from || k.startsWith(from + "/")) continue;
          next[k] = v;
        }
        return next;
      });
      const srcParent = parentOf(from);
      const dstParent = parentOf(to);
      await refreshNode(srcParent);
      if (dstParent !== srcParent) {
        await loadNode(dstParent);
        setNodes((prev) => ({ ...prev, [dstParent]: { ...(prev[dstParent] || {}), expanded: true } }));
        await refreshNode(dstParent);
      }
    } catch (e) {
      window.alert(String(e));
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
    if (parentOf(from) === "") return; // already at the skill root
    const to = baseName(from); // move into the skill root (this tree's empty area)
    if (to === from || to.startsWith(from + "/")) return;
    moveItem(from, to);
  }

  function onDragEnd() {
    setDragPath(null);
    setDropOver(null);
  }

  function parentOf(p) {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  }

  // Recursive render of the expand/collapse tree. A folder row shows a ▸/▾
  // twisty; when expanded its lazily-loaded children render indented beneath.
  function renderItems(items, depth) {
    return items.map((it) => {
      const node = nodes[it.path];
      const expanded = it.dir && node?.expanded;
      const isDropTarget = it.dir && dropOver === it.path;
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
              (!it.dir && activeFile === it.path ? " active" : "") +
              (isDropTarget ? " drop-target" : "") +
              (dragPath === it.path ? " dragging" : "")
            }
            style={{ paddingLeft: depth * 14 + 6 }}
            onClick={() => openItem(it)}
            title={it.dir ? (expanded ? `Collapse ${it.name}` : `Expand / drop into ${it.name}`) : `Open ${it.name}`}
          >
            <span className="tree-twisty">{it.dir ? (expanded ? "▾" : "▸") : ""}</span>
            <span className="tree-name">{it.name}</span>
            <button className="tree-rn" title={`Rename ${it.name}`} onClick={(e) => renameItem(it, e)}>✎</button>
            <button
              className="tree-rm"
              title={`Delete ${it.name}`}
              disabled={busy === it.path}
              onClick={(e) => removeFile(it, e)}
            >{busy === it.path ? "…" : "✕"}</button>
          </div>
          {expanded && node?.loading && (
            <div className="tree-item tree-loading" style={{ paddingLeft: (depth + 1) * 14 + 6 }}>…</div>
          )}
          {expanded && node?.items && renderItems(node.items, depth + 1)}
        </Fragment>
      );
    });
  }

  // --- Browse tab ---
  async function runSearch(page) {
    setLoadingSearch(true);
    setSearchError(null);
    try {
      const p = new URLSearchParams();
      if (query.trim()) p.set("q", query.trim());
      p.set("sort", sort);
      if (verifiedOnly) p.set("verified", "true");
      if (minStars) p.set("minStars", String(minStars));
      p.set("limit", "30");
      p.set("page", String(page));
      const r = await fetch(`/api/skills/remote/search?${p.toString()}`);
      const j = await r.json();
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`);
      setResultsPage(page);
      setHasMore((j.skills || []).length >= 30);
      setResults((prev) => (page === 1 ? j.skills || [] : [...prev, ...(j.skills || [])]));
    } catch (e) {
      setSearchError(e.message);
      if (page === 1) setResults([]);
    } finally {
      setLoadingSearch(false);
    }
  }

  // Debounced search on filter changes; reset to page 1.
  useEffect(() => {
    if (tab !== "browse") return;
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => runSearch(1), 350);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, query, sort, verifiedOnly, minStars]);

  async function installRemote(s) {
    const def = s.name || (s.path ? s.path.split("/").filter(Boolean).pop() : s.id);
    const name = window.prompt(`Install as skill name (in ${scope} scope):`, def);
    if (!name) return;
    setInstalling(s.id);
    try {
      const r = await fetch("/api/skills/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope, cwd, name,
          owner: s.owner, repo: s.repo, path: s.path || "", branch: s.branch || "main",
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        if (r.status === 409 && window.confirm(`Skill "${name}" already exists. Overwrite it?`)) {
          const r2 = await fetch("/api/skills/import", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              scope, cwd, name, force: true,
              owner: s.owner, repo: s.repo, path: s.path || "", branch: s.branch || "main",
            }),
          });
          const j2 = await r2.json().catch(() => ({}));
          if (!r2.ok || j2.error) throw new Error(j2.error || `HTTP ${r2.status}`);
          finishInstall(name, j2);
        } else {
          throw new Error(j.error || `HTTP ${r.status}`);
        }
      } else {
        finishInstall(name, j);
      }
    } catch (e) {
      window.alert(`Install failed: ${e.message}`);
    } finally {
      setInstalling(null);
    }
  }

  function finishInstall(name, j) {
    refreshSkills(scope);
    setSelSkill(name);
    setTab("manage");
    const n = (j.files || []).length;
    flash(`installed ${n} file${n === 1 ? "" : "s"}${j.skipped ? ` (${j.skipped} skipped)` : ""}`);
  }

  // Upload a local .zip and have the backend extract it into a new skill.
  // The zip must contain SKILL.md at its root (or inside a single top-level
  // folder, e.g. my-skill/SKILL.md). The file is sent as raw bytes with
  // Content-Type application/zip so it isn't blocked by the JSON body cap.
  async function uploadZip(file) {
    const def = file.name.replace(/\.zip$/i, "");
    const name = window.prompt(`Install zip as skill name (in ${scope} scope):`, def);
    if (!name) return;
    setUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const params = qs(scope, cwd) + `&name=${encodeURIComponent(name)}`;
      const r = await fetch(`/api/skills/upload?${params}`, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: buf,
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) {
        if (r.status === 409 && window.confirm(`Skill "${name}" already exists. Overwrite it?`)) {
          const r2 = await fetch(`/api/skills/upload?${params}&force=1`, {
            method: "POST",
            headers: { "Content-Type": "application/zip" },
            body: buf,
          });
          const j2 = await r2.json().catch(() => ({}));
          if (!r2.ok || j2.error) throw new Error(j2.error || `HTTP ${r2.status}`);
          finishInstall(name, j2);
        } else {
          throw new Error(j.error || `HTTP ${r.status}`);
        }
      } else {
        finishInstall(name, j);
      }
    } catch (e) {
      window.alert(`Upload failed: ${e.message}`);
    } finally {
      setUploading(false);
      if (zipInputRef.current) zipInputRef.current.value = "";
    }
  }

  // Parse "owner/repo[/path][@branch]" into coords and install.
  async function installGithub() {
    const raw = ghInput.trim();
    if (!raw) return;
    let branch = "main";
    let rest = raw;
    const at = raw.lastIndexOf("@");
    if (at >= 0 && at < raw.length - 1) {
      branch = raw.slice(at + 1);
      rest = raw.slice(0, at);
    }
    const parts = rest.split("/").map((x) => x.trim()).filter(Boolean);
    if (parts.length < 2) {
      window.alert("Enter owner/repo (optionally /path and @branch).");
      return;
    }
    const [owner, repo, ...pathParts] = parts;
    const path = pathParts.join("/");
    await installRemote({ id: `${owner}/${repo}/${path}`, name: pathParts.length ? pathParts[pathParts.length - 1] : repo, owner, repo, path, branch });
    setGhInput("");
  }

  const isMd = activeFile ? MD_RE.test(activeFile) : false;
  const showScope = tab === "manage" || tab === "browse";
  // Display name for the currently selected workspace, distinguishing the root
  // (no project picked) from a real project subdir. Workspace skills are scoped
  // to this cwd, so surfacing it explains why the list differs per workspace.
  const isRootWs = !cwd || !workspaceRoot || cwd === workspaceRoot;
  const wsName = isRootWs ? "(workspace root)" : String(cwd).split("/").filter(Boolean).pop();

  return (
    <div className="skills-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="skills-panel">
        <div className="skills-head">
          <span className="skills-title">Skills</span>
          <div className="skills-tabs">
            <button className={tab === "manage" ? "active" : ""} onClick={() => setTab("manage")}>Manage</button>
            <button className={tab === "browse" ? "active" : ""} onClick={() => setTab("browse")}>Browse</button>
            <button className={tab === "guide" ? "active" : ""} onClick={() => setTab("guide")}>Guide</button>
          </div>
          <span className="spacer" />
          <button className="skills-close" onClick={onClose}>✕ close</button>
        </div>

        {showScope && (
          <div className="skills-subhead">
            <span className="skills-subhead-label">Scope:</span>
            <div className="skills-scope">
              <button
                className={scope === "workspace" ? "active" : ""}
                onClick={() => setScope("workspace")}
                title={`Skills in ${cwd || "(no workspace)"}`}
              >
                Workspace
              </button>
              <button
                className={scope === "global" ? "active" : ""}
                onClick={() => setScope("global")}
                title="Personal skills (~/.claude/skills) — all projects"
              >
                Global
              </button>
            </div>
            {tab === "browse" && (
              <span className="skills-subhead-hint">installs into {scope} scope</span>
            )}
            {scope === "workspace" && (tab === "manage" || tab === "browse") && (
              <span className="skills-subhead-hint" title={cwd || ""}>
                workspace: <b>{wsName}</b>
              </span>
            )}
          </div>
        )}

        {error && <div className="skills-error">{error}</div>}

        {tab === "manage" && (
          <div className="skills-split">
            {/* Left: skill list */}
            <div className="skills-list">
              <button className="new-skill-btn" onClick={newSkill}>+ New skill</button>
              <button
                className="new-skill-btn"
                title="Upload a .zip — the backend extracts it into a new skill (must contain SKILL.md)"
                disabled={uploading}
                onClick={() => zipInputRef.current && zipInputRef.current.click()}
              >{uploading ? "Uploading…" : "↑ Upload .zip"}</button>
              <input
                ref={zipInputRef}
                type="file"
                accept=".zip,application/zip"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files && e.target.files[0];
                  if (f) uploadZip(f);
                }}
              />
              {skills.length === 0 && (
                <div className="skills-empty">
                  {scope === "workspace" ? (
                    <>
                      No skills in <b>{wsName}</b>.
                      <div className="skills-empty-hint">
                        Workspace skills live in this workspace&apos;s <code>.claude/skills/</code> and apply
                        only here. If you created the skill while another workspace was selected, pick that
                        workspace above — or switch to <b>Global</b> for skills shared across all workspaces.
                      </div>
                    </>
                  ) : (
                    "No global skills yet."
                  )}
                </div>
              )}
              {skills.map((s) => (
                <div
                  key={s.name}
                  className={"skills-item" + (s.name === selSkill ? " active" : "")}
                  onClick={() => setSelSkill(s.name)}
                  title={s.description}
                >
                  <div className="skills-item-row">
                    <span className="skills-name">{s.name}</span>
                    <button
                      className="skills-rm"
                      title="Delete skill"
                      onClick={(e) => { e.stopPropagation(); removeSkill(s.name); }}
                    >✕</button>
                  </div>
                  <div className="skills-desc">{s.description}</div>
                </div>
              ))}
            </div>

            {/* Right: file browser + editor for the selected skill */}
            <div className="skills-detail">
              {!selSkill ? (
                <div className="skills-empty">Select a skill, or create a new one.</div>
              ) : (
                <>
                  <div className="skills-files">
                    <div className="skills-files-head">
                      <span className="skills-skillname" title={currentDir ? `${currentDir}/` : "skill root"}>
                        {selSkill}{currentDir ? <span className="skills-curdir"> · {currentDir}/</span> : null}
                      </span>
                      <button
                        className="skills-file-btn"
                        onClick={newFolder}
                        title={`Create a new folder${currentDir ? ` in ${currentDir}/` : " at skill root"}`}
                      >+ folder</button>
                      <button
                        className="skills-file-btn"
                        onClick={newItem}
                        title={`Create a new file${currentDir ? ` in ${currentDir}/` : " at skill root"}`}
                      >+ file</button>
                    </div>
                    {nodes[""] ? (
                      <div
                        className={"skills-tree" + (dropOver === "" && dragPath ? " drop-zone" : "")}
                        onDragOver={onZoneDragOver}
                        onDrop={onZoneDrop}
                      >
                        {renderItems(nodes[""].items || [], 0)}
                        {(!(nodes[""].items) || nodes[""].items.length === 0) && (
                          <div className="skills-empty" style={{ padding: "8px 6px" }}>
                            No files yet. Click <b>+ file</b> or edit SKILL.md.
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="skills-empty" style={{ padding: "8px 6px" }}>Loading…</div>
                    )}
                  </div>

                  <div className="skills-editor">
                    {activeFile ? (
                      <>
                        <div className="skills-editor-head">
                          <span className="skills-filepath">{activeFile}</span>
                          <span className="spacer" />
                          {isMd && (
                            <button
                              className="skills-file-btn"
                              onClick={() => setPreview((p) => !p)}
                              title={preview ? "Show raw source" : "Render markdown preview"}
                            >
                              {preview ? "Edit" : "Preview"}
                            </button>
                          )}
                          {dirty && <span className="skills-dirty">unsaved</span>}
                          <span className={"skills-note" + (note === "saved" ? " ok" : note ? " err" : "")}>{note}</span>
                          <button
                            onClick={save}
                            disabled={!dirty || saving}
                          >{saving ? "Saving…" : "Save"}</button>
                        </div>
                        {isMd && preview ? (
                          <div className="skills-editor-preview"><Markdown text={content} /></div>
                        ) : (
                          <textarea
                            className="skills-textarea"
                            value={content}
                            onChange={(e) => setContent(e.target.value)}
                            onKeyDown={onKeyDown}
                            spellCheck={false}
                            wrap="off"
                            placeholder="Select a file to edit…"
                          />
                        )}
                      </>
                    ) : (
                      <div className="skills-empty">Pick a file on the left to edit it.</div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {tab === "browse" && (
          <div className="skills-browse">
            <div className="skills-search">
              <input
                type="text"
                placeholder="Search skillhub (e.g. pdf, git-commit, hooks)…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <select value={sort} onChange={(e) => setSort(e.target.value)} title="Sort by">
                <option value="stars">★ Stars</option>
                <option value="downloads">↓ Downloads</option>
                <option value="updated">Recent</option>
                <option value="relevance">Relevance</option>
              </select>
              <label className="skills-check" title="Show only verified skills">
                <input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} />
                verified
              </label>
              <input
                type="number"
                min="0"
                placeholder="min ★"
                value={minStars}
                onChange={(e) => setMinStars(e.target.value)}
                title="Minimum stars"
                className="skills-minstars"
              />
            </div>

            <div className="skills-gh">
              <span className="skills-gh-label">Install from GitHub:</span>
              <input
                type="text"
                placeholder="owner/repo[/path][@branch]  e.g. anthropics/skills/skills/pdf"
                value={ghInput}
                onChange={(e) => setGhInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && installGithub()}
              />
              <button onClick={installGithub} disabled={ghBusy || !ghInput.trim()}>
                {ghBusy ? "…" : "Install"}
              </button>
            </div>

            {searchError && <div className="skills-error">{searchError}</div>}

            <div className="skills-results">
              {loadingSearch && results.length === 0 && (
                <div className="skills-empty">Searching…</div>
              )}
              {!loadingSearch && results.length === 0 && !searchError && (
                <div className="skills-empty">No results — try a different query.</div>
              )}
              {results.map((s) => {
                const b = secBadge(s);
                return (
                  <div key={s.id} className="skills-result">
                    <div className="skills-result-head">
                      <span className="skills-result-name" title={s.id}>{s.name}</span>
                      {s.verified && <span className="skills-badge verified" title="Verified by skillhub">✓ verified</span>}
                      <span className={"skills-badge " + b.cls} title={`security: ${s.security || "?"} (score ${s.securityScore == null ? "?" : s.securityScore})`}>{b.label}</span>
                      <span className="spacer" />
                      <button
                        className="skills-install"
                        disabled={installing === s.id}
                        onClick={() => installRemote(s)}
                      >
                        {installing === s.id ? "Installing…" : "Install"}
                      </button>
                    </div>
                    <div className="skills-result-desc" title={s.description}>{s.description}</div>
                    <div className="skills-meta">
                      <span className="skills-meta-src" title={s.id}>{s.owner}/{s.repo}{s.path ? "/" + s.path : ""}</span>
                      <span>★ {s.stars || 0}</span>
                      <span>↓ {s.downloads || 0}</span>
                      {s.license && <span>{s.license}</span>}
                    </div>
                  </div>
                );
              })}
              {hasMore && results.length > 0 && (
                <button className="skills-more" disabled={loadingSearch} onClick={() => runSearch(resultsPage + 1)}>
                  {loadingSearch ? "Loading…" : "Load more"}
                </button>
              )}
            </div>
          </div>
        )}

        {tab === "guide" && (
          <div className="skills-guide">
            <Markdown text={GUIDE} />
          </div>
        )}
      </div>
    </div>
  );
}