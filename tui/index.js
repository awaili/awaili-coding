#!/usr/bin/env node
// coding-ui TUI — terminal client for the coding-ui backend.
//
// Connects to the backend WebSocket (same sessions/config as the web UI),
// streams Claude's replies, renders tool calls/results, and lets you run local
// shell commands with a leading "!".
//
// Usage:  npm run tui
// Env:    CODE_UI_WS   (default ws://127.0.0.1:3001/ws)
//         CODE_UI_CWD  (default working dir for !cmds and new sessions)

import blessed from "blessed";
import WebSocket from "ws";
import { spawn } from "node:child_process";
import { resolve, isAbsolute } from "node:path";

// Base WS URL for the backend. The server-internal token (CODE_UI_TOKEN)
// authorizes this locally-spawned TUI to open /ws without a browser cookie.
const WS_BASE = process.env.CODE_UI_WS || "ws://127.0.0.1:3001/ws";
const WS_TOKEN = process.env.CODE_UI_TOKEN || "";
const WS_URL = WS_TOKEN ? `${WS_BASE}?token=${encodeURIComponent(WS_TOKEN)}` : WS_BASE;
let cwd = process.env.CODE_UI_CWD || process.env.WORKSPACE_ROOT || "/data/coding-ui/workspace";
let model = "glm-5.2:cloud";
let sessionId = null;
let busy = false;
let connected = false;
let workspaceRoot = "";
let pendingText = null;
const history = [];
let histIdx = 0; // index into history; history.length == "new empty line"
// sessions: cached from every `sessions` event so /use <prefix> can resolve
// locally. The list is only printed to the log on explicit /sessions (or once
// on connect) — silently refreshing it after every turn was scrolling the
// just-received answer off-screen.
let sessionsCache = [];
let printNextSessions = false; // next `sessions` event should print to the log
let usePending = null; // /use <prefix> awaiting a `sessions` refresh to resolve
let pendingModel = null; // /model <name> awaiting the next /new to apply

// ---------- blessed setup ----------
const screen = blessed.screen({
  smartCRS: true,
  fullUnicode: true,
  title: "coding-ui TUI",
});

const header = blessed.box({
  top: 0,
  left: 0,
  right: 0,
  height: 1,
  tags: true,
  content: " {bold}coding-ui{/}  TUI · Claude Code + glm-5.2:cloud   {gray-fg}!cmd = shell · /help · C-q quit · C-a/e C-u/k/w C-c stop/clear{/}",
  style: { bg: "blue", fg: "white" },
});

const logBox = blessed.box({
  top: 1,
  left: 0,
  right: 0,
  bottom: 2,
  scrollable: true,
  alwaysScroll: true,
  keys: true,
  vi: true,
  mouse: true,
  tags: true,
  padding: { left: 1, right: 1 },
  style: { fg: "default", bg: "default" },
  scrollbar: { ch: " ", style: { bg: "blue" } },
});

const status = blessed.box({
  bottom: 1,
  left: 0,
  right: 0,
  height: 1,
  tags: true,
  style: { bg: "black", fg: "gray" },
});

// ---------- input line (custom readline-style editor) ----------
// blessed's textbox leaves arrow keys unimplemented (textarea.js "TODO:
// Handle directional keys"), has no readline control keys, and Escape cancels
// input — so editing felt worse than bash. This is a plain box with a hand-
// written line editor: visible block cursor, mid-line cursor movement,
// word/line kill, history, and bash-like C-c (stop turn / clear line).
const input = blessed.box({
  bottom: 0,
  left: 0,
  right: 0,
  height: 1,
  tags: true,
  style: { fg: "white", bg: "black" },
});

let buf = ""; // current input line
let cx = 0; // cursor index within buf
let winStart = 0; // leftmost visible column (horizontal scroll)

function renderInput() {
  const W = Math.max(1, input.width || 80);
  if (cx < winStart) winStart = cx;
  if (cx > winStart + W - 1) winStart = cx - W + 1;
  winStart = Math.max(0, Math.min(winStart, Math.max(0, buf.length - W + 1)));
  const before = buf.slice(winStart, cx);
  const cur = buf.slice(cx, cx + 1) || " ";
  const after = buf.slice(cx + 1, winStart + W);
  input.setContent(esc(before) + "{inverse}" + esc(cur) + "{/inverse}" + esc(after));
  screen.render();
}

function setBuf(s, atEnd = true) {
  buf = s;
  cx = atEnd ? buf.length : Math.min(cx, buf.length);
  winStart = 0;
  renderInput();
}

