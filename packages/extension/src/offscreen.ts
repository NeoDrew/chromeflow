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
  isSafeRemoteUrl,
  type ConnConfig,
  type ConnKind,
} from "./connections";

// Chrome's MV3 service worker for an unpacked (dev-mode) extension does not
// reliably re-read background.js from disk on a browser restart — not
// chrome://restart, not even a full quit-and-relaunch — the way content
// scripts and THIS offscreen document do (both get a genuinely fresh load
// each time, same mechanism as a page navigation). Only an explicit
// chrome://extensions "Reload" click, or a call to chrome.runtime.reload()
// from ANY extension context, forces the service worker itself to refresh.
// Since this file DOES load fresh, it's the one place that can reliably
// carry a new instruction across a restart when the service worker can't —
// so on version mismatch, force a real extension reload once. Keyed by
// version (not a one-time boolean) so this also self-heals after every
// future version bump, not just this one. chrome.storage.local survives
// chrome.runtime.reload() (only uninstall clears it), so this can never
// loop: the reload lands on the SAME version, matches on the next load, and
// stays quiet.
(async () => {
  try {
    const currentVersion = chrome.runtime.getManifest().version;
    const { chromeflowLastForceReloadVersion } = await chrome.storage.local.get("chromeflowLastForceReloadVersion");
    if (chromeflowLastForceReloadVersion !== currentVersion) {
      await chrome.storage.local.set({ chromeflowLastForceReloadVersion: currentVersion });
      chrome.runtime.reload();
    }
  } catch { /* best-effort — never block the connection setup below */ }
})();

