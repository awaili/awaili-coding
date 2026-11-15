import { memo, useEffect, useMemo, useRef } from "react";
import { renderMarkdown, highlightAll } from "../lib/markdown.js";
import { mountBoards, freeBoards } from "../lib/figure.js";

function Markdown({ text }) {
  const ref = useRef(null);
  // renderMarkdown is marked + KaTeX + DOMPurify over the whole block — far too
  // expensive to redo on every render. During streaming the app re-renders on
  // every token, so without this memo each token re-parsed every message in the
  // transcript (the dominant cost of the streaming jank).
  const html = useMemo(() => renderMarkdown(text), [text]);
  useEffect(() => {
    const node = ref.current;
    let boards = null;
    let stale = false;
    // Both of these now fetch their (large) library on demand, so they resolve
    // after a tick. If this effect is torn down first — the text changed, or
    // the message unmounted — free whatever landed late instead of leaking it.
    highlightAll(node);
    mountBoards(node).then((b) => {
      if (stale) freeBoards(b);
      else boards = b;
    });
    // Release boards when text changes (React replaces innerHTML, so the old
    // board containers are gone — free internal listeners/intervals).
    return () => {
      stale = true;
      freeBoards(boards);
    };
  }, [html]);
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

// `text` is the only prop, so a parent re-render with unchanged text costs
// nothing.
export default memo(Markdown);