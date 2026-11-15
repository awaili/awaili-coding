import { useEffect, useState } from "react";

// Fullscreen viewer for images rendered inside chat bubbles. Mounted once at
// the app root; a document-level click listener catches <img> elements in any
// bubble (user attachments, markdown embeds, tool output) without threading
// handlers through every render path. Escape / click-outside closes.
export default function Lightbox() {
  const [src, setSrc] = useState(null);
  const [alt, setAlt] = useState("");

  useEffect(() => {
    const onClick = (e) => {
      const im = e.target.closest("img");
      if (!im || !im.closest(".bubble")) return;
      const url = im.currentSrc || im.src;
      if (!url) return;
      e.preventDefault();
      setSrc(url);
      setAlt(im.alt || "");
    };
    const onKey = (e) => {
      if (e.key === "Escape") setSrc(null);
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!src) return null;
  return (
    <div className="lightbox" onClick={() => setSrc(null)}>
      <img className="lightbox-img" src={src} alt={alt} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar">
        {alt && <span className="lightbox-name">{alt}</span>}
        <a className="lightbox-dl" href={src} download target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>
          Download original
        </a>
        <button className="lightbox-close" onClick={() => setSrc(null)}>
          ✕ close
        </button>
      </div>
    </div>
  );
}
