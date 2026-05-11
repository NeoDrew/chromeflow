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
    // Connected to MCP server on this port
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
      // Disconnected from this port
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

// ─── Tab recording (record_window) ─────────────────────────────────────────
// MV3 service workers can't use MediaRecorder, so background forwards each
// record_window request here with the streamId from chrome.tabCapture.

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.source !== "chromeflow-background") return false;
  if (msg.type !== "start_recording") return false;
  recordTabStream(msg.streamId as string, msg.durationMs as number, msg.includeAudio === true)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message ?? err) }));
  return true;
});

async function recordTabStream(
  streamId: string,
  durationMs: number,
  includeAudio: boolean
): Promise<{ video: string; mimeType: string; durationMs: number; sizeBytes: number }> {
  const constraints = {
    video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    audio: includeAudio
      ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } }
      : false,
  } as unknown as MediaStreamConstraints;

  const stream = await navigator.mediaDevices.getUserMedia(constraints);

  // tabCapture mutes the tab's own speakers while audio is being captured.
  // Pipe the stream back to the local destination so the user still hears it.
  let audioCtx: AudioContext | null = null;
  if (includeAudio) {
    audioCtx = new AudioContext();
    audioCtx.createMediaStreamSource(stream).connect(audioCtx.destination);
  }

  const candidates = includeAudio
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  const mimeType = candidates.find((c) => MediaRecorder.isTypeSupported(c)) ?? "";
  if (!mimeType) {
    stream.getTracks().forEach((t) => t.stop());
    await audioCtx?.close();
    throw new Error("This Chrome build doesn't support any WebM codec we can use.");
  }

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });

  return new Promise<{ video: string; mimeType: string; durationMs: number; sizeBytes: number }>(
    (resolve, reject) => {
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onerror = (e) =>
        reject(new Error("MediaRecorder error: " + String((e as unknown as { error?: unknown }).error ?? "unknown")));
      recorder.onstop = async () => {
        try {
          stream.getTracks().forEach((t) => t.stop());
          await audioCtx?.close();
          const blob = new Blob(chunks, { type: mimeType });
          const buf = await blob.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          const base64 = btoa(binary);
          resolve({ video: base64, mimeType, durationMs, sizeBytes: bytes.length });
        } catch (err) {
          reject(err as Error);
        }
      };

      // If the tab closes mid-recording, the video track ends — finalise the
      // recording with whatever we already have instead of throwing.
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          if (recorder.state === "recording") recorder.stop();
        };
      }

      recorder.start();
      setTimeout(() => {
        if (recorder.state === "recording") recorder.stop();
      }, durationMs);
    }
  );
}