function submitInput() {
  const line = buf.replace(/\n$/, "");
  buf = "";
  cx = 0;
  winStart = 0;
  histIdx = history.length;
  renderInput();
  input.focus();
  if (!line.trim()) return;
  if (history[history.length - 1] !== line) history.push(line);
  handleLine(line);
}

function killWordBack() {
  let i = cx;
  while (i > 0 && /\s/.test(buf[i - 1])) i--;
  while (i > 0 && /\S/.test(buf[i - 1])) i--;
  buf = buf.slice(0, i) + buf.slice(cx);
  cx = i;
  renderInput();
}
function wordBack() {
  // index of the start of the word left of cx (skipping blanks first)
  let i = cx;
  while (i > 0 && /\s/.test(buf[i - 1])) i--;
  while (i > 0 && /\S/.test(buf[i - 1])) i--;
  return i;
}
function wordFwd() {
  // index just past the word right of cx (skipping blanks first)
  let i = cx;
  while (i < buf.length && /\s/.test(buf[i])) i++;
  while (i < buf.length && /\S/.test(buf[i])) i++;
  return i;
}
function killWordFwd() {
  const j = wordFwd();
  buf = buf.slice(0, cx) + buf.slice(j);
  renderInput();
}
function transpose() {
  // readline C-t: swap the two chars before cx; advance cursor. At EOL the
  // swap is the last two chars; otherwise it pivots around cx.
  if (cx < buf.length) cx++;
  if (cx < 2) return renderInput();
  buf = buf.slice(0, cx - 2) + buf[cx - 1] + buf[cx - 2] + buf.slice(cx);
  renderInput();
}

input.on("keypress", (ch, key) => {
  if (!key) return;
  const name = key.name;
  const ctrl = !!key.ctrl;
  const meta = !!key.meta;

  if (name === "enter" || name === "return") return submitInput();

  // scrolling / log shortcuts (usable while typing)
  if (name === "pageup") {
    logBox.scroll(-(logBox.height - 2) || -10);
    screen.render();
    return;
  }
  if (name === "pagedown") {
    logBox.scroll((logBox.height - 2) || 10);
    screen.render();
    return;
  }
  if (ctrl && name === "l") return clearLog();

  // C-q: quit (global fallback also below). C-c: bash-like — stop a running
  // turn, else clear the current line (instead of killing the whole TUI).
  if (ctrl && name === "q") {
    quitting = true;
    process.exit(0);
  }
  if (ctrl && name === "c") {
    if (busy) {
      if (sessionId) send({ type: "stop", sessionId });
      push(C.sys("stop sent"));
      setStatus();
      return;
    }
    return setBuf("");
  }

  // cursor movement
  if (name === "left" || (ctrl && name === "b")) {
    if (cx > 0) cx--;
    return renderInput();
  }
  if (name === "right" || (ctrl && name === "f")) {
    if (cx < buf.length) cx++;
    return renderInput();
  }
  if (name === "home" || (ctrl && name === "a")) {
    cx = 0;
    return renderInput();
  }
  if (name === "end" || (ctrl && name === "e")) {
    cx = buf.length;
    return renderInput();
  }

  // history (up/down + readline C-p/C-n)
  if (name === "up" || (ctrl && name === "p")) {
    if (histIdx > 0) {
      histIdx--;
      setBuf(history[histIdx] || "");
    }
    return;
  }
  if (name === "down" || (ctrl && name === "n")) {
    if (histIdx < history.length - 1) {
      histIdx++;
      setBuf(history[histIdx] || "");
    } else {
      histIdx = history.length;
      setBuf("");
    }
    return;
  }

  // deletion
  if (name === "backspace" || (ctrl && name === "h")) {
    if (cx > 0) {
      buf = buf.slice(0, cx - 1) + buf.slice(cx);
      cx--;
      renderInput();
    }
    return;
  }
  if (name === "delete" || (ctrl && name === "d")) {
    if (cx < buf.length) {
      buf = buf.slice(0, cx) + buf.slice(cx + 1);
      renderInput();
    }
    return;
  }
  if (ctrl && name === "u") {
    buf = buf.slice(cx);
    cx = 0;
    return renderInput();
  } // kill to start
  if (ctrl && name === "k") {
    buf = buf.slice(0, cx);
    return renderInput();
  } // kill to end
  if (ctrl && name === "w") return killWordBack(); // kill word back
  if (ctrl && name === "t") return transpose(); // transpose chars

  // meta (Alt) word ops — readline M-b/M-f move, M-d/M-BS kill
  if (meta && (name === "b")) {
    cx = wordBack();
    return renderInput();
  }
  if (meta && name === "f") {
    cx = wordFwd();
    return renderInput();
  }
  if (meta && name === "d") return killWordFwd();
  if (meta && (name === "backspace" || name === "h" || name === "w"))
    return killWordBack();

  // printable characters (ignore control combos / non-printables)
  if (!ctrl && !meta && ch && !/[\x00-\x1f\x7f]/.test(ch)) {
    buf = buf.slice(0, cx) + ch + buf.slice(cx);
    cx += ch.length;
    renderInput();
  }
});

