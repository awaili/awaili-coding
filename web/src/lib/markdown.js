import { marked } from "marked";
import hljs from "highlight.js";
import DOMPurify from "dompurify";
import markedKatex from "marked-katex-extension";
// KaTeX's stylesheet (fonts + layout). Vite bundles the CSS and the woff/ttf
// font assets it references, so math renders with the correct glyphs/sizing.
import "katex/dist/katex.min.css";

marked.setOptions({ gfm: true, breaks: false });

// Math support: intercept $...$ (inline) and $$...$$ (display) BEFORE marked's
// own inline parsing so underscores/carets inside formulas aren't mangled into
// emphasis. output:"html" skips KaTeX's MathML mirror so DOMPurify (html
// profile) has nothing to strip; KaTeX's visible HTML uses only span/class/
// style/aria-hidden, all preserved by DOMPurify's defaults. throwOnError:false
// renders a best-effort (or a red error) instead of throwing on bad LaTeX.
//
// nonStandard:true relaxes the delimiter boundary checks. The extension's
// default ("standard") rule only treats $...$ as math when the opening $ is
// preceded by a space AND the closing $ is followed by whitespace or one of
// ?!.,:？！。，： — so in CJK text where math is packed without surrounding
// spaces and abuts punctuation like 、；（） (e.g. "真子集 $A\subsetneqq B$、"
// or "（$y=kx+b$）" or "...end{cases}$（$t$"), the formula is NOT recognized and
// renders as literal text. nonStandard drops those boundary checks so $...$
// matches regardless of adjacent characters. Tradeoff: two literal $ in prose
// (e.g. "价格 $5 和 $6") can be misread as math — rare in AI math output, and
// throwOnError:false still shows the text rather than crashing.
marked.use(
  markedKatex({
    throwOnError: false,
    output: "html",
    nonStandard: true,
  }),
);

// marked v18 ships no built-in sanitizer, so its HTML output is injected via
// dangerouslySetInnerHTML for both chat assistant text and the Editor markdown
// preview. Without sanitization, any HTML in the markdown (a malicious
// workspace .md file, or tool output echoed by Claude containing
// <script>/<img onerror>/<a href="javascript:…">) executes at same origin and
// can drive /api/* (overwrite files, delete workspaces). DOMPurify strips it
// while keeping KaTeX's span-based rendering intact.
export function renderMarkdown(text) {
  const html = marked.parse(text ?? "");
  const str = typeof html === "string" ? html : "";
  return DOMPurify.sanitize(str, {
    USE_PROFILES: { html: true },
    // allow target=_blank on links but force rel so it's safe
    ADD_ATTR: ["target", "rel"],
  });
}

// Highlight all <pre><code> blocks inside a container after render.
export function highlightAll(container) {
  if (!container) return;
  for (const block of container.querySelectorAll("pre code")) {
    if (block.dataset.hl) continue;
    try {
      hljs.highlightElement(block);
      block.dataset.hl = "1";
    } catch {
      /* unknown language */
    }
  }
}