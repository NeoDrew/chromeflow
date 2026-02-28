/**
 * Background service worker.
 *
 * Message flow:
 *   Offscreen (WS) → background → content script (DOM ops)
 *   Content script → background → offscreen (responses + events)
 *   Background handles tab ops directly (screenshot, navigate, navigation watch).
 */

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// Pending click-watch callbacks keyed by requestId
const pendingClicks = new Map<
  string,
  (result: { type: string; url?: string }) => void
>();

// Persisted panel state — re-injected on every new page load
let lastPanelState: { title: string; steps: Array<{ text: string; done?: boolean }> } | null = null;

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.WORKERS],
      justification: "Maintain persistent WebSocket connection to chromeflow MCP server",
    });
  }
}

chrome.runtime.onInstalled.addListener(async () => { await ensureOffscreen(); });
chrome.runtime.onStartup.addListener(async () => { await ensureOffscreen(); });

// ─── Inbound messages ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.source === "chromeflow-offscreen") {
    handleMcpMessage(msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.source === "chromeflow-content") {
    if (msg.type === "click_detected") {
      const cb = pendingClicks.get(msg.requestId);
      if (cb) {
        pendingClicks.delete(msg.requestId);
        cb({ type: "click_detected" });
      }
    }
    if (msg.type === "get_state") {
      // New content script asking for current guide panel state to re-inject it
      sendResponse({ panel: lastPanelState });
      return true;
    }
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// ─── Tab navigation listener ───────────────────────────────────────────────
// Used to resolve pending click-watches when navigation occurs instead of click.

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete") return;

  for (const [requestId, cb] of pendingClicks) {
    // Any navigation on an active tab resolves the pending click-watch
    chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
      if (activeTab?.id === tabId) {
        pendingClicks.delete(requestId);
        cb({ type: "navigation_complete", url: tab.url ?? "" });
      }
    });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab found");
  return tab;
}

function isScriptableUrl(url: string | undefined): boolean {
  if (!url) return false;
  return (
    !url.startsWith("chrome://") &&
    !url.startsWith("chrome-extension://") &&
    !url.startsWith("edge://") &&
    !url.startsWith("about:") &&
    !url.startsWith("devtools://") &&
    !url.includes("chrome.google.com/webstore")
  );
}

async function forwardToContentScript(
  tab: chrome.tabs.Tab,
  msg: object
): Promise<unknown> {
  if (!isScriptableUrl(tab.url)) {
    throw new Error(
      `Cannot inject overlays on ${tab.url} — navigate to a regular webpage first.`
    );
  }
  const tabId = tab.id!;
  try {
    return await sendToContentScript(tabId, msg);
  } catch (err) {
    if (!(err as Error).message?.includes("Receiving end does not exist")) throw err;
  }
  // Content script not yet running — inject dynamically
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await new Promise((r) => setTimeout(r, 150));
  return sendToContentScript(tabId, msg);
}

/** Resolves with the new URL when the tab finishes navigating, or null on timeout. */
function waitForNavigation(tabId: number, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(null);
    }, timeoutMs);

    const listener = (id: number, info: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tab.url ?? null);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sendToContentScript(tabId: number, msg: object): Promise<unknown> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ─── MCP message handler ───────────────────────────────────────────────────

