import { WebSocketServer, WebSocket } from "ws";
import path from "path";
import type { ClientMessage, DistributiveOmit, ServerMessage } from "./types.js";

type ServerMessagePayload = DistributiveOmit<ServerMessage, "requestId">;

const WS_PORT_BASE = 7878;
const WS_PORT_MAX = 7888;
const REQUEST_TIMEOUT_MS = 30_000;

type PendingRequest = {
  resolve: (value: ClientMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class WsBridge {
  private wss!: WebSocketServer;
  private client: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private port: number = WS_PORT_BASE;

  constructor() {
    this.bind(WS_PORT_BASE);
  }

  private bind(tryPort: number) {
    if (tryPort > WS_PORT_MAX) {
      console.error(
        `[chromeflow] All ports ${WS_PORT_BASE}-${WS_PORT_MAX} are in use. Cannot start MCP server.`
      );
      return;
    }

    const wss = new WebSocketServer({ port: tryPort });

    wss.on("error", (err: Error & { code?: string }) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[chromeflow] Port ${tryPort} in use, trying ${tryPort + 1}...`);
        this.bind(tryPort + 1);
      } else {
        console.error("[chromeflow] WS server error:", err);
      }
    });

    wss.on("listening", () => {
      this.wss = wss;
      this.port = tryPort;
      console.error(`[chromeflow] WS bridge listening on ws://localhost:${tryPort}`);
    });

    wss.on("connection", (ws) => {
      if (this.client) {
        this.client.terminate();
      }
      this.client = ws;
      console.error("[chromeflow] Extension connected");

      ws.on("message", (data) => {
        let msg: ClientMessage;
        try {
          msg = JSON.parse(data.toString()) as ClientMessage;
        } catch {
          return;
        }
        if (msg.type === "ready") {
          console.error("[chromeflow] Extension ready");
          // Send identity so the extension knows which project this server belongs to
          const cwd = process.cwd();
          ws.send(JSON.stringify({
            type: "identity",
            cwd,
            label: path.basename(cwd),
            port: this.port,
          }));
          return;
        }
        const pending = this.pending.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(msg.requestId);
          if (msg.type === "error") {
            pending.reject(new Error(msg.message));
          } else {
            pending.resolve(msg);
          }
        }
      });

      ws.on("close", () => {
        console.error("[chromeflow] Extension disconnected");
        this.client = null;
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error(
            "Chrome extension disconnected. Reload the chromeflow extension in Chrome and try again."
          ));
          this.pending.delete(id);
        }
      });
    });
  }

  isConnected(): boolean {
    return this.client !== null && this.client.readyState === WebSocket.OPEN;
  }

  /** Send a message and wait for a response from the extension. */
  request(message: ServerMessagePayload, timeoutMs = REQUEST_TIMEOUT_MS): Promise<ClientMessage> {
    if (!this.isConnected()) {
      return Promise.reject(
        new Error(
          "Chromeflow extension is not connected. Open Chrome and ensure the extension is installed."
        )
      );
    }
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer });
      this.client!.send(JSON.stringify({ ...message, requestId }));
    });
  }

  /** Send a fire-and-forget message (no response expected). */
  send(message: ServerMessagePayload): void {
    if (!this.isConnected()) {
      throw new Error("Chromeflow extension is not connected.");
    }
    const requestId = crypto.randomUUID();
    this.client!.send(JSON.stringify({ ...message, requestId }));
  }
}
