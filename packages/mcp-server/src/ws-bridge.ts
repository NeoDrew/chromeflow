import { execSync } from "child_process";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, DistributiveOmit, ServerMessage } from "./types.js";

type ServerMessagePayload = DistributiveOmit<ServerMessage, "requestId">;

const WS_PORT = 7878;
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

  constructor() {
    this.bind();
  }

  private bind() {
    const wss = new WebSocketServer({ port: WS_PORT });

    wss.on("error", (err: Error & { code?: string }) => {
      if (err.code === "EADDRINUSE") {
        console.error(
          `[chromeflow] Port ${WS_PORT} in use — killing stale process and retrying...`
        );
        try {
          execSync(`lsof -ti:${WS_PORT} | xargs kill -9`, { stdio: "ignore" });
        } catch {
          // Nothing holding the port, or kill failed — wait and retry anyway
        }
        setTimeout(() => this.bind(), 800);
      } else {
        console.error("[chromeflow] WS server error:", err);
      }
    });

    wss.on("listening", () => {
      this.wss = wss;
      console.error(`[chromeflow] WS bridge listening on ws://localhost:${WS_PORT}`);
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
          pending.reject(new Error("Extension disconnected"));
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
