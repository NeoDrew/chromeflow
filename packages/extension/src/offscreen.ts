/**
 * Offscreen document — maintains persistent WebSocket connections to one or more
 * automation servers.
 *
 * Two sources of connections:
 *  1. The default loopback range 7878-7888, one per local Claude Code / MCP
 *     instance. Connected on startup exactly as before, so local usage is
 *     unchanged when no config exists.
 *  2. User-configured endpoints (local or remote wss://) and pause flags, owned
 *     by the background worker in chrome.storage and pushed here as a
 *     `chromeflow-config` message. We reconcile our live sockets against them.
 *
 * Each connection is tagged with its connId (== port for the default range) so
 * the background script routes its messages to the correct assigned window. This
 * file knows nothing about what any endpoint is for; it is a generic transport.
 */

import {
  CONFIG_MSG_SOURCE,
  DEFAULT_PORT_BASE,
  DEFAULT_PORT_MAX,
  isDefaultPort,
  type ConnConfig,
  type ConnKind,
} from "./connections";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5000;

type Host = "claude" | "codex";

type Conn = {
  /** Routing key, == port for the default range, >= 8000 for configured remotes. */
  port: number;
  ws: WebSocket | null;
  reconnectDelay: number;
  connected: boolean;
  label?: string;
  host?: Host;
  kind: ConnKind;
  url: string;
  token?: string;
  /** False = paused: do not connect, and do not auto-reconnect on close. */
  enabled: boolean;
};

const connections: Conn[] = [];

// Seed the default loopback range and connect immediately (unchanged behaviour).
for (let p = DEFAULT_PORT_BASE; p <= DEFAULT_PORT_MAX; p++) {
  const conn: Conn = {
    port: p,
    ws: null,
    reconnectDelay: RECONNECT_BASE_MS,
    connected: false,
    kind: "local",
    url: `ws://localhost:${p}`,
    enabled: true,
  };
  connections.push(conn);
  connect(conn);
}

// Ask the background worker to push any saved config (remotes + pauses + scope).
chrome.runtime
  .sendMessage({ source: "chromeflow-offscreen", type: "request-config" })
  .catch(() => {
    // Background may still be starting; it also pushes config on boot.
  });

function connect(conn: Conn) {
  if (!conn.enabled) return;
  try {
    conn.ws = new WebSocket(conn.url);
  } catch {
    scheduleReconnect(conn);
    return;
  }

  conn.ws.onopen = () => {
    conn.reconnectDelay = RECONNECT_BASE_MS;
    conn.connected = true;
    // The default local handshake is a bare {type:"ready"}. Configured endpoints
    // may carry a token (also expressible directly in the URL query).
    const ready: { type: "ready"; token?: string } = { type: "ready" };
    if (conn.token) ready.token = conn.token;
    conn.ws!.send(JSON.stringify(ready));
    publishLivePorts();
  };

  conn.ws.onmessage = (event) => {
    let msg: { type: string; requestId?: string; [key: string]: unknown };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Identity message — store label/host and re-publish so the popup can show
    // the project name and the originating host.
    if (msg.type === "identity") {
      conn.label = (msg.label as string) || conn.label || undefined;
      const host = msg.host as string | undefined;
      conn.host = host === "claude" || host === "codex" ? host : undefined;
      publishLivePorts();
      return;
    }

    // Forward to background, get response. Tagged with the source connId so
    // background can route to the right window assignment and apply scope.
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
    conn.connected = false;
    conn.ws = null;
    publishLivePorts();
    if (conn.enabled) scheduleReconnect(conn);
  };

  conn.ws.onerror = () => {
    // Errors are followed by onclose, which handles reconnect.
  };
}

function scheduleReconnect(conn: Conn) {
  if (!conn.enabled) return;
  setTimeout(() => connect(conn), conn.reconnectDelay);
  conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_MAX_MS);
}

function closeSocket(conn: Conn) {
  if (conn.ws) {
    try {
      conn.ws.close();
    } catch {
      /* already closing */
    }
  }
}

