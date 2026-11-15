import { Fragment, Suspense, lazy, useEffect, useRef, useState } from "react";
import { useSocket } from "./hooks/useSocket.js";
import Sidebar from "./components/Sidebar.jsx";
import Message from "./components/Message.jsx";
import PromptCard from "./components/PromptCard.jsx";
import Composer from "./components/Composer.jsx";
import FileTree from "./components/FileTree.jsx";
import Editor from "./components/Editor.jsx";
// xterm + its addon and stylesheet are ~85 KB gzipped and only matter once the
// user opens the TUI or Shell overlay, so the terminal is a lazy chunk rather
// than part of the initial bundle.
const Terminal = lazy(() => import("./components/Terminal.jsx"));
import Skills from "./components/Skills.jsx";
// The usage panel pulls four provider quota APIs + a transcript ledger; it is
// only opened on demand, so keep it out of the initial bundle.
const Usage = lazy(() => import("./components/Usage.jsx"));
import ModelPicker from "./components/ModelPicker.jsx";
import Lightbox from "./components/Lightbox.jsx";
import Login from "./components/Login.jsx";

const empty = [];

// Format a USD cost: show enough precision that sub-cent per-turn costs are
// visible, but don't spam trailing zeros for larger totals.
function formatCost(usd) {
  if (usd == null) return null;
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

// Format a millisecond duration as e.g. "1.2s" / "47s" / "3m12s".
function formatDuration(ms) {
  if (ms == null) return null;
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m${rem}s`;
}

// Compact integer with k/m suffix for token counts.
function formatTokens(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

// Derive a workspace's folder name from its absolute path (null for the root
// workspace, which is not deletable).
function workspaceName(cwd, root) {
  if (!cwd || !root || cwd === root) return null;
  const rel = cwd.startsWith(root + "/") ? cwd.slice(root.length + 1) : cwd.slice(root.length);
  return rel || null;
}

// Normalize one history message (from the `history` / `historyMore` WS events)
// into the in-app shape. History images arrive as lightweight {mediaType, url}
// refs served by GET /api/transcript/image; synthesize a dataUrl fallback if
// raw base64 `data` arrives without a url/dataUrl. Assistant messages are
// forced to a `blocks` array so Message's .map never throws on an unexpected
// Anthropic `content` shape. Shared by the initial history load and older-page
// prepends so both go through the same normalization.
function normalizeHistMsg(m) {
  if (m.role === "user" && Array.isArray(m.images) && m.images.length) {
    return {
      ...m,
      images: m.images.map((im) =>
        im.url || im.dataUrl
          ? im
          : { ...im, dataUrl: `data:${im.mediaType || "image/png"};base64,${im.data}` },
      ),
    };
  }
  if (m.role === "assistant") {
    const blocks = Array.isArray(m.blocks)
      ? m.blocks
      : (Array.isArray(m.content) ? m.content : []).map((c) => {
          if (c.type === "text") return { type: "text", text: c.text || "" };
          if (c.type === "tool_use")
            return { type: "tool_use", id: c.id, name: c.name, input: c.input, pending: true };
          if (c.type === "thinking") return { type: "thinking", thinking: c.thinking || "" };
          return { type: "other", raw: c };
        });
    return { ...m, blocks, streaming: false };
  }
  return m;
}

// One-line metrics bar shown above the composer for the active session. Splits
// into "this turn" (token breakdown from the last result's usage.*) and
// "session" (cumulative cost/duration/turns claude reports in the same event).
// Hidden until the first turn completes (no metrics yet).
// What the model actually received for an image it can't see natively: the
// server transcribed the image with a vision model and forwarded that text.
// The step is lossy (a summarizer would drop the exact identifiers that make a
// stack trace useful), so the result stays inspectable rather than hidden —
// collapsed by default to keep the transcript readable.
function VisionNote({ note }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="vision-note">
      <button className="vision-note-head" onClick={() => setOpen((o) => !o)}>
        🖼 transcribed to text by {note.model}{note.truncated ? " (truncated)" : ""} · {open ? "hide" : "show"}
      </button>
      {open && <pre className="vision-note-body">{note.text}</pre>}
    </div>
  );
}

function MetricsBar({ metrics }) {
  if (!metrics) return null;
  const inT = metrics.inputTokens || 0;
  const outT = metrics.outputTokens || 0;
  const cacheR = metrics.cacheReadTokens || 0;
  const cacheW = metrics.cacheCreationTokens || 0;
  const cost = formatCost(metrics.totalCostUsd);
  const dur = formatDuration(metrics.totalDurationMs);
  const turns = metrics.totalTurns;
  return (
    <div className="metrics-bar" title="Last-turn tokens · cumulative session cost / duration / turns">
      <span className="metrics-label">last turn</span>
      <span className="metrics-pair" title={`input ${inT} · output ${outT} · cache read ${cacheR} · cache write ${cacheW}`}>
        <span className="metrics-tok-in">↑{formatTokens(inT)}</span>
        <span className="metrics-tok-out">↓{formatTokens(outT)}</span>
        {(cacheR || cacheW) > 0 && (
          <span className="metrics-tok-cache" title="cache read / write tokens">
            ⚡{formatTokens(cacheR + cacheW)}
          </span>
        )}
      </span>
      <span className="metrics-sep">·</span>
      <span className="metrics-label">session</span>
      <span className="metrics-pair">
        {cost != null && <span title="cumulative cost">{cost}</span>}
        {dur != null && <span title="cumulative wall-clock duration">{dur}</span>}
        {turns != null && <span title="cumulative turns">{turns}t</span>}
      </span>
    </div>
  );
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [msgs, setMsgs] = useState({}); // {sessionId: messages[]}
  // Per-session pagination metadata for the transcript window: {sessionId:
  // {oldestIndex, hasMore, loading}}. `oldestIndex` is the front-indexed
  // cursor of the oldest currently-held message (stable under appends); used
  // to fetch the next older page via `historyMore`.
  const [historyMetaBy, setHistoryMetaBy] = useState({});
  const [busyBy, setBusyBy] = useState({}); // {sessionId: bool}
  // Per-session metrics from the last completed turn (tokens for that turn +
  // session-cumulative cost/duration/turns). Populated from the `result`
  // stream event (live) and the `sessions` broadcast (restored from disk on
  // reconnect). Surfaced in a metrics bar under the active chat and as a
  // cost line in each sidebar row.
  const [metricsBy, setMetricsBy] = useState({}); // {sessionId: metrics}
  const [promptsBy, setPromptsBy] = useState({}); // {sessionId: [{requestId, request}]}
  const [confirmMode, setConfirmMode] = useState(false); // interactive confirm mode for new chats
  const [visionModels, setVisionModels] = useState([]); // gateway models that accept image input
  const [modelCaps, setModelCaps] = useState({}); // {model: ["vision","imagegen"]} from /api/models
  const [cwdBy, setCwdBy] = useState({}); // {sessionId: cwd}
  const [model, setModel] = useState("glm-5.2:cloud"); // active session's live model
  const [modelOptions, setModelOptions] = useState(["glm-5.2:cloud"]);
  const [defaultModel, setDefaultModel] = useState("glm-5.2:cloud");
  const [selectedModel, setSelectedModel] = useState("glm-5.2:cloud"); // model for the next new chat
  const [workspaces, setWorkspaces] = useState([]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [selectedCwd, setSelectedCwd] = useState("");
  const [status, setStatus] = useState("connecting");
  const [termMode, setTermMode] = useState(null); // null | "tui" | "shell"
  const [skillsOpen, setSkillsOpen] = useState(false); // Skills manager overlay
  const [usageOpen, setUsageOpen] = useState(false); // Usage/quota overlay
  const [editFile, setEditFile] = useState(null); // { path, cwd } when editing a file in main area
  const [authed, setAuthed] = useState(null); // null=checking, false=show login, true=app
  const [toast, setToast] = useState(""); // transient server error banner
  const [nav, setNav] = useState(null); // mobile drawer: null | "sidebar" | "files"
  const messagesEndRef = useRef(null);
  const messagesRef = useRef(null); // the .messages scroll container
  // When older messages are prepended (via "Load older"), the auto-scroll
  // effect must NOT yank the viewport to the bottom. `suppressAutoScrollRef`
  // flags that commit; `prependRestoreRef` records the pre-prepend scroll
  // height so the restore effect can hold the user's position by the delta.
  const suppressAutoScrollRef = useRef(false);
  const prependRestoreRef = useRef(null); // { prev: scrollHeight, sessionId }
  // Forces ONE scroll-to-bottom on the next commit regardless of where the
  // viewport currently sits. Set when the user's intent is unambiguously "show
  // me the end": opening/switching a chat, loading its history, sending a
  // message. Streaming tokens don't set it — those only follow if the user is
  // already at the bottom (see the auto-scroll effect).
  const pinBottomRef = useRef(true);
  const toastTimer = useRef(null);
  // Transcriptions of images that were sent to a text-only model, keyed by
  // session id and then by the user message's uid, so each note renders under
  // the exact message it belongs to. The transcription step is lossy, so what
  // the model actually received has to stay inspectable.
  const [visionNotes, setVisionNotes] = useState({}); // {sessionId: {uid: {model, text, truncated}}}
  const [describeModel, setDescribeModel] = useState(""); // vision model used to transcribe images

  function flashToast(msg) {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
  }

  // Clear any pending toast timer on unmount so it can't fire setState after.
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Probe auth state once on mount. 401 -> show login; cookie is HttpOnly so
  // the browser handles it transparently on subsequent requests.
  useEffect(() => {
    let alive = true;
    fetch("/api/me")
      .then((r) => r.json())
      .then((j) => alive && setAuthed(!!j.ok))
      .catch(() => alive && setAuthed(false));
    return () => {
      alive = false;
    };
  }, []);

  async function logout() {
    // Best-effort: clear the cookie server-side, but flip to the login screen
    // either way. A hung/failed logout no longer leaves the UI stuck.
    try {
      await fetch("/api/logout", { method: "POST" });
    } catch {
      /* network error — still drop the local authed state */
    } finally {
      setAuthed(false);
    }
  }

  // Load the selectable model list once authenticated. The backend sources it
  // live from Ollama's /api/tags (falling back to the configured list), so the
  // dropdown reflects what's actually installed. Any model seen on a session
  // is also added so resumed sessions stay selectable. The same response
  // carries which models accept images (detected from the gateway) and which
  // model the server transcribes images with — both authoritative, so they
  // override the `hello` frame's configured fallback.
  function refreshModels(initial = false) {
    fetch("/api/models")
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.models) && j.models.length ? j.models : [j.default || "glm-5.2:cloud"];
        setDefaultModel(j.default || list[0]);
        if (Array.isArray(j.visionModels)) setVisionModels(j.visionModels);
        if (j.capabilities && typeof j.capabilities === "object") setModelCaps(j.capabilities);
        if (j.describeModel) setDescribeModel(j.describeModel);
        setModelOptions((opts) => {
          const merged = [...list];
          // Preserve the active model and the chosen "next chat" model if Ollama's
          // current list omits them, so a focus-refresh never drops your selection.
          for (const o of opts) if (!merged.includes(o) && (o === model || o === selectedModel)) merged.push(o);
          return merged;
        });
        // Only the first load seeds the "next new chat" default; later refreshes
        // keep whatever the user picked.
        if (initial) setSelectedModel(j.default || list[0]);
      })
      .catch(() => {});
  }

  useEffect(() => {
    if (authed !== true) return;
    refreshModels(true);
  }, [authed]);

  function ensureModelOption(m) {
    if (!m) return;
    setModelOptions((opts) => (opts.includes(m) ? opts : [...opts, m]));
  }

  // onEvent is a plain function (not useCallback) so it closes over the current
  // render's state — refreshModels/model/selectedModel are always fresh. useSocket
  // reads it via an internal ref, so a new identity each render is safe and cheap.
  function onEvent(evt) {
    switch (evt.type) {
      case "hello":
        setWorkspaceRoot(evt.config?.workspaceRoot || "");
        setStatus("ready");
        setConfirmMode(!!evt.config?.confirmTools);
        // Configured fallback only — /api/models carries the detected list and
        // wins if it has already landed (see refreshModels).
        setVisionModels((prev) =>
          prev.length || !Array.isArray(evt.config?.visionModels) ? prev : evt.config.visionModels,
        );
        refreshWorkspaces(evt.config?.workspaceRoot || "");
        sendRef.current?.({ type: "list" });
        break;
      case "sessions":
        // The server's `list()` is authoritative for busy/ended — it reads
        // `!!this.ended` live, so after a subscribe reactivates a stopped
        // session the next broadcast carries `ended:false` and the sidebar
        // must reflect that. An earlier version forced `ended:true` to
        // "preserve" the flag across broadcasts, but that made the · ended
        // label stick forever after reactivation (the user clicked a dead
        // session, the server restarted claude, yet the sidebar still said
        // ended) — so trust the server here. Merge keeps any frontend-only
        // fields if we add them later; server fields (incl. ended) win.
        setSessions((cur) => {
          const byId = new Map(cur.map((s) => [s.id, s]));
          return (evt.items || []).map((s) => {
            const ex = byId.get(s.id);
            return ex ? { ...ex, ...s } : s;
          });
        });
        // The server's list() carries each session's persisted metrics, so a
        // page reload / reconnect repopulates the metrics bar for sessions the
        // user isn't actively watching (whose result events this client never
        // saw). Don't clobber a fresher value we just applied from a live
        // result event — only set when the server actually has metrics.
        setMetricsBy((p) => {
          let next = p;
          for (const s of evt.items || []) {
            if (!s.metrics) continue;
            next = { ...next, [s.id]: s.metrics };
          }
          return next;
        });
        // The session list is the server's authoritative busy/ended state
        // (broadcast on every status change). Sync the composer's busy map from
        // it so the active chat's Stop button reliably reverts to Send when a
        // turn ends — including the Stop path, where the process is killed and
        // no `result` event fires, only this broadcast (plus the exit event).
        setBusyBy((p) => {
          let next = p;
          for (const s of evt.items || []) {
            const b = !!s.busy;
            if ((next[s.id] ?? false) !== b) next = { ...next, [s.id]: b };
          }
          return next;
        });
        // Union any per-session models into the dropdown so resumed sessions
        // whose model isn't in AVAILABLE_MODELS stay selectable.
        setModelOptions((opts) => {
          const seen = new Set(opts);
          const add = (evt.items || [])
            .map((s) => s.model)
            .filter(Boolean)
            .filter((m) => !seen.has(m));
          return add.length ? [...opts, ...add] : opts;
        });
        break;
      case "session":
        setActiveId(evt.sessionId);
        setCwdBy((p) => ({ ...p, [evt.sessionId]: evt.cwd }));
        // `start` replies omit busy (a fresh session isn't busy), so default to
        // false; `subscribe` replies carry busy so switching back to a session
        // that kept running in the background reflects its true working state.
        setBusyBy((p) => ({ ...p, [evt.sessionId]: evt.busy !== undefined ? !!evt.busy : false }));
        if (evt.confirm !== undefined) setConfirmMode(!!evt.confirm);
        if (evt.model) {
          ensureModelOption(evt.model);
          setModel(evt.model);
        }
        if (!evt.resumed) setMsgs((p) => ({ ...p, [evt.sessionId]: p[evt.sessionId] || [] }));
        break;
      case "history":
        // Prior transcript for a resumed session (loaded from disk by the
        // backend, since --resume doesn't replay it in stream-json mode). Only
        // the recent tail is shipped (paginated); older pages load via
        // `historyMore` when the user clicks "Load older". `oldestIndex`/`hasMore`
        // are the pagination cursor for that. See normalizeHistMsg for the
        // image-ref / blocks normalization shared with `historyMore`.
        setMsgs((p) => ({ ...p, [evt.sessionId]: (evt.messages || []).map(normalizeHistMsg) }));
        setHistoryMetaBy((p) => ({
          ...p,
          [evt.sessionId]: {
            oldestIndex: evt.oldestIndex ?? 0,
            hasMore: !!evt.hasMore,
            loading: false,
          },
        }));
        // A fresh history load should pin to the bottom; clear any stale
        // suppress flag from a prior "Load older" in another session.
        suppressAutoScrollRef.current = false;
        pinBottomRef.current = true;
        break;
      case "historyMore": {
        // An older page of the transcript (preceded by the "Load older"
        // button). Prepend to the session's messages and advance the cursor.
        // The scroll-restore refs were set by loadMore() before the request,
        // so the restore effect holds the user's viewport position.
        const older = (evt.messages || []).map(normalizeHistMsg);
        setMsgs((p) => ({
          ...p,
          [evt.sessionId]: [...older, ...(p[evt.sessionId] || [])],
        }));
        setHistoryMetaBy((p) => ({
          ...p,
          [evt.sessionId]: {
            oldestIndex: evt.oldestIndex ?? 0,
            hasMore: !!evt.hasMore,
            loading: false,
          },
        }));
        break;
      }
      case "rename": {
        // Claude reported a different session id than the one we started it
        // with (the gateway may ignore --session-id). Move all per-session
        // state over so the streamed answer renders under the active session.
        const { oldId, sessionId } = evt;
        setActiveId((cur) => (cur === oldId ? sessionId : cur));
        setMsgs((p) => {
          if (!p[oldId]) return p;
          const { [oldId]: m, ...rest } = p;
          return { ...rest, [sessionId]: m };
        });
        setBusyBy((p) => {
          if (p[oldId] === undefined) return p;
          const { [oldId]: b, ...rest } = p;
          return { ...rest, [sessionId]: b };
        });
        setCwdBy((p) => {
          if (p[oldId] === undefined) return p;
          const { [oldId]: c, ...rest } = p;
          return { ...rest, [sessionId]: c };
        });
        break;
      }
      case "claude":
        handleClaude(evt.sessionId, evt.data);
        break;
      case "exit":
        // The claude subprocess ended (crash, gateway error, or Stop). Mark
        // the session ended and tell the user; otherwise the next send hits a
        // dead process and silently fails with "send failed".
        setBusyBy((p) => ({ ...p, [evt.sessionId]: false }));
        // Any in-flight permission/AskUserQuestion prompts are now unanswerable
        // (the process is gone), so drop them so the cards don't linger.
        setPromptsBy((p) => (p[evt.sessionId] ? { ...p, [evt.sessionId]: [] } : p));
        setSessions((cur) => cur.map((s) => (s.id === evt.sessionId ? { ...s, ended: true } : s)));
        if (evt.sessionId === activeIdRef.current)
          flashToast(`session ended${evt.code != null ? ` (exit ${evt.code})` : ""} — click it again to resume`);
        break;
      case "vision-transcribing":
        // The server is transcribing the attached images with a vision model
        // because the active model can't take them. It's a multi-second round
        // trip, so say so rather than leaving the composer looking stuck.
        flashToast(`Transcribing the image with ${evt.model}…`);
        break;
      case "vision-transcribed":
        // Record it against the user message that carried the images (uid), so
        // the transcript can show what the model actually received.
        setVisionNotes((p) => ({
          ...p,
          [evt.sessionId]: {
            ...(p[evt.sessionId] || {}),
            [evt.uid || "?"]: { model: evt.model, text: evt.text, truncated: !!evt.truncated },
          },
        }));
        break;
      case "vision-unsupported":
        // The gateway rejected an image block for a model we believed could
        // take one. The bubble above already shows the raw 400; this adds the
        // actionable half.
        flashToast(
          `${evt.model} does not accept image input. Switch to ${describeModel || visionModels[0] || "a vision model"}, or describe it in text.`,
        );
        break;
      case "payload-too-large":
        // The gateway can't even READ the request body any more (16MB limit):
        // the session's accumulated images/context are too large to ever be
        // re-sent, so every message fails with "failed to read request body".
        // The bubble above already shows the raw 400; this adds the way out.
        flashToast(
          "This session's accumulated images/content exceed the gateway's 16MB request limit — retrying will not help. Start a new session; the old one (images included) stays readable.",
        );
        break;
      case "payload-near-limit":
        // Proactive version: the session's transcript has crossed the budget
        // but requests still fit — for now. Warn while there's still time to
        // start a fresh session on the user's own terms.
        flashToast(
          "This session has passed 12MB and is approaching the gateway's 16MB request limit. Start a new session soon (the old one stays readable) before every message starts failing.",
        );
        break;
      case "error":
        console.error("server error", evt.message);
        flashToast(evt.message || "server error");
        break;
      default:
        break;
    }
  }

  const { send, ready } = useSocket(onEvent, authed === true);
  const sendRef = useRef(send);
  const activeIdRef = useRef(activeId);
  useEffect(() => {
    sendRef.current = send;
  }, [send]);
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);
  // Reflect WS connection state in the topbar. Without this a dropped socket
  // mid-session kept showing "connected" (status only ever flipped on `hello`).
  useEffect(() => {
    if (authed !== true) return;
    setStatus(ready ? "ready" : "reconnecting");
  }, [ready, authed]);

  // Close any open mobile drawer on Escape.
  useEffect(() => {
    if (!nav) return;
    function onKey(e) {
      if (e.key === "Escape") setNav(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);

  function refreshWorkspaces(root) {
    fetch("/api/workspaces")
      .then((r) => r.json())
      .then((j) => {
        const rootPath = root || j.root;
        const list = [{ name: "workspace (root)", path: rootPath }];
        for (const d of j.dirs || []) list.push({ name: d, path: `${rootPath}/${d}` });
        setWorkspaces(list);
        setSelectedCwd((cur) => cur || rootPath);
      })
      .catch(() => {});
  }

  function handleClaude(sessionId, data) {
    if (!data) return;
    if (data.type === "system" && data.subtype === "init") {
      if (data.model) {
        ensureModelOption(data.model);
        setModel(data.model);
      }
      return;
    }
    if (data.type === "stream_event") return handleStreamEvent(sessionId, data);
    if (data.type === "assistant") return handleAssistant(sessionId, data);
    if (data.type === "user") return handleUserToolResult(sessionId, data);
    if (data.type === "control_request") return handleControlRequest(sessionId, data);
    if (data.type === "control_cancel_request") return handleControlCancel(sessionId, data);
    if (data.type === "result") return handleResult(sessionId, data);
  }

  // Claude is asking for a decision (a tool permission prompt or an
  // AskUserQuestion). These arrive as top-level control_request stream events,
  // NOT inside an assistant message's blocks, so we render them as standalone
  // cards at the bottom of the message list. The session is "busy" waiting on
  // the answer (no `result` has fired), so the composer shows Stop meanwhile.
  function handleControlRequest(sessionId, data) {
    if (!data.request_id) return;
    const entry = { requestId: data.request_id, request: data.request || {} };
    setBusyBy((p) => ({ ...p, [sessionId]: true }));
    setPromptsBy((prev) => {
      const arr = prev[sessionId] ? [...prev[sessionId]] : [];
      // De-dup by request_id (a replayed/re-sent prompt must not stack cards).
      if (arr.some((x) => x.requestId === entry.requestId)) return prev;
      arr.push(entry);
      return { ...prev, [sessionId]: arr };
    });
  }

  // Claude cancelled its own pending prompt (e.g. the turn was aborted). Drop
  // the matching card so the user isn't shown a prompt that no longer exists.
  function handleControlCancel(sessionId, data) {
    const rid = data.request_id;
    if (!rid) return;
    setPromptsBy((prev) => {
      const arr = prev[sessionId];
      if (!arr || !arr.some((x) => x.requestId === rid)) return prev;
      return { ...prev, [sessionId]: arr.filter((x) => x.requestId !== rid) };
    });
  }

  // Update the last assistant message's blocks for a session (immutably).
  function updateLastAssistant(prev, sessionId, fn) {
    const arr = prev[sessionId] ? [...prev[sessionId]] : [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].role === "assistant") {
        arr[i] = { ...arr[i], blocks: fn(arr[i].blocks) };
        break;
      }
    }
    return { ...prev, [sessionId]: arr };
  }

  // Live token streaming from raw Anthropic SSE events. The final `assistant`
  // event afterwards delivers the fully-assembled message (same id) and
  // replaces these blocks, so we only need text/thinking deltas for liveness;
  // tool_use input is filled in by that final snapshot.
  function handleStreamEvent(sessionId, data) {
    const ev = data.event;
    if (!ev) return;
    if (ev.type === "message_start") {
      const id = ev.message?.id;
      if (!id) return;
      setBusyBy((p) => ({ ...p, [sessionId]: true }));
      setMsgs((prev) => {
        const arr = prev[sessionId] ? [...prev[sessionId]] : [];
        if (!arr.some((m) => m.role === "assistant" && m.id === id)) {
          arr.push({ role: "assistant", id, blocks: [], streaming: true });
        }
        return { ...prev, [sessionId]: arr };
      });
      return;
    }
    if (ev.type === "content_block_start") {
      const cb = ev.content_block || {};
      setMsgs((prev) =>
        updateLastAssistant(prev, sessionId, (blocks) => {
          const nb = [...blocks];
          while (nb.length <= ev.index) nb.push({ type: "text", text: "" });
          if (cb.type === "text") nb[ev.index] = { type: "text", text: cb.text || "" };
          else if (cb.type === "tool_use")
            nb[ev.index] = { type: "tool_use", id: cb.id, name: cb.name, input: {}, pending: true };
          else if (cb.type === "thinking")
            nb[ev.index] = { type: "thinking", thinking: cb.thinking || "" };
          else nb[ev.index] = { type: "other", raw: cb };
          return nb;
        }),
      );
      return;
    }
    if (ev.type === "content_block_delta") {
      const delta = ev.delta || {};
      setMsgs((prev) =>
        updateLastAssistant(prev, sessionId, (blocks) => {
          if (!blocks[ev.index]) return blocks;
          const nb = [...blocks];
          const b = { ...nb[ev.index] };
          if (delta.type === "text_delta") b.text = (b.text || "") + (delta.text || "");
          else if (delta.type === "thinking_delta")
            b.thinking = (b.thinking || "") + (delta.thinking || "");
          nb[ev.index] = b;
          return nb;
        }),
      );
    }
  }

  function handleAssistant(sessionId, data) {
    const msg = data.message || {};
    const blocks = (msg.content || []).map((c) => {
      if (c.type === "text") return { type: "text", text: c.text || "" };
      if (c.type === "tool_use")
        return { type: "tool_use", id: c.id, name: c.name, input: c.input, pending: true };
      if (c.type === "thinking") return { type: "thinking", thinking: c.thinking || "" };
      return { type: "other", raw: c };
    });
    setBusyBy((p) => ({ ...p, [sessionId]: true }));
    setMsgs((prev) => {
      const arr = prev[sessionId] ? [...prev[sessionId]] : [];
      let found = -1;
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].role === "assistant" && arr[i].id === msg.id) {
          found = i;
          break;
        }
      }
      if (found >= 0) {
        const existing = arr[found];
        const merged = blocks.map((b) => {
          if (b.type === "tool_use") {
            const ex = existing.blocks.find(
              (x) => x.type === "tool_use" && x.id === b.id && x.result !== undefined,
            );
            if (ex) return { ...b, result: ex.result, isError: ex.isError, pending: false };
          }
          // Some gateways stream the thinking block as an early same-id partial
          // (assistant event #0 = [thinking]) and then send the final snapshot
          // with the thinking block REDACTED or emptied (#1 = [text]). When the
          // final snapshot carries a thinking block with no text, fall back to
          // the streamed thinking so the chain isn't blanked on finalize.
          if (b.type === "thinking" && !b.thinking) {
            const ex = existing.blocks.find((x) => x.type === "thinking" && x.thinking);
            if (ex) return { ...b, thinking: ex.thinking };
          }
          return b;
        });
        // The final snapshot from this gateway carries only text/tool_use and
        // DROPS the thinking block that streamed as an earlier same-id partial,
        // so a naive replace wipes the chain the moment thinking ends. Re-attach
        // the streamed thinking (it precedes the text chronologically). If the
        // snapshot already includes its own thinking, prefer that — it's the
        // authoritative full version.
        if (!merged.some((b) => b.type === "thinking")) {
          const streamed = existing.blocks.filter((b) => b.type === "thinking" && b.thinking);
          if (streamed.length) merged.unshift(...streamed);
        }
        arr[found] = { ...existing, blocks: merged, streaming: true };
      } else {
        arr.push({ role: "assistant", id: msg.id, blocks, streaming: true });
      }
      return { ...prev, [sessionId]: arr };
    });
  }

  function handleUserToolResult(sessionId, data) {
    const content = data.message?.content || [];
    setMsgs((prev) => {
      const arr = prev[sessionId] ? [...prev[sessionId]] : [];
      for (const tr of content) {
        if (tr.type !== "tool_result") continue;
        for (let i = arr.length - 1; i >= 0; i--) {
          const m = arr[i];
          if (m.role !== "assistant") continue;
          const bi = m.blocks.findIndex((b) => b.type === "tool_use" && b.id === tr.tool_use_id);
          if (bi >= 0) {
            const blocks = [...m.blocks];
            blocks[bi] = { ...blocks[bi], result: tr.content, isError: !!tr.is_error, pending: false };
            arr[i] = { ...m, blocks };
            break;
          }
        }
      }
      return { ...prev, [sessionId]: arr };
    });
  }

  function handleResult(sessionId, data) {
    setBusyBy((p) => ({ ...p, [sessionId]: false }));
    // The result event carries the turn's metrics (tokens for this turn,
    // cumulative cost/duration/turns for the session). Capture them so the
    // metrics bar updates the moment a turn finishes — the server also
    // persists + broadcasts them, but applying here avoids waiting for the
    // next `sessions` broadcast to see the fresh numbers.
    if (data && typeof data === "object") {
      const u = data.usage || {};
      setMetricsBy((p) => ({
        ...p,
        [sessionId]: {
          inputTokens: u.input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          cacheReadTokens: u.cache_read_input_tokens || 0,
          cacheCreationTokens: u.cache_creation_input_tokens || 0,
          totalCostUsd: typeof data.total_cost_usd === "number" ? data.total_cost_usd : null,
          totalDurationMs: typeof data.duration_ms === "number" ? data.duration_ms : null,
          totalTurns: typeof data.num_turns === "number" ? data.num_turns : null,
        },
      }));
    }
    setMsgs((prev) => {
      const arr = prev[sessionId] ? [...prev[sessionId]] : [];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].role === "assistant") {
          arr[i] = { ...arr[i], streaming: false };
          break;
        }
      }
      return { ...prev, [sessionId]: arr };
    });
    // No `list` request here: the server's statusBus already broadcasts a fresh
    // session list to every client on the same `result` event (sessions.js
    // emitStatus), so asking for one made every turn serialize + ship the whole
    // list twice.
  }

  function newChat() {
    const cwd = selectedCwd || workspaceRoot;
    suppressAutoScrollRef.current = false; // fresh chat lands at the bottom
    pinBottomRef.current = true;
    send({ type: "start", cwd, model: selectedModel, confirm: confirmMode });
  }

  // Apply a model choice. With a chat open, this restarts the active session
  // under the new model (--resume keeps the transcript); without one it just
  // sets the model for the next + New chat.
  function applyModel(m) {
    if (activeId) {
      if (busy && !window.confirm("Switching models restarts this session and stops any running turn. Continue?"))
        return;
      send({ type: "start", sessionId: activeId, model: m, confirm: confirmMode });
    } else {
      setSelectedModel(m);
    }
  }

  // Toggle interactive confirmation mode. With a chat open, this restarts the
  // active session under the new mode (like applyModel); without one it just
  // sets the mode for the next + New chat. In confirm mode, dangerous tool
  // calls and AskUserQuestion surface as inline prompts the user answers.
  function applyConfirm(next) {
    if (activeId) {
      if (busy && !window.confirm("Toggling confirmation mode restarts this session and stops any running turn. Continue?"))
        return;
      send({ type: "start", sessionId: activeId, confirm: next, model });
    } else {
      setConfirmMode(next);
    }
  }

  // Answer an in-flight control_request (permission / AskUserQuestion prompt):
  // send the PermissionResult (or dialog result) to the server, which writes a
  // control_response to claude's stdin, then drop the card optimistically.
  function sendAnswer(requestId, response) {
    if (!activeId) return;
    send({ type: "answer", sessionId: activeId, requestId, response });
    setPromptsBy((prev) => {
      const arr = prev[activeId];
      if (!arr) return prev;
      return { ...prev, [activeId]: arr.filter((x) => x.requestId !== requestId) };
    });
  }

  function onModelChange(e) {
    applyModel(e.target.value);
  }

  function pickSession(id) {
    const s = sessions.find((x) => x.id === id);
    // Selecting a session also switches to its workspace so the file tree and
    // session list stay scoped to the workspace that owns the conversation.
    if (s?.cwd) pickWorkspace(s.cwd);
    // Re-attach to the session WITHOUT respawning: `start` would stop()+restart
    // its claude and kill any in-flight turn. `subscribe` only re-attaches the
    // listener (and auto-restarts the process if it isn't running), so a chat
    // you switched away from keeps running in the background. The server replies
    // with the session's current `busy` so the composer reflects its state.
    send({ type: "subscribe", sessionId: id });
    suppressAutoScrollRef.current = false; // switching into a session pins to bottom
    pinBottomRef.current = true;
    setNav(null);
  }

  // Fetch the next older page of the active session's transcript and prepend
  // it. Guards on hasMore/loading; sets the scroll-restore refs first so the
  // restore effect holds the user's viewport position (the auto-scroll effect
  // is suppressed for that commit).
  function loadMore() {
    if (!activeId) return;
    const meta = historyMetaBy[activeId];
    if (!meta || !meta.hasMore || meta.loading) return;
    const el = messagesRef.current;
    suppressAutoScrollRef.current = true;
    prependRestoreRef.current = { prev: el ? el.scrollHeight : 0, sessionId: activeId };
    setHistoryMetaBy((p) => ({ ...p, [activeId]: { ...meta, loading: true } }));
    send({ type: "historyMore", sessionId: activeId, beforeIndex: meta.oldestIndex });
  }

  // Optimistic local render keeps a dataUrl (for thumbnails) rather than the
  // raw base64, so message state stays small. The WS payload sends raw base64.
  // A stable uid keys the user message so React doesn't reuse the wrong
  // instance across rename/reorder (index keys did).
  function deliverSend(text, attachments = []) {
    const images = attachments
      .filter((a) => a.kind === "image")
      .map((a) => ({ mediaType: a.mediaType, dataUrl: a.dataUrl }));
    const files = attachments
      .filter((a) => a.kind !== "image")
      .map((a) => ({ name: a.name, mediaType: a.mediaType, size: a.size }));
    const uid = `u${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    pinBottomRef.current = true; // sending always jumps to the end
    setMsgs((prev) => ({
      ...prev,
      [activeId]: [
        ...(prev[activeId] || []),
        {
          role: "user",
          uid,
          text,
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
        },
      ],
    }));
    send({
      type: "send",
      sessionId: activeId,
      text,
      // Echoed back on the vision-transcribing/vision-transcribed events so the
      // transcription can be attached to this exact bubble.
      uid,
      ...(attachments.length
        ? { attachments: attachments.map((a) => ({ mediaType: a.mediaType, data: a.data, name: a.name })) }
        : {}),
    });
  }

  // A model is vision-capable if it matches a configured visionModels entry
  // (exact, or matches up to a `:` tag boundary so variant tags count too).
  function isVisionModel(m) {
    return visionModels.some((v) => m === v || m.startsWith(v + ":") || v.startsWith(m + ":"));
  }

  function sendMessage(text, attachments = []) {
    if (!activeId) return;
    // Image input to a text-only model 400s at the gateway, so the SERVER
    // transcribes the images with a vision model and forwards the text (see
    // server/vision.js). The session keeps the model the user picked rather
    // than being restarted onto a vision model. This is purely informational —
    // say it's about to happen, then send normally. Non-image attachments are
    // inlined as text by the backend and need no notice.
    const hasImage = attachments.some((a) => a.kind === "image");
    if (hasImage && !isVisionModel(model)) {
      flashToast(`The image will be transcribed to text by ${describeModel || "the vision model"} first, then handed to ${model}.`);
    }
    deliverSend(text, attachments);
  }

  // Stop any session (active or background). The composer's Stop button stops
  // the active chat; the sidebar's per-row ⏹ stops a background one. One path so
  // both behave identically (SIGTERM the claude process, flip to ended).
  function stopSession(id) {
    if (id) send({ type: "stop", sessionId: id });
  }
  const stop = () => stopSession(activeId);

  // Permanently remove a session from the sidebar: stop its process, delete the
  // persisted entry + transcript on the server, and drop this client's cached
  // messages/cwd for it. If it was the active chat, clear the active id so the
  // composer disables rather than sending into a dead session.
  function removeSession(id) {
    const s = sessions.find((x) => x.id === id);
    const label = s?.title || s?.id?.slice(0, 8) || id.slice(0, 8);
    if (!window.confirm(`Delete chat "${label}"?\nThis stops the session and permanently removes its transcript.`))
      return;
    send({ type: "remove", sessionId: id });
    setMsgs((p) => {
      if (!p[id]) return p;
      const { [id]: _m, ...rest } = p;
      return rest;
    });
    setBusyBy((p) => {
      if (p[id] === undefined) return p;
      const { [id]: _b, ...rest } = p;
      return rest;
    });
    setCwdBy((p) => {
      if (p[id] === undefined) return p;
      const { [id]: _c, ...rest } = p;
      return rest;
    });
    setMetricsBy((p) => {
      if (p[id] === undefined) return p;
      const { [id]: _m, ...rest } = p;
      return rest;
    });
    setActiveId((cur) => (cur === id ? null : cur));
  }

  // Switch the active workspace. Per the "separated workspaces" model this also
  // closes the currently open chat (it keeps running; re-pick it from its own
  // workspace) so files + conversations are cleanly scoped to one workspace.
  function pickWorkspace(path) {
    setSelectedCwd(path);
    setActiveId(null);
    setEditFile(null);
    setNav(null);
  }

  async function createWorkspace() {
    const name = window.prompt("New workspace folder name:");
    if (!name) return;
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    let j;
    try {
      j = await res.json();
    } catch {
      j = { error: `HTTP ${res.status}` };
    }
    if (j.path) {
      refreshWorkspaces(workspaceRoot);
      pickWorkspace(j.path); // switch to the freshly created workspace
    } else {
      window.alert(j.error || "failed");
    }
  }

  async function deleteWorkspace() {
    const name = workspaceName(selectedCwd, workspaceRoot);
    if (!name) return; // root or nothing selected — never deletable
    if (!window.confirm(`Delete workspace "${name}"?\nThe folder must be empty.`)) return;
    const res = await fetch(`/api/workspaces?name=${encodeURIComponent(name)}`, { method: "DELETE" });
    const j = await res.json().catch(() => ({}));
    if (j.ok) {
      refreshWorkspaces(workspaceRoot);
      pickWorkspace(workspaceRoot || "");
    } else {
      window.alert(j.error || "delete failed");
    }
  }

  // Open a file from the right-hand tree into the main editing area. The file
  // belongs to the active workspace, so save back into that workspace.
  function openFile(path) {
    const cwd = selectedCwd || workspaceRoot;
    setEditFile({ path, cwd });
    setNav(null);
  }

  function closeEditor() {
    setEditFile(null);
  }

  // A file/folder was deleted from the tree. If the open editor was showing
  // it (or something inside a deleted folder), close the editor so we never
  // try to save back into a path that no longer exists.
  function handleFileDeleted(path) {
    setEditFile((cur) => {
      if (!cur) return cur;
      if (cur.path === path || cur.path.startsWith(path + "/")) return null;
      return cur;
    });
  }

  // A file/folder was moved in the tree. If the open editor was showing it (or
  // a file inside a moved folder), follow it to the new path so a subsequent
  // save writes to the right place instead of the stale location.
  function handleFileMoved(from, to) {
    setEditFile((cur) => {
      if (!cur) return cur;
      if (cur.path === from) return { ...cur, path: to };
      if (cur.path.startsWith(from + "/")) return { ...cur, path: to + cur.path.slice(from.length) };
      return cur;
    });
  }

  const activeMsgs = activeId ? msgs[activeId] || empty : empty;
  const activePrompts = activeId ? promptsBy[activeId] || empty : empty;
  const activeMeta = activeId ? historyMetaBy[activeId] || null : null;
  const busy = activeId ? !!busyBy[activeId] : false;
  const activeCwd = activeId ? cwdBy[activeId] : selectedCwd;
  const activeMetrics = activeId ? metricsBy[activeId] || null : null;
  // Sessions are scoped to the selected workspace (each session's cwd IS its
  // workspace). The full list is still held in `sessions` so switching back is
  // instant; we just filter what the sidebar shows. Mirror the live busyBy
  // flag into each row so "· working" actually appears mid-turn (the server's
  // `sessions` event only carries busy as of the last `list`, which is stale
  // while a turn is streaming).
  const wsSessions = (selectedCwd ? sessions.filter((s) => s.cwd === selectedCwd) : sessions).map(
    (s) => (busyBy[s.id] ? { ...s, busy: true } : s),
  );
  const isRootWs = !selectedCwd || selectedCwd === workspaceRoot;

  // After older messages are prepended (via "Load older"), restore the user's
  // scroll position by the height delta so the viewport stays put. Declared
  // BEFORE the auto-scroll effect so it runs first on the same commit; the
  // suppress flag (set by loadMore) then keeps auto-scroll from yanking to
  // the bottom. No-op on normal streaming (prependRestoreRef is null).
  useEffect(() => {
    const r = prependRestoreRef.current;
    const el = messagesRef.current;
    if (r && el && r.sessionId === activeId) {
      el.scrollTop += el.scrollHeight - r.prev;
    }
    prependRestoreRef.current = null;
  }, [activeMsgs]);

  // Auto-scroll. Depending on only [length, busy] missed streaming: the
  // assistant message is appended once on message_start (length +1) but its
  // block text mutates on every token without changing length. `activeMsgs`
  // gets a new identity on every setMsgs, so depending on it follows tokens.
  // Suppressed on the commit that follows a "Load older" prepend (the restore
  // effect above holds the position instead).
  //
  // Only follow the output when the user is already parked at the bottom.
  // Unconditional scrolling meant that scrolling up to re-read something
  // mid-turn yanked the viewport back down on the very next token — the
  // transcript was unreadable until the turn finished. `behavior:"auto"` too:
  // a smooth scroll animation restarted per token and never kept up anyway.
  useEffect(() => {
    if (suppressAutoScrollRef.current) {
      suppressAutoScrollRef.current = false;
      return;
    }
    const el = messagesRef.current;
    const forced = pinBottomRef.current;
    if (forced) pinBottomRef.current = false;
    // NEAR_BOTTOM_PX of slack so "basically at the bottom" still counts (a
    // half-rendered code block or an image loading can shift things by a few px).
    const NEAR_BOTTOM_PX = 120;
    if (!forced && el && el.scrollHeight - el.scrollTop - el.clientHeight > NEAR_BOTTOM_PX) return;
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [activeMsgs, busy]);

  if (authed === null) {
    return <div className="boot">Connecting…</div>;
  }
  if (!authed) {
    return <Login onSuccess={() => setAuthed(true)} />;
  }

  return (
    <div className={"app" + (nav === "sidebar" ? " show-sidebar" : "") + (nav === "files" ? " show-files" : "")}>
      <Sidebar
        sessions={wsSessions}
        activeId={activeId}
        metricsBy={metricsBy}
        onPick={pickSession}
        onNew={newChat}
        onRemove={removeSession}
        onStop={stopSession}
        workspaces={workspaces}
        cwd={selectedCwd}
        onPickWorkspace={pickWorkspace}
        onCreateWorkspace={createWorkspace}
        onDeleteWorkspace={deleteWorkspace}
        canDeleteWorkspace={!isRootWs}
      />
      <div className="chat">
        <div className="topbar">
          <button
            className="nav-btn nav-sidebar"
            onClick={() => setNav((n) => (n === "sidebar" ? null : "sidebar"))}
            title="Sessions & workspaces"
          >
            ☰
          </button>
          <span className={`dot ${busy ? "busy" : activeId ? "idle" : "dead"}`} />
          <span className="title">
            {activeCwd
              ? workspaceRoot && activeCwd.startsWith(workspaceRoot)
                ? activeCwd.replace(workspaceRoot, "…")
                : activeCwd
              : "no session"}
          </span>
          <span className="spacer" />
          <ModelPicker
            value={activeId ? model : selectedModel}
            options={modelOptions}
            caps={modelCaps}
            onChange={onModelChange}
            onOpen={() => refreshModels(false)}
          />
          <button onClick={() => setTermMode("tui")}>TUI</button>
          <button onClick={() => setTermMode("shell")}>Shell</button>
          <button
            className={"confirm-toggle" + (confirmMode ? " on" : "")}
            onClick={() => applyConfirm(!confirmMode)}
            title="Confirm mode: ask before running write/exec tools and AskUserQuestion (restarts the active chat)"
          >
            {confirmMode ? "Confirm ✓" : "Confirm"}
          </button>
          <button onClick={() => setSkillsOpen(true)} title="Manage Claude Code skills">Skills</button>
          <button onClick={() => setUsageOpen(true)} title="Usage & quota across every model subscription">Usage</button>
          <button
            className="nav-btn nav-files"
            onClick={() => setNav((n) => (n === "files" ? null : "files"))}
            title="Files"
          >
            📁
          </button>
          <span className="model">{status === "ready" ? "connected" : status}</span>
          <button onClick={logout} title="Sign out">Logout</button>
        </div>

        {toast && <div className="toast" onClick={() => setToast("")}>{toast}</div>}

        {editFile ? (
          <Editor key={editFile.path} file={editFile} onClose={closeEditor} />
        ) : (
          <>
        <div className="messages" ref={messagesRef}>
          {activeMeta?.hasMore && (
            <button className="load-more" disabled={activeMeta.loading} onClick={loadMore}>
              {activeMeta.loading ? "Loading…" : "Load older messages"}
            </button>
          )}
          {activeMsgs.length === 0 && (
            <div className="empty">
              <h1>Coding UI</h1>
              <p>
                Pick a working dir, click <b>+ New chat</b>, then ask Claude Code to read, edit, or run
                things in that directory.
              </p>
              <p style={{ fontSize: 12 }}>Model: {model} · Backend: Claude Code CLI (stream-json)</p>
            </div>
          )}
          {activeMsgs.map((m, i) => (
            <Fragment key={m.id || m.uid || `u${i}`}>
              <Message msg={m} />
              {m.uid && visionNotes[activeId]?.[m.uid] && (
                <VisionNote note={visionNotes[activeId][m.uid]} />
              )}
            </Fragment>
          ))}
          <div ref={messagesEndRef} />
        </div>

        {activePrompts.length > 0 && (
          <div className="prompts">
            {activePrompts.map((p) => (
              <PromptCard key={p.requestId} prompt={p} onAnswer={sendAnswer} />
            ))}
          </div>
        )}

        {activeMetrics && <MetricsBar metrics={activeMetrics} />}

        <Composer onSend={sendMessage} onStop={stop} busy={busy} disabled={!activeId} />
          </>
        )}
      </div>

      <FileTree
        cwd={selectedCwd || workspaceRoot}
        key={selectedCwd || "none"}
        onOpenFile={openFile}
        onDeleteFile={handleFileDeleted}
        onMoveFile={handleFileMoved}
        activePath={editFile?.path}
      />

      {nav && <div className="nav-backdrop" onClick={() => setNav(null)} />}

      {termMode && (
        <div className="term-overlay" onClick={(e) => e.target === e.currentTarget && setTermMode(null)}>
          <div className="term-panel">
            <div className="term-head">
              <span className="term-title">
                {termMode === "shell" ? "Shell · bash" : "TUI · Claude Code + glm-5.2:cloud"}
              </span>
              <button className="term-close" onClick={() => setTermMode(null)}>
                ✕ close
              </button>
            </div>
            <Suspense fallback={<div className="term-loading">starting terminal…</div>}>
              {termMode === "shell" ? (
                <Terminal key="shell" path="/shell" cwd={selectedCwd || workspaceRoot} />
              ) : (
                <Terminal key="tui" path="/term" />
              )}
            </Suspense>
          </div>
        </div>
      )}

      {skillsOpen && (
        <Skills cwd={selectedCwd || workspaceRoot} workspaceRoot={workspaceRoot} onClose={() => setSkillsOpen(false)} />
      )}

      {usageOpen && (
        <Suspense fallback={null}>
          <Usage onClose={() => setUsageOpen(false)} />
        </Suspense>
      )}

      <Lightbox />
    </div>
  );
}