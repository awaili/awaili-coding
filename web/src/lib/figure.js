// Interactive math figures via JSXGraph, embedded in markdown as
//   ```jsxgraph
//   { "bbox": [...], "elements": [ ... ] }
//   ```
// fenced blocks holding a JSON spec. Mounted after-the-fact (the same way
// `highlightAll` highlights code) by scanning the live DOM for
// <pre><code class="language-jsxgraph"> and swapping each <pre> for a board.
//
// jsxgraph's package.json "exports" only exposes src/index.js, so a bare
// subpath like "jsxgraph/distrib/jsxgraph.css" fails under Vite's
// exports-aware resolver; import the stylesheet by relative path instead.
import JXG from "jsxgraph";
import "../../../node_modules/jsxgraph/distrib/jsxgraph.css";

// Spec elements that plot a function carry an expression string ("f": "x+1")
// which we compile with the Function constructor. The .md content is trusted
// / authored (DOMPurify never executes it — only this module does), so
// evaluating author-supplied expressions is acceptable for this app.
const exprFn = (src) => new Function("x", "return (" + src + ");");

let seq = 0;

// Parent points for line/segment/circle/ellipse/polygon are created hidden so
// only elements explicitly declared as {type:"point"} show up — keeps diagrams
// clean (no stray draggable vertices / labels).
function hiddenPt(board, coords) {
  return board.create("point", coords, { visible: false, fixed: true, name: "" });
}

function createEl(board, el) {
  const a = el.attr || {};
  switch (el.type) {
    case "functiongraph":
      return board.create("functiongraph", [exprFn(el.f)], a);
    case "point":
      return board.create("point", el.coords, { size: 3, ...a });
    case "line":
      return board.create("line", [hiddenPt(board, el.p1), hiddenPt(board, el.p2)], { fixed: true, ...a });
    case "segment":
      return board.create("segment", [hiddenPt(board, el.p1), hiddenPt(board, el.p2)], { fixed: true, ...a });
    case "arrow":
      return board.create("arrow", [hiddenPt(board, el.p1), hiddenPt(board, el.p2)], { fixed: true, ...a });
    case "circle":
      return el.radius != null
        ? board.create("circle", [hiddenPt(board, el.center), el.radius], { fixed: true, ...a })
        : board.create("circle", [hiddenPt(board, el.center), hiddenPt(board, el.p)], { fixed: true, ...a });
    case "ellipse":
      return board.create("ellipse", [hiddenPt(board, el.center), hiddenPt(board, el.a), hiddenPt(board, el.b)], { fixed: true, ...a });
    case "polygon":
      return board.create("polygon", el.points.map((p) => hiddenPt(board, p)), a);
    case "text":
      return board.create("text", [el.coords[0], el.coords[1], el.html], a);
    case "curve": {
      const fx = exprFn(el.f);
      const fy = exprFn(el.g);
      return board.create("curve", [fx, fy, el.tmin ?? -10, el.tmax ?? 10], a);
    }
    default:
      console.warn("[jsxgraph] unknown element type:", el.type);
      return null;
  }
}

// Scan `container` for jsxgraph code fences and mount a board in place of each.
// Returns the list of created boards so the caller can freeBoards() them on
// cleanup (React re-renders replace innerHTML, so old boards must be released
// to avoid leaks / duplicate intervals).
export function mountBoards(container) {
  if (!container) return [];
  const codes = container.querySelectorAll("pre > code.language-jsxgraph");
  const boards = [];
  codes.forEach((code) => {
    const pre = code.parentElement;
    let spec;
    try {
      spec = JSON.parse(code.textContent);
    } catch (e) {
      pre.replaceWith(errNode("jsxgraph: JSON 解析失败 — " + e.message));
      return;
    }
    const id = "jxg-" + (++seq);
    const box = document.createElement("div");
    box.id = id;
    box.className = "jxgbox";
    const h = Number.isFinite(spec.height) ? spec.height : 320;
    box.style.cssText =
      "width:100%;max-width:460px;height:" + h + "px;border:1px solid #e3e3e3;border-radius:6px;margin:10px 0";
    pre.replaceWith(box);
    let board;
    try {
      board = JXG.JSXGraph.initBoard(id, {
        boundingbox: spec.bbox || [-5, 5, 5, -5],
        axis: spec.axis !== false,
        grid: !!spec.grid,
        showCopyright: false,
        showNavigation: spec.nav !== false,
        keepaspectratio: spec.keepaspectratio !== false,
      });
      (spec.elements || []).forEach((el) => createEl(board, el));
    } catch (e) {
      console.warn("[jsxgraph] mount failed:", e);
    }
    if (board) boards.push(board);
  });
  return boards;
}

export function freeBoards(boards) {
  (boards || []).forEach((b) => {
    try {
      JXG.JSXGraph.freeBoard(b);
    } catch {
      /* board already gone */
    }
  });
}

function errNode(msg) {
  const d = document.createElement("div");
  d.style.cssText = "color:#b00;font-family:monospace;font-size:13px;margin:8px 0";
  d.textContent = msg;
  return d;
}