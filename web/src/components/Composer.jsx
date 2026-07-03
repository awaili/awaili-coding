import { useState, useRef, useEffect, useCallback } from "react";

function fmtSize(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// Composer for a chat turn. Supports text plus file attachments. Images are
// delivered to vision models as Anthropic image content blocks; any other file
// is read by the backend and inlined as a text block (text files) or a
// descriptive note (binary), so non-image attachments work even on text-only
// models. Files can be pasted from the clipboard, picked from disk, or dragged
// onto the composer. Attachments are sent inline as base64 in the WS "send"
// payload (see App.jsx sendMessage and server/ws.js → Session.send).
export default function Composer({ onSend, onStop, busy, disabled }) {
  const [text, setText] = useState("");
  // attachments: [{id, kind:"image"|"file", name, mediaType, dataUrl, data, size}]
  //   data = raw base64, no data: prefix. dataUrl kept only for image thumbnails.
  const [attachments, setAttachments] = useState([]);
  const [drag, setDrag] = useState(false);
  const ref = useRef(null);
  const fileRef = useRef(null);
  const seq = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  const addFiles = useCallback((fileList) => {
    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per file — guards the WS frame + spawn stdin
    const files = Array.from(fileList || []).filter((f) => f);
    if (!files.length) return;
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        window.alert(`"${file.name}" is too large (max 5 MB).`);
        continue;
      }
      const isImage = file.type && file.type.startsWith("image/");
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const comma = dataUrl.indexOf(",");
        if (comma < 0) return;
        const header = dataUrl.slice(0, comma); // data:<mediaType>;base64
        const data = dataUrl.slice(comma + 1);
        const mediaType = header.startsWith("data:") ? header.slice(5).split(";")[0] : file.type || "";
        setAttachments((prev) => [
          ...prev,
          {
            id: ++seq.current,
            kind: isImage ? "image" : "file",
            name: file.name || (isImage ? "image" : "file"),
            mediaType: mediaType || (isImage ? "image/png" : "application/octet-stream"),
            dataUrl: isImage ? dataUrl : "",
            data,
            size: file.size,
          },
        ]);
      };
      reader.onerror = () => {
        window.alert(`couldn't read "${file.name}"`);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  function removeAttachment(id) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  function submit() {
    const t = text.trim();
    if ((!t && attachments.length === 0) || disabled) return;
    onSend(t, attachments);
    setText("");
    setAttachments([]);
  }

  function onKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function onPaste(e) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      // Any pasted file is accepted — images render as thumbnails, other files
      // as chips. Skip pure text items so normal paste-into-textarea still works.
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  }

  function onDrop(e) {
    e.preventDefault();
    setDrag(false);
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  }

  const canSend = !disabled && (text.trim().length > 0 || attachments.length > 0);

  return (
    <div
      className={"composer" + (drag ? " drag" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!drag) setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <div className="previews">
          {attachments.map((a) =>
            a.kind === "image" ? (
              <div className="preview" key={a.id} title={a.name}>
                <img src={a.dataUrl} alt={a.name} />
                <button
                  className="rm"
                  onClick={() => removeAttachment(a.id)}
                  title="Remove attachment"
                >
                  ×
                </button>
              </div>
            ) : (
              <div className="preview file" key={a.id} title={a.name}>
                <span className="fileicon">📄</span>
                <span className="filename">{a.name}</span>
                <span className="filesize">{fmtSize(a.size)}</span>
                <button
                  className="rm"
                  onClick={() => removeAttachment(a.id)}
                  title="Remove attachment"
                >
                  ×
                </button>
              </div>
            ),
          )}
        </div>
      )}
      <div className="row">
        <input
          ref={fileRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button
          className="attach"
          onClick={() => fileRef.current?.click()}
          disabled={disabled}
          title="Attach files (or paste / drag them in)"
        >
          📎
        </button>
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={
            disabled
              ? "Start a session first…"
              : "Message Claude Code…  (Enter to send, Shift+Enter for newline, paste/drop files or images)"
          }
          disabled={disabled}
        />
        {busy ? (
          <button className="send stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button className="send" onClick={submit} disabled={!canSend}>
            Send
          </button>
        )}
      </div>
    </div>
  );
}