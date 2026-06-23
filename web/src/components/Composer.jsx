import { useState, useRef, useEffect, useCallback } from "react";

// Composer for a chat turn. Supports text plus image attachments delivered to
// vision models as Anthropic image content blocks. Images can be pasted from
// the clipboard, picked from disk, or dragged onto the composer. Attachments
// are sent inline as base64 in the WS "send" payload (see App.jsx sendMessage
// and server/ws.js → Session.send).
export default function Composer({ onSend, onStop, busy, disabled }) {
  const [text, setText] = useState("");
  // attachments: [{id, name, mediaType, dataUrl, data}]  (data = raw base64, no data: prefix)
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
    const MAX_BYTES = 5 * 1024 * 1024; // 5 MB per image — guards the WS frame + spawn stdin
    const files = Array.from(fileList || []).filter(
      (f) => f && f.type && f.type.startsWith("image/"),
    );
    if (!files.length) return;
    for (const file of files) {
      if (file.size > MAX_BYTES) {
        window.alert(`"${file.name}" is too large (max 5 MB).`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || "");
        const comma = dataUrl.indexOf(",");
        if (comma < 0) return;
        const header = dataUrl.slice(0, comma); // data:<mediaType>;base64
        const data = dataUrl.slice(comma + 1);
        const mediaType = header.startsWith("data:") ? header.slice(5).split(";")[0] : file.type;
        setAttachments((prev) => [
          ...prev,
          { id: ++seq.current, name: file.name, mediaType, dataUrl, data },
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
      if (it.kind === "file" && it.type && it.type.startsWith("image/")) {
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
          {attachments.map((a) => (
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
          ))}
        </div>
      )}
      <div className="row">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
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
          title="Attach images (or paste / drag them in)"
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
              : "Message Claude Code…  (Enter to send, Shift+Enter for newline, paste/drop images for vision models)"
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