screen.append(header);
screen.append(logBox);
screen.append(status);
screen.append(input);
input.focus();
renderInput();

// ---------- line buffer (we rewrite lines for streaming) ----------
const lines = [];
let curTextIdx = -1; // current streaming assistant text line
const toolLines = new Map(); // tool_use_id -> line index

function esc(s) {
  return String(s ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/([{}])/g, "\\$1");
}
function render() {
  logBox.setContent(lines.join("\n"));
  logBox.setScrollPerc(100);
  screen.render();
}
function push(s) {
  lines.push(s);
  render();
  return lines.length - 1;
}
function setLine(i, s) {
  if (i >= 0 && i < lines.length) lines[i] = s;
  render();
}
function appendTo(i, d) {
  if (i >= 0 && i < lines.length) lines[i] = (lines[i] || "") + d;
  render();
}
function clearLog() {
  lines.length = 0;
  curTextIdx = -1;
  toolLines.clear();
  render();
}

function setStatus() {
  const conn = connected ? "{green-fg}●{/} connected" : "{red-fg}○ connecting…{/}";
  const st = busy ? "{yellow-fg}working…{/}" : "{green-fg}idle{/}";
  status.setContent(
    ` ${conn}   {gray-fg}model{/} ${esc(model)}   {gray-fg}cwd{/} ${esc(cwd)}   {gray-fg}session{/} ${sessionId ? esc(sessionId.slice(0, 8)) : "—"}   ${st}`,
  );
  screen.render();
}

// ---------- colors via blessed tags ----------
const C = {
  you: (s) => `{cyan-fg}you>{/} ${esc(s)}`,
  claude: (s) => `{green-fg}claude>{/} ${esc(s)}`,
  tool: (name, sum, pending) =>
    `  {yellow-fg}🔧 ${esc(name)}{/}${sum ? ": " + esc(sum) : ""}${pending ? " …" : ""}`,
  result: (ok, snippet) => `     ${ok ? "{green-fg}✓{/}" : "{red-fg}✕{/}"} ${esc(snippet)}`,
  cmd: (s) => `{magenta-fg}$ {/}${esc(s)}`,
  out: (s) => `{gray-fg}${esc(s)}{/}`,
  sys: (s) => `{gray-fg}${esc(s)}{/}`,
  err: (s) => `{red-fg}${esc(s)}{/}`,
};

// Resolve a /use argument (full id or unique prefix) to a cached session.
// Returns the session or null if none/ambiguous. Case-insensitive on the hex id.
function resolveSession(query) {
  const q = String(query || "").toLowerCase();
  if (!q) return null;
  const matches = sessionsCache.filter((s) => s.id.toLowerCase() === q || s.id.toLowerCase().startsWith(q));
  if (matches.length === 1) return matches[0];
  return null;
}

function toolSummary(name, input) {
  const i = input || {};
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return i.file_path || "";
    case "Bash":
      return i.command || "";
    case "Glob":
    case "Grep":
      return i.pattern || "";
    default:
      return "";
  }
}
function resultSnippet(content) {
  let text = content;
  if (Array.isArray(content))
    text = content.map((b) => (typeof b === "string" ? b : b?.text || "")).join("");
  text = String(text ?? "");
  const firstLine = text.split("\n")[0] || "";
  return firstLine.length > 160 ? firstLine.slice(0, 157) + "…" : firstLine;
}

