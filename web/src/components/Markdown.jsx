import { useEffect, useRef } from "react";
import { renderMarkdown, highlightAll } from "../lib/markdown.js";

export default function Markdown({ text }) {
  const ref = useRef(null);
  const html = renderMarkdown(text);
  useEffect(() => highlightAll(ref.current), [html]);
  return <div className="md" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}