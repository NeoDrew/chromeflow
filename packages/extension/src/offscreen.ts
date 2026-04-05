/**
 * Offscreen document — maintains a persistent WebSocket connection to the
 * chromeflow MCP server and relays messages to/from the background service worker.
 *
 * This runs in a hidden document that Chrome keeps alive, avoiding the
 * service worker sleep limitation.
 */

const WS_URL = "ws://localhost:7878";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_BASE_MS;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[chromeflow offscreen] Connected to MCP server");
    reconnectDelay = RECONNECT_BASE_MS; // reset backoff on successful connection
    ws!.send(JSON.stringify({ type: "ready" }));
    updateStatus("connected");
  };

  ws.onmessage = async (event) => {
    let msg: { type: string; requestId: string; [key: string]: unknown };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    // Forward to background, get response
    chrome.runtime.sendMessage(
      { source: "chromeflow-offscreen", payload: msg },
      (response: { ok: boolean; result?: unknown; error?: string }) => {
        if (chrome.runtime.lastError) {
          sendError(msg.requestId, chrome.runtime.lastError.message ?? "Unknown error");
          return;
        }
        if (!response.ok) {
          sendError(msg.requestId, response.error ?? "Unknown error");
          return;
        }
        // Send the result back to the MCP server with the requestId
        const result = response.result as Record<string, unknown>;
        ws?.send(
          JSON.stringify({ ...result, requestId: msg.requestId })
        );
      }
    );
  };

  ws.onclose = () => {
    console.log(`[chromeflow offscreen] Disconnected. Reconnecting in ${reconnectDelay}ms...`);
    updateStatus("disconnected");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS); // exponential backoff
  };

  ws.onerror = (err) => {
    console.error("[chromeflow offscreen] WS error", err);
  };
}

function sendError(requestId: string, message: string) {
  ws?.send(JSON.stringify({ type: "error", requestId, message }));
}

function updateStatus(status: "connected" | "disconnected") {
  // Notify popup if open
  chrome.runtime.sendMessage({ source: "chromeflow-offscreen", type: "status", status }).catch(() => {
    // Popup may not be open, ignore
  });
}

connect();