/**
 * Reconcile live sockets against the configured connection list. Default-range
 * ports stay connected unless an explicit config pauses them; configured remotes
 * are added/updated/removed; pausing closes a socket and stops its reconnects.
 * Only acts on real differences to avoid reconnect-backoff thrash.
 */
function reconcile(configs: ConnConfig[]) {
  const byId = new Map<number, ConnConfig>(configs.map((c) => [c.connId, c]));

  // 1. Default-range ports: honour pause/label from any matching config.
  for (const conn of connections) {
    if (conn.kind !== "local") continue;
    const cfg = byId.get(conn.port);
    if (cfg?.label) conn.label = cfg.label;
    const wantEnabled = cfg ? cfg.enabled : true; // unconfigured default = on
    if (wantEnabled && !conn.enabled) {
      conn.enabled = true;
      if (!conn.connected) connect(conn);
    } else if (!wantEnabled && conn.enabled) {
      conn.enabled = false;
      closeSocket(conn);
    }
  }

  // 2. Configured remotes: add / update / enable / disable.
  for (const cfg of configs) {
    if (isDefaultPort(cfg.connId)) continue;
    let conn = connections.find((c) => c.port === cfg.connId);
    if (!conn) {
      conn = {
        port: cfg.connId,
        ws: null,
        reconnectDelay: RECONNECT_BASE_MS,
        connected: false,
        kind: "remote",
        url: cfg.url,
        token: cfg.token,
        enabled: cfg.enabled,
        label: cfg.label,
      };
      connections.push(conn);
      if (conn.enabled) connect(conn);
      continue;
    }
    const urlChanged = conn.url !== cfg.url || conn.token !== cfg.token;
    conn.url = cfg.url;
    conn.token = cfg.token;
    conn.label = cfg.label;
    if (cfg.enabled) {
      conn.enabled = true;
      if (urlChanged && conn.ws) {
        closeSocket(conn); // onclose reconnects to the new url
      } else if (!conn.connected && !conn.ws) {
        connect(conn);
      }
    } else if (conn.enabled) {
      conn.enabled = false;
      closeSocket(conn);
    }
  }

  // 3. Configured remotes that vanished from config: close and drop.
  for (let i = connections.length - 1; i >= 0; i--) {
    const conn = connections[i];
    if (conn.kind === "remote" && !byId.has(conn.port)) {
      conn.enabled = false;
      closeSocket(conn);
      connections.splice(i, 1);
    }
  }

  publishLivePorts();
}

function sendError(conn: Conn, requestId: string | undefined, message: string) {
  if (!requestId) return;
  conn.ws?.send(JSON.stringify({ type: "error", requestId, message }));
}

function publishLivePorts() {
  // Offscreen cannot access chrome.storage — forward live connections to the
  // background worker, which persists and broadcasts to the popup.
  const livePorts = connections
    .filter((c) => c.connected)
    .map((c) => ({ port: c.port, label: c.label, host: c.host, kind: c.kind }));
  chrome.runtime
    .sendMessage({ source: "chromeflow-offscreen", type: "status", livePorts })
    .catch(() => {
      // Background may be starting up, ignore.
    });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Progress heartbeats forwarded to the right WS so the server's timer resets.
  if (msg && msg.source === "chromeflow-progress" && typeof msg.port === "number") {
    const conn = connections.find((c) => c.port === msg.port);
    if (conn?.ws && conn.connected) {
      try {
        conn.ws.send(
          JSON.stringify({
            type: "progress",
            requestId: msg.requestId,
            phase: msg.phase,
            detail: msg.detail,
          })
        );
      } catch {
        /* WS may have closed mid-send; bridge will fire its own timeout */
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  // Configured-connection list pushed from the background worker.
  if (
    msg &&
    msg.source === CONFIG_MSG_SOURCE &&
    msg.type === "connections" &&
    Array.isArray(msg.connections)
  ) {
    reconcile(msg.connections as ConnConfig[]);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});
