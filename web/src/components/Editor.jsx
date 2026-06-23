import { useEffect, useState, useRef } from "react";
import Markdown from "./Markdown.jsx";

// Edits a single file in the main area. Loads content via GET /api/files on
// mount (keyed by path in App so switching files remounts cleanly) and saves
// via PUT /api/files. The textarea is plain — good enough for source edits and
// avoids shipping a heavy code editor dependency.
//
// Markdown files (.md/.markdown/.mdx) open in a rendered Preview by default;
// a toggle in the header switches back to the raw-source textarea so the file
// can still be edited and saved.

const MD_RE = /\.(md|markdown|mdx)$/i;
// Image files are served as raw bytes via /api/files/download and rendered
// visually — they must NOT go through the utf8 text fetch (which corrupts
// binary) or the save/PUT path (text-only).
const IMG_RE = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i;

export default function Editor({ file, onClose }) {
  const { path, cwd } = file;
  const isMarkdown = MD_RE.test(path);
  const isImage = IMG_RE.test(path);
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(!isImage);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState(""); // transient status: "saved" | error text
  // Preview defaults ON for markdown files; non-markdown files always edit.
  const [preview, setPreview] = useState(isMarkdown);
  const taRef = useRef(null);
  const noteTimer = useRef(null);

  useEffect(() => {
    if (isImage) return; // images are rendered from /api/files/download, not fetched as text
    let alive = true;
    setLoading(true);
    setError(null);
    setNote("");
    fetch(`/api/files?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        if (j.error) {
          setError(j.error);
          setLoading(false);
          return;
        }
        setContent(j.content ?? "");
        setOriginal(j.content ?? "");
        setLoading(false);
        // focus the editor once loaded
        requestAnimationFrame(() => taRef.current?.focus());
      })
      .catch((e) => alive && (setError(String(e)), setLoading(false)));
    return () => {
      alive = false;
    };
  }, [path, cwd, isImage]);

  const dirty = content !== original;

  function flash(msg) {
    setNote(msg);
    clearTimeout(noteTimer.current);
    noteTimer.current = setTimeout(() => setNote(""), 2500);
  }

  // Clear the note timer on unmount so it can't fire setState after.
  useEffect(() => () => clearTimeout(noteTimer.current), []);

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setNote("");
    // Capture the content being saved. If the user types while the PUT is in
    // flight, `content` changes by the time the promise resolves; setting
    // original=content then would mark the NEW (unsaved) edits as clean. Pin
    // to what we actually sent.
    const savedContent = content;
    try {
      const res = await fetch("/api/files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, path, content: savedContent }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      setOriginal(savedContent);
      flash("saved");
    } catch (e) {
      flash(`save failed: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  // Ctrl/Cmd+S to save without leaving the field.
  function onKeyDown(e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  }

  const fileName = path.split("/").pop();
  const downloadUrl = `/api/files/download?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`;

  return (
    <div className="editor">
      <div className="editor-head">
        <button className="editor-back" onClick={onClose}>← Chat</button>
        <span className="editor-name">{fileName}</span>
        <span className="editor-path">{path}</span>
        <span className="spacer" />
        {isMarkdown && (
          <button
            className="editor-toggle"
            onClick={() => setPreview((p) => !p)}
            disabled={loading || !!error}
            title={preview ? "Show raw source" : "Render markdown preview"}
          >
            {preview ? "Edit" : "Preview"}
          </button>
        )}
        {!isImage && dirty && <span className="editor-dirty">unsaved</span>}
        {!isImage && (
          <span className={"editor-note" + (note === "saved" ? " ok" : note ? " err" : "")}>{note}</span>
        )}
        {isImage ? (
          <a className="editor-toggle" href={downloadUrl} download={fileName} title="Download image">
            Download
          </a>
        ) : (
          <button onClick={save} disabled={!dirty || saving || loading}>
            {saving ? "Saving…" : "Save"}
          </button>
        )}
      </div>

      {loading && <div className="editor-status">Loading {fileName}…</div>}
      {error && <div className="editor-status err">Failed to load: {error}</div>}

      {!loading && !error && preview && isMarkdown && (
        <div className="editor-preview">
          <Markdown text={content} />
        </div>
      )}

      {!loading && !error && isImage && (
        <div className="editor-image">
          <img src={downloadUrl} alt={fileName} />
        </div>
      )}

      {!loading && !error && !isImage && (!preview || !isMarkdown) && (
        <textarea
          ref={taRef}
          className="editor-textarea"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          onKeyDown={onKeyDown}
          spellCheck={false}
          wrap="off"
        />
      )}
    </div>
  );
}