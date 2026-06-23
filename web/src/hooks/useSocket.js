import { useEffect, useRef, useState, useCallback } from "react";

// Open one shared WebSocket to the backend and expose a send() helper plus
// a subscription mechanism for incoming events. Reconnects on close.
// `enabled` gates the connection (e.g. until authenticated) so an unauthed
// client doesn't spin a reconnect loop against a server that rejects it.
export function useSocket(onEvent, enabled = true) {
  const wsRef = useRef(null);
  const onEventRef = useRef(onEvent);
  const [ready, setReady] = useState(false);
  const [queue, setQueue] = useState([]);
  // Mirror the queue into a ref so ws.onopen can flush it as a side effect
  // OUTSIDE a state updater. The previous code sent inside setQueue((q)=>…),
  // which React 18 StrictMode double-invokes in dev → every queued message was
  // sent twice.
  const queueRef = useRef([]);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (!enabled) return; // socket is opened/kept only while enabled
    let ws;
    let closed = false;
    let retry;
    let attempt = 0; // reconnect attempt counter for backoff

    function open() {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        setReady(true);
        attempt = 0;
        // Flush queued messages outside the state updater (see queueRef note).
        const pending = queueRef.current;
        queueRef.current = [];
        if (pending.length) setQueue([]);
        for (const m of pending) {
          try {
            ws.send(JSON.stringify(m));
          } catch {
            /* ws closed mid-flush — re-queue would risk duplicates, drop */
          }
        }
      };
      ws.onmessage = (e) => {
        let evt;
        try {
          evt = JSON.parse(e.data);
        } catch {
          return;
        }
        onEventRef.current?.(evt);
      };
      ws.onclose = () => {
        setReady(false);
        wsRef.current = null;
        if (closed) return;
        // Exponential backoff with jitter so a down backend doesn't get hit
        // every 1.5s forever, and a fleet of clients doesn't hammer in lockstep.
        const base = Math.min(1500 * 2 ** attempt, 30000);
        const jitter = Math.random() * 500;
        attempt += 1;
        retry = setTimeout(open, base + jitter);
      };
      ws.onerror = () => ws.close();
    }
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
      wsRef.current = null;
    };
  }, [enabled]);

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        queueRef.current.push(msg);
        setQueue(queueRef.current);
      }
    } else {
      queueRef.current.push(msg);
      setQueue(queueRef.current);
    }
  }, []);

  return { send, ready };
}