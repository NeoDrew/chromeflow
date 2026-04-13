/**
 * Offscreen document — maintains persistent WebSocket connections to one or
 * more chromeflow MCP servers (one per port in the range 7878-7888).
 *
 * Each connection represents a separate Claude Code instance. Messages from
 * each connection are tagged with the source port so the background script
 * can route them to the correct assigned Chrome window.
 */

const PORT_BASE = 7878;
const PORT_MAX = 7888;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

type Conn = {
  port: number;
  ws: WebSocket | null;
  reconnectDelay: number;
  connected: boolean;
  label?: string;
};

const connections: Conn[] = [];

for (let p = PORT_BASE; p <= PORT_MAX; p++) {
  const conn: Conn = { port: p, ws: null, reconnectDelay: RECONNECT_BASE_MS, connected: false };
  connections.push(conn);
  connect(conn);
}

function connect(conn: Conn) {
  try {
    conn.ws = new WebSocket(`ws://localhost:${conn.port}`);
  } catch {
    scheduleReconnect(conn);
    return;
  }

  conn.ws.onopen = () => {
    console.log(`[chromeflow offscreen] Connected to MCP server on port ${conn.port}`);
    conn.reconnectDelay = RECONNECT_BASE_MS;
    conn.connected = true;
    conn.ws!.send(JSON.stringify({ type: "ready" }));
    publishLivePorts();
  };

  conn.ws.onmessage = (event) => {
    let msg: { type: string; requestId?: string; [key: string]: unknown };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Identity message — store label and re-publish so popup can show project name
    if (msg.type === "identity") {
      conn.label = (msg.label as string) || undefined;
      publishLivePorts();
      return;
    }

    // Forward to background, get response. Tag with source port so background
    // can route to the right Claude window assignment.
    chrome.runtime.sendMessage(
      { source: "chromeflow-offscreen", port: conn.port, payload: msg },
      (response: { ok: boolean; result?: unknown; error?: string }) => {
        if (chrome.runtime.lastError) {
          sendError(conn, msg.requestId, chrome.runtime.lastError.message ?? "Unknown error");
          return;
        }
        if (!response.ok) {
          sendError(conn, msg.requestId, response.error ?? "Unknown error");
          return;
        }
        const result = response.result as Record<string, unknown>;
        conn.ws?.send(JSON.stringify({ ...result, requestId: msg.requestId }));
      }
    );
  };

  conn.ws.onclose = () => {
    if (conn.connected) {
      console.log(`[chromeflow offscreen] Disconnected from port ${conn.port}`);
    }
    conn.connected = false;
    conn.ws = null;
    publishLivePorts();
    scheduleReconnect(conn);
  };

  conn.ws.onerror = () => {
    // Errors are followed by onclose, which handles reconnect.
  };
}

function scheduleReconnect(conn: Conn) {
  setTimeout(() => connect(conn), conn.reconnectDelay);
  conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_MAX_MS);
}

function sendError(conn: Conn, requestId: string, message: string) {
  conn.ws?.send(JSON.stringify({ type: "error", requestId, message }));
}

function publishLivePorts() {
  // Offscreen documents cannot access chrome.storage directly — forward the
  // live ports to the background worker via runtime messaging, and let it
  // persist to storage and broadcast to the popup.
  const livePorts = connections
    .filter((c) => c.connected)
    .map((c) => ({ port: c.port, label: c.label }));
  chrome.runtime.sendMessage({ source: "chromeflow-offscreen", type: "status", livePorts }).catch(() => {
    // Background may be starting up, ignore
  });
}