// ---------- WebSocket ----------
let ws;
function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    connected = true;
    setStatus();
    push(C.sys(`Connected to ${WS_URL}`));
    printNextSessions = true;
    send({ type: "list" });
  });

  ws.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch {
      return;
    }
    onEvent(evt);
  });

  ws.on("close", () => {
    connected = false;
    busy = false;
    setStatus();
    if (!quitting) push(C.err("Disconnected — retrying in 2s…"));
    setTimeout(() => !quitting && connect(), 2000);
  });
  ws.on("error", () => {}); // close handler covers reconnect
}
function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onEvent(evt) {
  switch (evt.type) {
    case "hello":
      workspaceRoot = evt.config?.workspaceRoot || "";
      push(C.sys(`Workspace root: ${workspaceRoot || "(?)"}`));
      push(C.sys(`Type a message to chat, !cmd to run a shell command, /help for commands.`));
      setStatus();
      break;
    case "sessions":
      sessionsCache = evt.items || [];
      if (printNextSessions) {
        printNextSessions = false;
        if (!sessionsCache.length) push(C.sys("No sessions yet."));
        else
          sessionsCache.forEach((s) =>
            push(C.sys(`${s.id.slice(0, 8)}  ${s.busy ? "(busy)" : s.ended ? "(ended)" : ""}  ${s.title || ""}`)),
          );
      }
      if (usePending) {
        const want = usePending;
        usePending = null;
        const match = resolveSession(want);
        if (!match) push(C.err(`no session matching '${want}' (try /sessions)`));
        else {
          sessionId = null;
          send({ type: "start", sessionId: match.id, cwd });
        }
      }
      break;
    case "session":
      sessionId = evt.sessionId;
      busy = false;
      curTextIdx = -1;
      toolLines.clear();
      push(C.sys(`Session ${sessionId.slice(0, 8)} @ ${evt.cwd}${evt.resumed ? " (resumed)" : ""}`));
      setStatus();
      if (pendingText != null) {
        const t = pendingText;
        pendingText = null;
        push(C.you(t));
        send({ type: "send", sessionId, text: t });
        busy = true;
        setStatus();
      }
      break;
    case "claude":
      handleClaude(evt.data);
      break;
    case "error":
      push(C.err(evt.message || "error"));
      break;
    default:
      break;
  }
}

function handleClaude(data) {
  if (!data) return;
  if (data.type === "system" && data.subtype === "init") {
    if (data.model) model = data.model;
    setStatus();
    return;
  }
  if (data.type === "stream_event") return handleStream(data.event);
  if (data.type === "assistant") return handleAssistant(data);
  if (data.type === "user") return handleToolResult(data);
  if (data.type === "result") {
    busy = false;
    if (curTextIdx >= 0 && lines[curTextIdx]?.endsWith("▌")) setLine(curTextIdx, lines[curTextIdx].slice(0, -1));
    curTextIdx = -1;
    push("");
    setStatus();
    return;
  }
}

function handleStream(ev) {
  if (!ev) return;
  if (ev.type === "message_start") {
    const id = ev.message?.id;
    if (!id) return;
    busy = true;
    setStatus();
    curTextIdx = push(C.claude("▌"));
    return;
  }
  if (ev.type === "content_block_start") {
    const cb = ev.content_block || {};
    if (cb.type === "tool_use") {
      const idx = push(C.tool(cb.name, toolSummary(cb.name, cb.input), true));
      toolLines.set(cb.id, idx);
    }
    // text/thinking blocks stream into curTextIdx
    return;
  }
  if (ev.type === "content_block_delta") {
    const d = ev.delta || {};
    if (d.type === "text_delta") {
      // strip the trailing cursor, append, re-add cursor
      const base = (lines[curTextIdx] || "").replace(/▌$/, "");
      setLine(curTextIdx, base + d.text + "▌");
    } else if (d.type === "thinking_delta") {
      // keep thinking out of the main text line for simplicity
    }
    return;
  }
}

function handleAssistant(data) {
  const msg = data.message || {};
  for (const c of msg.content || []) {
    if (c.type === "text") {
      if (curTextIdx >= 0) setLine(curTextIdx, C.claude(c.text));
      else curTextIdx = push(C.claude(c.text));
    } else if (c.type === "tool_use") {
      const idx = toolLines.get(c.id);
      if (idx >= 0) setLine(idx, C.tool(c.name, toolSummary(c.name, c.input), true));
      else toolLines.set(c.id, push(C.tool(c.name, toolSummary(c.name, c.input), true)));
    }
  }
}

function handleToolResult(data) {
  const content = data.message?.content || [];
  for (const tr of content) {
    if (tr.type !== "tool_result") continue;
    const idx = toolLines.get(tr.tool_use_id);
    if (idx >= 0) {
      const cur = lines[idx].replace(/ …$/, "");
      setLine(idx, cur.replace(/ …$/, ""));
      // re-render without pending marker
      lines[idx] = (lines[idx] || "").replace(/ …$/, "");
      render();
    }
    push(C.result(!tr.is_error, resultSnippet(tr.content)));
  }
}

// input is handled by the custom editor above (submitInput → handleLine).