async function handleMcpMessage(msg: {
  type: string;
  requestId: string;
  [key: string]: unknown;
}): Promise<unknown> {
  switch (msg.type) {
    case "navigate": {
      const newTab = await chrome.tabs.create({ url: msg.url as string, active: true });
      await new Promise<void>((resolve) => {
        const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
          if (id === newTab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 15000);
      });
      return { type: "action_done" };
    }

    case "screenshot": {
      const tab = await getActiveTab();
      // Use window.innerWidth/Height from the page — these are always in CSS pixels.
      // tab.width/height can return physical pixels on some HiDPI systems, which would
      // cause the downscaled image to use the wrong coordinate space.
      let cssWidth = tab.width ?? 1280;
      let cssHeight = tab.height ?? 800;
      if (isScriptableUrl(tab.url)) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            func: () => [window.innerWidth, window.innerHeight] as [number, number],
          });
          if (r[0]?.result) [cssWidth, cssHeight] = r[0].result;
        } catch { /* fall back to tab.width/height */ }
      }
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: "png" });

      // captureVisibleTab returns an image at device resolution (DPR × CSS pixels).
      // Downscale to CSS resolution so coordinate systems are always 1:1.
      const imgBlob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(imgBlob);
      const canvas = new OffscreenCanvas(cssWidth, cssHeight);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(bitmap, 0, 0, cssWidth, cssHeight);
      bitmap.close();

      // Draw a coordinate grid so Claude can read off exact pixel positions
      // instead of estimating them visually.
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

      const outBlob = await canvas.convertToBlob({ type: "image/png" });
      const buf = await outBlob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      const base64 = btoa(binary);

      return { type: "screenshot_response", image: base64, width: cssWidth, height: cssHeight };
    }

    case "start_click_watch": {
      const timeout = (msg.timeout as number) ?? 120_000;
      const tab = await getActiveTab();

      // Tell content script to start watching for a click on the highlight
      if (isScriptableUrl(tab.url)) {
        try {
          await forwardToContentScript(tab, {
            type: "start_click_watch",
            requestId: msg.requestId,
          });
        } catch {
          // Non-critical — navigation fallback still works
        }
      }

      return new Promise((resolve, reject) => {
        let done = false;

        const finish = (result: { type: string; url?: string }) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          pendingClicks.delete(msg.requestId);
          resolve(result);
        };

        const timer = setTimeout(() => {
          if (!done) {
            done = true;
            pendingClicks.delete(msg.requestId);
            reject(new Error(`wait_for_click timed out after ${timeout / 1000}s`));
          }
        }, timeout);

        pendingClicks.set(msg.requestId, finish);
      });
    }

    case "wait_for_selector": {
      const selector = msg.selector as string;
      const timeout = (msg.timeout as number) ?? 30_000;
      const tab = await getActiveTab();
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = async () => {
          if (Date.now() - start > timeout) {
            reject(new Error(`Selector "${selector}" not found after ${timeout / 1000}s`));
            return;
          }
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id! },
              func: (sel: string) => !!document.querySelector(sel),
              args: [selector],
            });
            if (results[0]?.result) {
              resolve({ type: "action_done", requestId: msg.requestId });
            } else {
              setTimeout(check, 500);
            }
          } catch {
            setTimeout(check, 500);
          }
        };
        check();
      });
    }

    case "execute_script": {
      const tab = await getActiveTab();
      if (!isScriptableUrl(tab.url)) {
        throw new Error(`Cannot execute script on ${tab.url}`);
      }
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        world: "MAIN",
        func: (code: string) => {
          try { return String((0, eval)(code)); } catch (e) { return `Error: ${e}`; }
        },
        args: [msg.code as string],
      });
      return {
        type: "script_response",
        requestId: msg.requestId,
        result: String(results[0]?.result ?? "undefined"),
      };
    }

    case "click_element": {
      const tab = await getActiveTab();
      const result = await forwardToContentScript(tab, msg) as { success: boolean; message: string };

      if (!result.success) {
        return { type: "click_element_response", success: false, message: result.message };
      }

      // Wait for the click to take effect — navigation, modal open, re-render etc.
      // Race: navigation completes within 4s, or just wait 600ms and move on.
      const navigationResult = await Promise.race([
        waitForNavigation(tab.id!, 4000),
        new Promise<null>((r) => setTimeout(() => r(null), 600)),
      ]);

      const message = navigationResult
        ? `Clicked and navigated to ${navigationResult}`
        : result.message;

      return { type: "click_element_response", success: true, message };
    }

    default: {
      // Intercept show_panel to persist its state for re-injection on new pages
      if (msg.type === "show_panel") {
        lastPanelState = {
          title: msg.title as string,
          steps: msg.steps as Array<{ text: string; done?: boolean }>,
        };
      }
      // Intercept mark_step_done to keep persisted panel in sync
      if (msg.type === "mark_step_done") {
        const idx = msg.stepIndex as number;
        if (lastPanelState?.steps[idx]) {
          lastPanelState.steps[idx].done = true;
        }
      }


      const tab = await getActiveTab();
      return forwardToContentScript(tab, msg);
    }
  }
}
