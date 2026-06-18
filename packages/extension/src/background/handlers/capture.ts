// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, forwardToContentScript } from "../state";
import { isScriptableUrl } from "../policy";

export async function handleScreenshot(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      // Use window.innerWidth/Height from the page — these are always in CSS pixels.
      // tab.width/height can return physical pixels on some HiDPI systems, which would
      // cause the downscaled image to use the wrong coordinate space.
      let cssWidth = tab.width ?? 1280;
      let cssHeight = tab.height ?? 800;
      let inFullscreen = false;
      if (isScriptableUrl(tab.url)) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            func: () => ({
              w: window.innerWidth,
              h: window.innerHeight,
              fs: !!(document.fullscreenElement || (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement),
            }),
          });
          const probe = r[0]?.result as { w: number; h: number; fs: boolean } | undefined;
          if (probe) {
            cssWidth = probe.w;
            cssHeight = probe.h;
            inFullscreen = probe.fs;
          }
        } catch { /* fall back to tab.width/height */ }
      }

      // Fullscreen on the page (typically a video player or an iframe that
      // requested fullscreen) breaks chrome.tabs.captureVisibleTab — the
      // request hangs and the 30s WS timeout fires before any image lands.
      // Fail fast with the recovery hint so the caller doesn't burn the
      // whole budget on retries that can't succeed.
      if (inFullscreen && msg.allow_fullscreen !== true) {
        throw new Error(
          `take_screenshot refused: page is in fullscreen mode (captureVisibleTab hangs there). ` +
          `Exit fullscreen first via execute_script("document.exitFullscreen()") or by highlighting + wait_for_click on an exit-fullscreen control. ` +
          `If you really need the screenshot in fullscreen, retry with allow_fullscreen: true (it usually times out).`
        );
      }

      // captureVisibleTab + bitmap readback both flake intermittently on
      // heavy SPAs (the user reports "Request timed out" and "image readback
      // failed" mid-session, sometimes recovering after minutes). Retry with
      // exponential backoff before giving up; on terminal failure, attempt a
      // CDP Page.captureScreenshot fallback if the debugger is already
      // attached (no extra attach permission prompt).
      //
      // Per-attempt timeout dropped from 10s to 5s and backoff tightened from
      // [0,500,1500] to [0,400,1000]ms so the total worst case is ~17s — well
      // under the 30s WS cap, leaves margin for unexpected slowness.
      async function captureOnce(): Promise<{ dataUrl: string; via: "visibleTab" | "cdp" }> {
        return new Promise(async (resolve, reject) => {
          const wsTimer = setTimeout(() => reject(new Error("captureVisibleTab timed out after 5000ms")), 5_000);
          try {
            const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "png" });
            clearTimeout(wsTimer);
            if (!dataUrl) {
              reject(new Error("captureVisibleTab returned empty data URL"));
              return;
            }
            resolve({ dataUrl, via: "visibleTab" });
          } catch (err) {
            clearTimeout(wsTimer);
            reject(err);
          }
        });
      }

      async function captureViaCdp(): Promise<{ dataUrl: string; via: "cdp" } | null> {
        try {
          const targets = await new Promise<chrome.debugger.TargetInfo[]>((resolve) =>
            chrome.debugger.getTargets((t) => resolve(t))
          );
          const attached = targets.some((t) => t.tabId === tab.id && t.attached);
          if (!attached) return null;
          const dbg = chrome.debugger as unknown as {
            sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
          };
          const result = await dbg.sendCommand({ tabId: tab.id! }, "Page.captureScreenshot", { format: "png" });
          const data = (result as { data?: string }).data;
          if (!data) return null;
          return { dataUrl: `data:image/png;base64,${data}`, via: "cdp" };
        } catch {
          return null;
        }
      }

      // Hide the instance info box so it doesn't appear in the captured image.
      // Best-effort; re-shown in the finally block below.
      if (isScriptableUrl(tab.url) && tab.id) {
        try {
          await forwardToContentScript(tab, { type: "set_instance_info_visible", requestId: msg.requestId + "-hide", visible: false });
        } catch { /* ignore */ }
      }

      let capture: { dataUrl: string; via: "visibleTab" | "cdp" } | null = null;
      let lastErr: Error | null = null;
      const backoffMs = [0, 400, 1000];
      for (const wait of backoffMs) {
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        try {
          capture = await captureOnce();
          break;
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
        }
      }

      if (!capture) {
        // Final attempt: CDP fallback. Only succeeds when the debugger is
        // already attached (chromeflow's CDP click path attaches it on
        // demand); a cold-start without prior CDP usage will return null and
        // fall through to the error message.
        capture = await captureViaCdp();
      }

      if (!capture) {
        const reason = lastErr ? lastErr.message : "unknown capture error";
        throw new Error(`take_screenshot failed: ${reason}. Tried captureVisibleTab 3× with backoff and CDP fallback. This is usually transient on heavy SPAs — retry after a few seconds, or use get_page_text to read content via DOM instead.`);
      }

      let imgBlob: Blob;
      let bitmap: ImageBitmap;
      try {
        imgBlob = await (await fetch(capture.dataUrl)).blob();
        bitmap = await createImageBitmap(imgBlob);
      } catch (e) {
        throw new Error(`take_screenshot bitmap readback failed: ${e instanceof Error ? e.message : String(e)}. The capture data was returned but couldn't be decoded — retry after a few seconds.`);
      }

      const canvas = new OffscreenCanvas(cssWidth, cssHeight);
      const ctx = canvas.getContext("2d")!;
      try {
        ctx.drawImage(bitmap, 0, 0, cssWidth, cssHeight);
      } catch (e) {
        bitmap.close();
        throw new Error(`take_screenshot drawImage failed: ${e instanceof Error ? e.message : String(e)}. The bitmap decoded but canvas drawing failed — retry after a few seconds.`);
      }
      bitmap.close();

      // Draw a coordinate grid so Claude can read off exact pixel positions
      // instead of estimating them visually. Skip when `grid: false` (e.g.
      // take_screenshot called with copy_to_clipboard or save_to — the image
      // is for external sharing and the grid would be visual noise).
      const drawGrid = msg.grid !== false;
      if (drawGrid) {
        const GRID = 100;
        ctx.strokeStyle = "rgba(255,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.font = "bold 10px monospace";
        for (let x = GRID; x < cssWidth; x += GRID) {
          ctx.strokeStyle = "rgba(255,0,0,0.35)";
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cssHeight); ctx.stroke();
          ctx.fillStyle = "rgba(255,0,0,0.85)";
          ctx.fillText(String(x), x + 2, 11);
        }
        for (let y = GRID; y < cssHeight; y += GRID) {
          ctx.strokeStyle = "rgba(255,0,0,0.35)";
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cssWidth, y); ctx.stroke();
          ctx.fillStyle = "rgba(255,0,0,0.85)";
          ctx.fillText(String(y), 2, y - 2);
        }
      }

      // Encode to PNG, enforcing Claude Code's 3.75MB base64 limit.
      // If the image is too large, re-render at reduced resolution.
      const MAX_BASE64_BYTES = 3_500_000; // 3.5MB with margin
      let scale = 1;
      let base64 = "";
      let finalWidth = cssWidth;
      let finalHeight = cssHeight;

      for (const s of [1, 0.75, 0.5]) {
        scale = s;
        finalWidth = Math.round(cssWidth * s);
        finalHeight = Math.round(cssHeight * s);
        let outCanvas: OffscreenCanvas;
        if (s === 1) {
          outCanvas = canvas;
        } else {
          outCanvas = new OffscreenCanvas(finalWidth, finalHeight);
          const sCtx = outCanvas.getContext("2d")!;
          sCtx.drawImage(canvas, 0, 0, finalWidth, finalHeight);
        }
        const outBlob = await outCanvas.convertToBlob({ type: "image/png" });
        const buf = await outBlob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        base64 = btoa(binary);
        if (base64.length <= MAX_BASE64_BYTES) break;
      }

      // Viewport / page / scroll snapshot so the agent can compute coordinates
      // for click_at_coordinates without a separate execute_script probe.
      let viewport: { width: number; height: number } | undefined;
      let page: { width: number; height: number } | undefined;
      let scroll: { x: number; y: number } | undefined;
      if (isScriptableUrl(tab.url)) {
        try {
          const m = await chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            func: () => ({
              vw: window.innerWidth,
              vh: window.innerHeight,
              pw: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
              ph: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
              sx: window.scrollX,
              sy: window.scrollY,
            }),
          });
          const r = m[0]?.result as { vw: number; vh: number; pw: number; ph: number; sx: number; sy: number } | undefined;
          if (r) {
            viewport = { width: r.vw, height: r.vh };
            page = { width: r.pw, height: r.ph };
            scroll = { x: r.sx, y: r.sy };
          }
        } catch { /* best-effort */ }
      }

      // Re-show the instance info box after capture.
      if (isScriptableUrl(tab.url) && tab.id) {
        try {
          await forwardToContentScript(tab, { type: "set_instance_info_visible", requestId: msg.requestId + "-show", visible: true });
        } catch { /* ignore */ }
      }

      return {
        type: "screenshot_response",
        image: base64,
        width: finalWidth,
        height: finalHeight,
        viewport,
        page,
        scroll,
      };
}