function handleLine(line) {
  if (line.startsWith("/")) return handleSlash(line.trim());
  if (line.startsWith("!")) return runShell(line.slice(1));
  // chat message
  if (!connected) {
    push(C.err("Not connected yet."));
    return;
  }
  if (!sessionId) {
    pendingText = line;
    push(C.you(line));
    send({ type: "start", cwd, model: pendingModel || undefined });
    pendingModel = null;
    return;
  }
  push(C.you(line));
  send({ type: "send", sessionId, text: line });
  busy = true;
  curTextIdx = -1;
  toolLines.clear();
  setStatus();
}

function runShell(cmd) {
  const c = cmd.trim();
  if (!c) return;
  push(C.cmd(c));
  const child = spawn(c, { shell: true, cwd, env: process.env });
  const pushOut = (buf, err) => {
    for (const l of buf.toString().replace(/\n$/, "").split("\n")) push(C.out(l));
  };
  child.stdout.on("data", (b) => pushOut(b));
  child.stderr.on("data", (b) => pushOut(b));
  child.on("exit", (code) => {
    if (code !== 0) push(C.err(`(exit ${code})`));
    push("");
  });
}

function handleSlash(line) {
  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "help":
    case "h":
      push(C.sys("Commands:"));
      push(C.sys("  /new [dir]      start a new chat session"));
      push(C.sys("  /cwd <path>     set working dir for !cmds and new sessions"));
      push(C.sys("  /sessions       list sessions"));
      push(C.sys("  /use <id>       resume a session by id (prefix ok)"));
      push(C.sys("  /model [name]   show model, or set model for next /new (or switch current)"));
      push(C.sys("  /stop           stop the current turn"));
      push(C.sys("  /clear          clear the log"));
      push(C.sys("  !<cmd>          run a shell command in cwd"));
      push(C.sys("  /quit (or C-q)  exit"));
      push(C.sys(""));
      push(C.sys("Line editing (readline-style):"));
      push(C.sys("  C-a / Home      cursor to start    C-e / End      cursor to end"));
      push(C.sys("  Left / C-b      cursor left        Right / C-f    cursor right"));
      push(C.sys("  M-b / M-f       word back / fwd    M-d / M-BS     kill word fwd/back"));
      push(C.sys("  C-u             kill to start      C-k            kill to end"));
      push(C.sys("  C-w             kill word back     Backspace/Del  delete char"));
      push(C.sys("  C-t             transpose chars    Up / C-p / C-n history back/fwd"));
      push(C.sys("  C-c             stop turn / clear line           C-l  clear log"));
      break;
    case "new": {
      if (arg) cwd = isAbsolute(arg) ? resolve(arg) : resolve(cwd, arg);
      sessionId = null;
      curTextIdx = -1;
      toolLines.clear();
      send({ type: "start", cwd, model: pendingModel || undefined });
      pendingModel = null;
      break;
    }
    case "cwd":
      if (!arg) push(C.sys(`cwd = ${cwd}`));
      else {
        cwd = isAbsolute(arg) ? resolve(arg) : resolve(cwd, arg);
        push(C.sys(`cwd → ${cwd}`));
        setStatus();
      }
      break;
    case "sessions":
      printNextSessions = true;
      send({ type: "list" });
      break;
    case "model": {
      if (!arg) {
        push(C.sys(`model = ${model}${pendingModel ? `  (next /new → ${pendingModel})` : ""}`));
      } else if (sessionId) {
        // Switch the current session's model: restart with --resume under it.
        send({ type: "start", sessionId, model: arg });
        push(C.sys(`switching session ${sessionId.slice(0, 8)} to ${arg} (resuming)…`));
      } else {
        pendingModel = arg;
        push(C.sys(`model for next /new → ${arg}`));
      }
      break;
    }
    case "use": {
      if (!arg) return push(C.err("usage: /use <id>"));
      const match = resolveSession(arg);
      if (match) {
        sessionId = null;
        send({ type: "start", sessionId: match.id, cwd });
      } else {
        // cache may be stale/empty — refresh, then resolve in the sessions handler
        usePending = arg;
        send({ type: "list" });
      }
      break;
    }
    case "stop":
      if (sessionId) send({ type: "stop", sessionId });
      push(C.sys("stop sent"));
      break;
    case "clear":
      clearLog();
      break;
    case "quit":
    case "exit":
      quitting = true;
      process.exit(0);
      break;
    default:
      push(C.err(`unknown command: /${cmd} (try /help)`));
  }
}

// ---------- keys ----------
let quitting = false;
// C-c is handled by the input editor (stop turn / clear line). C-q quits from
// anywhere (fallback for when focus is on the log box rather than the input).
screen.key(["C-q"], () => {
  quitting = true;
  process.exit(0);
});

setStatus();
connect();