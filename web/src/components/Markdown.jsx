import { useEffect, useRef } from "react";
import { renderMarkdown, highlightAll } from "../lib/markdown.js";
import { mountBoards, freeBoards } from "../lib/figure.js";

export default function Markdown({ text }) {
  const ref = useRef(null);
  const html = renderMarkdown(text);
  useEffect(() => {
    const node = ref.current;
    highlightAll(node);
    const boards = mountBoards(node);
    // Release boards when text changes (React replaces innerHTML, so the old
    // board containers are gone — free internal listeners/intervals).
    return () => freeBoards(boards);
  }, [html]);
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}