const RECONNECT_BASE_MS = 1000;
// Cap generic (host-down) backoff at 30s rather than hammering a dead endpoint
// every few seconds forever.
const RECONNECT_MAX_MS = 5000;
// Drop (and close) any inbound frame larger than this. A malicious/buggy remote
// could otherwise stream hundreds of MB into JSON.parse and OOM the offscreen
// document, taking down every connection (local included) that shares it.
const MAX_INBOUND_BYTES = 16 * 1024 * 1024;

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
  /** Pending reconnect timer handle, so pause/disconnect/url-change can cancel it. */
  reconnectTimer?: ReturnType<typeof setTimeout>;
  /**
   * Set when the endpoint closed with a policy/auth code (or the URL is unsafe):
   * stop auto-reconnecting so a rejected token doesn't storm the server forever.
   * Cleared when the user edits the URL/token (reconcile) so a fix retries.
   */
  terminal?: boolean;
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
  if (!conn.enabled || conn.terminal) return;
  // One socket per connId: never open a second while one exists (CONNECTING or
  // OPEN). Reconnect always flows through onclose → scheduleReconnect after ws is
  // nulled, so a stray connect() call here must not orphan a live socket.
  if (conn.ws) return;
  // Refuse to ever open an insecure remote endpoint, regardless of how the config
  // arrived (manual add, or a page-initiated prefill). wss:// is required for
  // remotes; plain ws:// only to loopback. This is the authoritative check; the
  // popup also validates, but this guarantees the token is never sent cleartext.
  if (conn.kind === "remote" && !isSafeRemoteUrl(conn.url)) {
    console.warn("chromeflow: refusing insecure remote endpoint (wss:// required):", conn.url);
    conn.terminal = true;
    return;
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(conn.url);
    conn.ws = socket;
  } catch {
    scheduleReconnect(conn);
    return;
  }

  socket.onopen = () => {
    conn.reconnectDelay = RECONNECT_BASE_MS;
    conn.connected = true;
    // The default local handshake is a bare {type:"ready"}. Configured endpoints
    // may carry a token (also expressible directly in the URL query).
    // extId/extVersion added 2026-08-11 for a live-diagnosis case: two
    // chromeflow-labeled extensions were installed in the same profile (one
    // disabled) and it was impossible to tell which one a given WS connection
    // actually came from — there was no such signal in this protocol at all.
    //
    // Wrapped in try/catch as a safety net: a stale/zombie offscreen document
    // surviving an extension reload can have an invalidated chrome.runtime
    // binding (live-confirmed 2026-09-14: "chrome.runtime.getManifest is not
    // a function" thrown right here, uncaught, on every reconnect from a
    // zombie instance — silently killing the ready handshake for good since
    // nothing downstream of the throw ever ran). The real fix is
    // ensureOffscreen(force) closing and recreating the document on every
    // extension reload (see background/state.ts) so this shouldn't happen
    // going forward, but connect() still sends the still-connected socket
    // with no identity rather than throwing into the void if it ever does.
    try {
      const manifest = chrome.runtime.getManifest();
      const ready: { type: "ready"; token?: string; extId: string; extVersion: string } = {
        type: "ready",
        extId: chrome.runtime.id,
        extVersion: manifest.version,
      };
      if (conn.token) ready.token = conn.token;
      socket.send(JSON.stringify(ready));
    } catch (err) {
      console.warn("chromeflow: failed to send ready handshake (extension context may be stale — try reloading the extension):", err);
      try { socket.send(JSON.stringify({ type: "ready" })); } catch { /* socket itself may be the problem */ }
    }
    publishLivePorts();
  };

  // Reply only on the socket that received the request, and only if it is still
  // this connection's live socket — so a response can never be written to a
  // newer socket after a reconnect/url-change (which would misroute it).
  const reply = (obj: unknown) => {
    if (conn.ws === socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(obj));
    }
  };

  socket.onmessage = (event) => {
    // Bound inbound size before JSON.parse to avoid an OOM from a hostile remote.
    // Covers text frames (string length) and binary frames (ArrayBuffer/Blob).
    const data = event.data;
    const size =
      typeof data === "string" ? data.length : (data?.byteLength ?? data?.size ?? 0);
    if (size > MAX_INBOUND_BYTES) {
      console.warn("chromeflow: dropping oversized inbound frame", size, "bytes from", conn.url);
      try { socket.close(1009, "message too big"); } catch { /* already closing */ }
      return;
    }

    let msg: { type: string; requestId?: string; [key: string]: unknown };
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    // Structural guard: a usable message needs a string `type`; a reflected
    // `requestId`, when present, must also be a string (it becomes a map key and
    // is echoed back).
    if (typeof msg.type !== "string") return;
    if (msg.requestId !== undefined && typeof msg.requestId !== "string") return;

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
        if (!msg.requestId) return;
        if (chrome.runtime.lastError) {
          reply({ type: "error", requestId: msg.requestId, message: chrome.runtime.lastError.message ?? "Unknown error" });
          return;
        }
        if (!response.ok) {
          reply({ type: "error", requestId: msg.requestId, message: response.error ?? "Unknown error" });
          return;
        }
        const result = response.result as Record<string, unknown>;
        reply({ ...result, requestId: msg.requestId });
      }
    );
  };

  socket.onclose = (ev) => {
    // Ignore a close from a socket we've already replaced (defensive).
    if (conn.ws !== null && conn.ws !== socket) return;
    conn.connected = false;
    conn.ws = null;
    publishLivePorts();
    // Honor policy/auth close codes: 1008 (policy violation) and the 4000-4999
    // application range (servers conventionally use these to signal a rejected
    // token). Do NOT auto-reconnect on those — a bad token would otherwise storm
    // the endpoint forever. Generic closes (host down, 1006) back off and retry.
    const terminalClose = ev.code === 1008 || (ev.code >= 4000 && ev.code <= 4999);
    if (terminalClose) {
      conn.terminal = true;
      console.warn("chromeflow: connection rejected by endpoint (code", ev.code + "); not reconnecting:", conn.url);
      return;
    }
    if (conn.enabled) scheduleReconnect(conn);
  };

  socket.onerror = () => {
    // Errors are followed by onclose, which handles reconnect.
  };
}

function scheduleReconnect(conn: Conn) {
  if (!conn.enabled || conn.terminal) return;
  // Track the handle so pause/disconnect/url-change can cancel a pending retry
  // (otherwise a stale timer could fire connect() after the user paused, or
  // stack a second socket alongside a reconnect already in flight).
  if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
  conn.reconnectTimer = setTimeout(() => {
    conn.reconnectTimer = undefined;
    connect(conn);
  }, conn.reconnectDelay);
  conn.reconnectDelay = Math.min(conn.reconnectDelay * 2, RECONNECT_MAX_MS);
}

function closeSocket(conn: Conn) {
  if (conn.reconnectTimer) {
    clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = undefined;
  }
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
    // Editing the URL/token is the user's "try again" — clear a terminal (auth-
    // rejected / unsafe-url) state and reset backoff so the fix actually retries.
    if (urlChanged) {
      conn.terminal = false;
      conn.reconnectDelay = RECONNECT_BASE_MS;
    }
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
