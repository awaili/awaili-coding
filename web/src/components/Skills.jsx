import { useEffect, useState, useCallback, useRef } from "react";
import Markdown from "./Markdown.jsx";

// Skills manager overlay: create / list / edit / delete Claude Code skills at
// two scopes — global (~/.claude/skills) and workspace (<cwd>/.claude/skills).
// Each skill is a directory with a SKILL.md entrypoint plus optional supporting
// files; selecting a skill shows a one-level file browser + a text editor for
// any file in that skill directory.
//
// The backend (server/skills.js) confines every path to the chosen skills dir
// via safe(); the client just passes scope/cwd/skill/path identifiers.

const MD_RE = /\.(md|markdown|mdx)$/i;

function qs(scope, cwd, skill, path) {
  const p = new URLSearchParams();
  p.set("scope", scope);
  if (scope === "workspace" && cwd) p.set("cwd", cwd);
  if (skill) p.set("skill", skill);
  if (path) p.set("path", path);
  return p.toString();
}

export default function Skills({ cwd, onClose }) {
  const [scope, setScope] = useState("workspace"); // "workspace" | "global"
  const [skills, setSkills] = useState([]);
  const [selSkill, setSelSkill] = useState(null); // skill name
  // File browser within the selected skill (one level at a time, like FileTree).
  const [tree, setTree] = useState(null); // { path, items }
  const [treePath, setTreePath] = useState("");
  // Editor state for the active file inside the selected skill.
  const [activeFile, setActiveFile] = useState(null); // relative path
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loadingFile, setLoadingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null); // path being deleted
  const noteTimer = useRef(null);

  const dirty = content !== original;

  useEffect(() => () => clearTimeout(noteTimer.current), []);

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
    setTree(null);
    setActiveFile(null);
    refreshSkills(scope);
  }, [scope, refreshSkills]);

  const loadDir = useCallback(async (sub = "") => {
    if (!selSkill) return;
    try {
      const r = await fetch(`/api/skills/file?${qs(scope, cwd, selSkill, sub)}`);
      const j = await r.json();
      if (j.error) {
        setError(j.error);
        return;
      }
      if (j.type === "dir") {
        setTree(j);
        setTreePath(sub);
        setError(null);
      }
    } catch (e) {
      setError(String(e));
    }
  }, [selSkill, scope, cwd]);

  // When a skill is selected, load its root listing.
  useEffect(() => {
    if (!selSkill) {
      setTree(null);
      setActiveFile(null);
      return;
    }
    setTree(null);
    setActiveFile(null);
    setContent("");
    setOriginal("");
    loadDir("");
  }, [selSkill, loadDir]);

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
      loadDir(treePath);
    } finally {
      setBusy(null);
    }
  }

  async function newItem() {
    const path = window.prompt("New file path inside this skill (e.g. helpers/notes.md):");
    if (!path) return;
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
      loadDir(treePath);
      openFile(path);
    } catch (e) {
      window.alert(String(e));
    }
  }

  function openItem(item) {
    if (item.dir) loadDir(item.path);
    else openFile(item.path);
  }

  function parentOf(p) {
    const i = p.lastIndexOf("/");
    return i < 0 ? "" : p.slice(0, i);
  }

  const isMd = activeFile ? MD_RE.test(activeFile) : false;

  return (
    <div className="skills-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="skills-panel">
        <div className="skills-head">
          <span className="skills-title">Skills</span>
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
          <span className="spacer" />
          <button className="skills-close" onClick={onClose}>✕ close</button>
        </div>

        {error && <div className="skills-error">{error}</div>}

        <div className="skills-split">
          {/* Left: skill list */}
          <div className="skills-list">
            <button className="new-skill-btn" onClick={newSkill}>+ New skill</button>
            {skills.length === 0 && (
              <div className="skills-empty">No {scope} skills.</div>
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
                    <span className="skills-skillname">{selSkill}</span>
                    <button className="skills-file-btn" onClick={newItem}>+ file</button>
                  </div>
                  {tree && (
                    <div className="skills-tree">
                      {treePath !== "" && (
                        <div className="tree-item" onClick={() => loadDir(parentOf(treePath))}>../</div>
                      )}
                      {tree.items.map((it) => (
                        <div
                          key={it.path}
                          className={
                            "tree-item" +
                            (it.dir ? " dir" : "") +
                            (!it.dir && activeFile === it.path ? " active" : "")
                          }
                          onClick={() => openItem(it)}
                        >
                          <span className="tree-name">{it.dir ? "▸ " : "  "}{it.name}</span>
                          <button
                            className="tree-rm"
                            title={`Delete ${it.name}`}
                            disabled={busy === it.path}
                            onClick={(e) => removeFile(it, e)}
                          >{busy === it.path ? "…" : "✕"}</button>
                        </div>
                      ))}
                      {tree.items.length === 0 && treePath === "" && (
                        <div className="skills-empty" style={{ padding: "8px 6px" }}>
                          No files yet. Click <b>+ file</b> or edit SKILL.md.
                        </div>
                      )}
                    </div>
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
      </div>
    </div>
  );
}