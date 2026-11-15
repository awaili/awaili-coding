import { useEffect, useRef, useState } from "react";

// Custom model picker for the topbar. The old native <select> could only show
// the model name, so capability info had to be squeezed into the option text;
// this dropdown gives each model a full two-line entry — name + capability
// chips, then a plain-language capability sentence — and groups models by
// which subscription/channel they ride on. Capability data is authoritative
// from the server (/api/models `capabilities`: {vision, imagegen, video,
// source}); models missing from the map (stale server, custom names) fall
// back to a bare name row so they stay selectable.

function capsOf(caps, name) {
  const c = caps && caps[name];
  if (!c || typeof c !== "object") return null;
  return {
    vision: !!c.vision,
    imagegen: !!c.imagegen,
    video: !!c.video,
    source: c.source || "本地网关模型",
  };
}

// Chips rendered next to the model name — kept short; the sentence below the
// name carries the full wording.
function chips(c) {
  if (!c) return null;
  const out = [];
  if (c.imagegen) out.push(<span key="ig" className="chip chip-gen">生图</span>);
  if (c.video) out.push(<span key="vd" className="chip chip-gen">生视频</span>);
  if (c.vision) out.push(<span key="vi" className="chip">多模态</span>);
  else out.push(<span key="tx" className="chip chip-text">文本</span>);
  return <span className="chips">{out}</span>;
}

// The full plain-language capability line under the model name.
function describe(c) {
  if (!c) return "";
  const parts = [];
  parts.push(c.vision ? "支持图片输入（贴图/附件直接看图）" : "仅文本输入（贴图会自动转写为文字）");
  if (c.imagegen) parts.push("支持图片生成");
  if (c.video) parts.push("支持视频生成");
  if (c.imagegen) parts.push("生成走订阅额度，不额外计费");
  return parts.join(" · ");
}

export default function ModelPicker({ value, options, caps, onChange, onOpen }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  // Close on outside click / Escape — standard dropdown hygiene.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Group by source (subscription / gateway), preserving the server's order
  // within each group; groups appear in first-encounter order.
  const groups = [];
  const groupIndex = new Map();
  for (const m of options) {
    const c = capsOf(caps, m);
    const src = c ? c.source : "本地网关模型";
    if (!groupIndex.has(src)) {
      groupIndex.set(src, groups.length);
      groups.push({ source: src, models: [] });
    }
    groups[groupIndex.get(src)].models.push(m);
  }

  const current = capsOf(caps, value);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        className={"model-pick" + (open ? " open" : "")}
        onClick={() => {
          if (!open && onOpen) onOpen();
          setOpen((o) => !o);
        }}
        title={current ? describe(current) : "Choose model"}
      >
        <span className="model-pick-name">{value}</span>
        {current && (
          <span className="chips">
            {current.imagegen && <span className="chip chip-gen">生图</span>}
            {current.video && <span className="chip chip-gen">生视频</span>}
            {current.vision ? <span className="chip">多模态</span> : <span className="chip chip-text">文本</span>}
          </span>
        )}
        <span className="model-pick-caret">▾</span>
      </button>
      {open && (
        <div className="model-menu">
          {groups.map((g) => (
            <div key={g.source} className="model-group">
              <div className="model-group-title">{g.source}</div>
              {g.models.map((m) => {
                const c = capsOf(caps, m);
                return (
                  <button
                    key={m}
                    className={"model-item" + (m === value ? " active" : "")}
                    onClick={() => {
                      setOpen(false);
                      if (m !== value) onChange({ target: { value: m } });
                    }}
                  >
                    <div className="model-item-head">
                      <span className="model-item-name">{m}</span>
                      {chips(c)}
                    </div>
                    {c && <div className="model-item-desc">{describe(c)}</div>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
