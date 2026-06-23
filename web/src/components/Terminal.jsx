import { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// In-browser terminal that pipes a server-side PTY over a WebSocket. One PTY
// per mount; torn down on unmount. `path` selects the backend endpoint
// ("/term" = the coding-ui TUI, "/shell" = an interactive bash). `cwd` is sent
// as a query param for /shell to set the starting directory.
export default function Terminal({ path = "/term", cwd }) {
  const hostRef = useRef(null);

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "monospace",
      fontSize: 14,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);

    let ws = null;
    let ro = null;
    let disposed = false;

    // Fit the terminal to its container and push the new size to the PTY.
    function sendResize() {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    }

    function open() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const qs = cwd ? `?cwd=${encodeURIComponent(cwd)}` : "";
      ws = new WebSocket(`${proto}://${location.host}${path}${qs}`);

      ws.onopen = () => sendResize();
      ws.onmessage = (e) => {
        let evt;
        try {
          evt = JSON.parse(e.data);
        } catch {
          return;
        }
        if (evt.type === "data") term.write(evt.data);
        else if (evt.type === "exit")
          term.write(`\r\n\x1b[31m[TUI exited${evt.code != null ? " code=" + evt.code : ""}]\x1b[0m\r\n`);
      };
      ws.onclose = () => {
        if (!disposed) term.write("\r\n\x1b[31m[disconnected]\x1b[0m\r\n");
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
    }

    const host = hostRef.current;
    term.open(host);
    term.focus(); // xterm needs focus to receive keystrokes

    // Fit after layout has settled (the overlay may not have dimensions on
    // the first synchronous pass). rAF + a short delay covers slow paints.
    requestAnimationFrame(() => {
      sendResize();
      setTimeout(sendResize, 50);
    });

    open();

    term.onData((d) => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "data", data: d }));
    });

    // Keep the PTY sized to the container, and reclaim focus on click.
    ro = new ResizeObserver(() => sendResize());
    ro.observe(host);
    window.addEventListener("resize", sendResize);
    const onClick = () => term.focus();
    host.addEventListener("mousedown", onClick);

    return () => {
      disposed = true;
      window.removeEventListener("resize", sendResize);
      ro?.disconnect();
      host.removeEventListener("mousedown", onClick);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      term.dispose();
    };
  }, [path, cwd]);

  return <div className="term-host" ref={hostRef} tabIndex={0} />;
}