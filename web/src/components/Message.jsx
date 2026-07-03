import Markdown from "./Markdown.jsx";
import ToolCard from "./ToolCard.jsx";

// Only allow same-origin paths or https: image URLs. Defends against a backend
// (or future code path) returning a javascript:/data:text/html scheme; modern
// browsers ignore javascript: in <img src> anyway, but this is cheap.
function safeImgSrc(u) {
  if (typeof u !== "string") return "";
  if (u.startsWith("/") || u.startsWith("https:") || u.startsWith("data:image/")) return u;
  return "";
}

function fmtSize(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function Message({ msg }) {
  if (msg.role === "user") {
    const images = Array.isArray(msg.images) ? msg.images : [];
    const files = Array.isArray(msg.files) ? msg.files : [];
    return (
      <div className="msg user">
        <div className="role">you</div>
        <div className="bubble">
          {msg.text}
          {images.length > 0 && (
            <div className="images">
              {images.map((im, i) => (
                <img key={im.url || im.dataUrl || i} src={safeImgSrc(im.url || im.dataUrl)} alt={im.name || `image-${i + 1}`} />
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div className="files">
              {files.map((f, i) => (
                <div className="filechip" key={f.name + i} title={f.name}>
                  <span className="fileicon">📄</span>
                  <span className="filename">{f.name}</span>
                  {f.size ? <span className="filesize">{fmtSize(f.size)}</span> : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  // assistant
  const blocks = Array.isArray(msg.blocks) ? msg.blocks : [];
  return (
    <div className="msg assistant">
      <div className="role">assistant</div>
      <div className="bubble">
        {blocks.map((b, i) => {
          if (b.type === "text") return <Markdown key={b.id || i} text={b.text} />;
          if (b.type === "tool_use") return <ToolCard key={b.id || i} block={b} />;
          if (b.type === "thinking")
            return (
              <details key={i} style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0" }}>
                <summary>thinking</summary>
                <div style={{ whiteSpace: "pre-wrap" }}>{b.thinking}</div>
              </details>
            );
          return null;
        })}
        {msg.streaming && <span className="dot busy" style={{ width: 6, height: 6, verticalAlign: "middle" }} />}
      </div>
    </div>
  );
}