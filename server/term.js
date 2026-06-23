import { WebSocketServer } from "ws";
import { resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { internalToken } from "./internal-token.js";

const require = createRequire(import.meta.url);

// node-pty is a native module; load it lazily so a build failure doesn't break
// server startup — callers get a clear error when /term or /shell is used.
let pty = null;
function loadPty() {
  if (pty) return pty;
  try {
    pty = require("node-pty");
  } catch (e) {
    throw new Error("node-pty not available; rebuild it (needs g++): " + e.message);
  }
  return pty;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Confine a requested cwd to the workspace root (prevents the shell from being
// spawned in an arbitrary directory via the query string).
function safeCwd(req) {
  let cwd = config.workspaceRoot;
  try {
    const u = new URL(req.url, "http://dummy");
    const want = u.searchParams.get("cwd");
    if (want) {
      const target = resolve(config.workspaceRoot, want);
      const rel = relative(config.workspaceRoot, target);
      if (!rel.startsWith("..") && !rel.includes(`..${sep}`) && existsSync(target)) cwd = target;
    }
  } catch {
    /* fall back to workspace root */
  }
  return cwd;
}

/**
 * Spawn the coding-ui TUI (tui/index.js). It connects back to this backend's
 * /ws, so chats started in the embedded TUI share sessions with the web UI.
 */
function spawnTui() {
  const wsUrl = `ws://127.0.0.1:${config.port}/ws`;
  return pty.spawn("node", ["tui/index.js"], {
    name: "xterm",
    cols: 90,
    rows: 28,
    cwd: root,
    env: {
      ...process.env,
      TERM: "xterm", // verified clean with blessed (xterm-256color trips a terminfo parse error)
      CODE_UI_WS: wsUrl,
      CODE_UI_CWD: config.workspaceRoot,
      CODE_UI_TOKEN: internalToken, // lets the TUI auth its /ws connection without a cookie
    },
  });
}

/**
 * Spawn an interactive shell (bash). cwd is confined under WORKSPACE_ROOT.
 */
function spawnShell(req) {
  const shell = process.env.SHELL || "bash";
  return pty.spawn(shell, [], {
    name: "xterm",
    cols: 90,
    rows: 28,
    cwd: safeCwd(req),
    env: { ...process.env, TERM: "xterm" },
  });
}

/**
 * Build a noServer WebSocket server that bridges a browser xterm.js terminal to
 * a server-side PTY. `spawnFn(req)` returns the node-pty process to attach.
 */
function createPtyWs(spawnFn) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws, req) => {
    let ptyProc = null;
    let closed = false;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      const proc = ptyProc;
      if (!proc) return;
      // Graceful SIGHUP first (lets the child close its sockets); SIGKILL
      // fallback guarantees the PTY dies even if SIGHUP is caught/missed.
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, 500).unref();
    };

    ws.on("close", cleanup);
    ws.on("error", cleanup);

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };

    try {
      loadPty();
      ptyProc = spawnFn(req);
    } catch (e) {
      send({ type: "data", data: `\r\n${e.message}\r\n` });
      send({ type: "exit", code: 1 });
      ws.close();
      return;
    }

    ptyProc.onData((data) => send({ type: "data", data }));
    ptyProc.onExit(({ exitCode }) => {
      send({ type: "exit", code: exitCode });
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "data" && typeof msg.data === "string") {
        ptyProc?.write(msg.data);
      } else if (msg.type === "resize" && Number.isFinite(msg.cols) && Number.isFinite(msg.rows)) {
        try {
          ptyProc?.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
        } catch {
          /* some PTYs reject resize mid-shutdown */
        }
      }
    });
  });

  return wss;
}

// noServer mode: index.js owns the single 'upgrade' dispatcher that routes
// /ws, /term, and /shell to their respective WSS instances.
export function attachTerm() {
  return {
    term: createPtyWs(spawnTui),
    shell: createPtyWs(spawnShell),
  };
}