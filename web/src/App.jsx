import { useEffect, useRef, useState } from "react";
import { useSocket } from "./hooks/useSocket.js";
import Sidebar from "./components/Sidebar.jsx";
import Message from "./components/Message.jsx";
import Composer from "./components/Composer.jsx";
import FileTree from "./components/FileTree.jsx";
import Editor from "./components/Editor.jsx";
import Terminal from "./components/Terminal.jsx";
import Login from "./components/Login.jsx";

const empty = [];

// Derive a workspace's folder name from its absolute path (null for the root
// workspace, which is not deletable).
function workspaceName(cwd, root) {
  if (!cwd || !root || cwd === root) return null;
  const rel = cwd.startsWith(root + "/") ? cwd.slice(root.length + 1) : cwd.slice(root.length);
  return rel || null;
}

export default function App() {
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [msgs, setMsgs] = useState({}); // {sessionId: messages[]}
  const [busyBy, setBusyBy] = useState({}); // {sessionId: bool}
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
  const [editFile, setEditFile] = useState(null); // { path, cwd } when editing a file in main area
  const [authed, setAuthed] = useState(null); // null=checking, false=show login, true=app
  const [toast, setToast] = useState(""); // transient server error banner
  const [nav, setNav] = useState(null); // mobile drawer: null | "sidebar" | "files"
  const messagesEndRef = useRef(null);
  const toastTimer = useRef(null);

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
  // is also added so resumed sessions stay selectable.
  function refreshModels(initial = false) {
    fetch("/api/models")
      .then((r) => r.json())
      .then((j) => {
        const list = Array.isArray(j.models) && j.models.length ? j.models : [j.default || "glm-5.2:cloud"];
        setDefaultModel(j.default || list[0]);
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
        refreshWorkspaces(evt.config?.workspaceRoot || "");
        sendRef.current?.({ type: "list" });
        break;
      case "sessions":
        // Merge by id instead of replacing wholesale: handleResult fires `list`
        // on every turn end, and a bare replace would wipe the `ended` flag set
        // by a prior `exit` event (so the sidebar would stop showing "· ended").
        setSessions((cur) => {
          const byId = new Map(cur.map((s) => [s.id, s]));
          return (evt.items || []).map((s) => {
            const ex = byId.get(s.id);
            return ex && ex.ended ? { ...s, ended: true } : s;
          });
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
        setBusyBy((p) => ({ ...p, [evt.sessionId]: false }));
        if (evt.model) {
          ensureModelOption(evt.model);
          setModel(evt.model);
        }
        if (!evt.resumed) setMsgs((p) => ({ ...p, [evt.sessionId]: p[evt.sessionId] || [] }));
        break;
      case "history":
        // Prior transcript for a resumed session (loaded from disk by the
        // backend, since --resume doesn't replay it in stream-json mode).
        // History images arrive as lightweight {mediaType, url} refs served by
        // GET /api/transcript/image. Defensive fallback: if an image carries
        // raw base64 `data` without a url/dataUrl, synthesize a dataUrl.
        // Assistant messages are normalized to a `blocks` array so Message's
        // .map never throws if a future backend shape sends Anthropic `content`.
        setMsgs((p) => ({
          ...p,
          [evt.sessionId]: (evt.messages || []).map((m) => {
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
          }),
        }));
        break;
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
        setSessions((cur) => cur.map((s) => (s.id === evt.sessionId ? { ...s, ended: true } : s)));
        if (evt.sessionId === activeIdRef.current)
          flashToast(`session ended${evt.code != null ? ` (exit ${evt.code})` : ""} — start a new chat to continue`);
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
    if (data.type === "result") return handleResult(sessionId, data);
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
          return b;
        });
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

  function handleResult(sessionId) {
    setBusyBy((p) => ({ ...p, [sessionId]: false }));
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
    sendRef.current?.({ type: "list" });
  }

  function newChat() {
    const cwd = selectedCwd || workspaceRoot;
    send({ type: "start", cwd, model: selectedModel });
  }

  // Apply a model choice. With a chat open, this restarts the active session
  // under the new model (--resume keeps the transcript); without one it just
  // sets the model for the next + New chat.
  function applyModel(m) {
    if (activeId) {
      if (busy && !window.confirm("Switching models restarts this session and stops any running turn. Continue?"))
        return;
      send({ type: "start", sessionId: activeId, model: m });
    } else {
      setSelectedModel(m);
    }
  }

  function onModelChange(e) {
    applyModel(e.target.value);
  }

  function pickSession(id) {
    const s = sessions.find((x) => x.id === id);
    // Selecting a session also switches to its workspace so the file tree and
    // session list stay scoped to the workspace that owns the conversation.
    if (s?.cwd) pickWorkspace(s.cwd);
    send({ type: "start", sessionId: id, cwd: s?.cwd || selectedCwd || workspaceRoot });
    setNav(null);
  }

  function sendMessage(text, attachments = []) {
    if (!activeId) return;
    // Optimistic local render keeps a dataUrl (for thumbnails) rather than the
    // raw base64, so message state stays small. The WS payload sends raw base64.
    // A stable uid keys the user message so React doesn't reuse the wrong
    // instance across rename/reorder (index keys did).
    const images = attachments.map((a) => ({ mediaType: a.mediaType, dataUrl: a.dataUrl }));
    const uid = `u${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setMsgs((prev) => ({
      ...prev,
      [activeId]: [
        ...(prev[activeId] || []),
        { role: "user", uid, text, ...(images.length ? { images } : {}) },
      ],
    }));
    send({
      type: "send",
      sessionId: activeId,
      text,
      ...(attachments.length
        ? { images: attachments.map((a) => ({ mediaType: a.mediaType, data: a.data })) }
        : {}),
    });
  }

  function stop() {
    if (activeId) send({ type: "stop", sessionId: activeId });
  }

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

  const activeMsgs = activeId ? msgs[activeId] || empty : empty;
  const busy = activeId ? !!busyBy[activeId] : false;
  const activeCwd = activeId ? cwdBy[activeId] : selectedCwd;
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

  // Auto-scroll. Depending on only [length, busy] missed streaming: the
  // assistant message is appended once on message_start (length +1) but its
  // block text mutates on every token without changing length. `activeMsgs`
  // gets a new identity on every setMsgs, so depending on it follows tokens.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
        onPick={pickSession}
        onNew={newChat}
        onRemove={removeSession}
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
          <select
            className="model-pick"
            value={activeId ? model : selectedModel}
            onChange={onModelChange}
            onFocus={() => refreshModels(false)}
            title={activeId ? "Switch this session's model (restarts with resume)" : "Model for the next new chat"}
          >
            {modelOptions.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <button onClick={() => setTermMode("tui")}>TUI</button>
          <button onClick={() => setTermMode("shell")}>Shell</button>
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
        <div className="messages">
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
            <Message key={m.id || m.uid || `u${i}`} msg={m} />
          ))}
          <div ref={messagesEndRef} />
        </div>

        <Composer onSend={sendMessage} onStop={stop} busy={busy} disabled={!activeId} />
          </>
        )}
      </div>

      <FileTree
        cwd={selectedCwd || workspaceRoot}
        key={selectedCwd || "none"}
        onOpenFile={openFile}
        onDeleteFile={handleFileDeleted}
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
            {termMode === "shell" ? (
              <Terminal key="shell" path="/shell" cwd={selectedCwd || workspaceRoot} />
            ) : (
              <Terminal key="tui" path="/term" />
            )}
          </div>
        </div>
      )}
    </div>
  );
}