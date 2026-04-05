/**
 * Background service worker.
 *
 * Message flow:
 *   Offscreen (WS) → background → content script (DOM ops)
 *   Content script → background → offscreen (responses + events)
 *   Background handles tab ops directly (screenshot, navigate, navigation watch).
 */

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// ─── Claude window assignment ───────────────────────────────────────────────
// When set, all tab operations target this specific window so the user can
// freely use other Chrome windows without Claude hijacking them.
let claudeWindowId: number | null = null;

chrome.storage.local.get("claudeWindowId").then(({ claudeWindowId: id }) => {
  claudeWindowId = (id as number) ?? null;
});
chrome.storage.onChanged.addListener((changes) => {
  if ("claudeWindowId" in changes) {
    claudeWindowId = (changes.claudeWindowId.newValue as number) ?? null;
  }
});

// Pending click-watch callbacks keyed by requestId
const pendingClicks = new Map<
  string,
  (result: { type: string; url?: string }) => void
>();

// Recent navigation completions per tab — used to resolve click-watches that
// register AFTER the navigation already fired (race condition when the user
// clicks a link and the page loads before wait_for_click is processed).
const recentNavigations = new Map<number, { url: string; time: number }>();

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

  const url = tab.url ?? "";
  recentNavigations.set(tabId, { url, time: Date.now() });

  for (const [requestId, cb] of pendingClicks) {
    // Any navigation on the active tab in Claude's window resolves the pending click-watch
    const windowQuery = claudeWindowId ? { active: true, windowId: claudeWindowId } : { active: true, currentWindow: true };
    chrome.tabs.query(windowQuery, ([activeTab]) => {
      if (activeTab?.id === tabId) {
        pendingClicks.delete(requestId);
        cb({ type: "navigation_complete", url });
      }
    });
  }

  // Re-inject alert capture on every page load so dialogs never block
  if (isScriptableUrl(url)) {
    injectAlertCapture(tabId);
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Inject alert/confirm/prompt interceptors into the page's MAIN world so that
 * JS dialogs don't block the page. The captured message is stored in
 * window._alertCapture and read back by execute_script / click_element.
 */
async function injectAlertCapture(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        (window as any)._alertCapture = (window as any)._alertCapture ?? null;
        // Pre-set dialog responses: set via set_dialog_response tool, consumed once
        (window as any)._chromeflowDialogResponse = (window as any)._chromeflowDialogResponse ?? { prompt: undefined, confirm: undefined };
        window.alert = (msg?: unknown) => {
          (window as any)._alertCapture = String(msg ?? "");
        };
        window.confirm = (msg?: string) => {
          (window as any)._alertCapture = String(msg ?? "");
          const preset = (window as any)._chromeflowDialogResponse;
          if (preset.confirm !== undefined) {
            const val = preset.confirm;
            preset.confirm = undefined;
            return val;
          }
          return true;
        };
        window.prompt = (msg?: string, def?: string) => {
          (window as any)._alertCapture = String(msg ?? "");
          const preset = (window as any)._chromeflowDialogResponse;
          if (preset.prompt !== undefined) {
            const val = preset.prompt;
            preset.prompt = undefined;
            return val;
          }
          return def !== undefined ? def : null;
        };

        // Console capture — stores last 200 messages for get_console_logs
        if (!(window as any)._consoleLogs) {
          (window as any)._consoleLogs = [];
          const MAX = 200;
          (["log", "warn", "error", "info"] as const).forEach((level) => {
            const original = (console as any)[level];
            (console as any)[level] = function (...args: unknown[]) {
              (window as any)._consoleLogs.push({
                level,
                message: args
                  .map((a) => {
                    try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
                    catch { return String(a); }
                  })
                  .join(" "),
                time: Date.now(),
              });
              if ((window as any)._consoleLogs.length > MAX) (window as any)._consoleLogs.shift();
              original.apply(console, args);
            };
          });
        }
      },
    });
  } catch {
    // Non-scriptable pages (chrome://, etc.) will throw — ignore.
  }
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const query = claudeWindowId
    ? { active: true, windowId: claudeWindowId }
    : { active: true, currentWindow: true };
  const [tab] = await chrome.tabs.query(query);
  if (tab?.id) return tab;

  // No active tab — create a new Chrome window and assign it
  const win = await chrome.windows.create({ focused: true });
  if (win?.id) {
    claudeWindowId = win.id;
    await chrome.storage.local.set({ claudeWindowId: win.id });
  }
  const [newTab] = await chrome.tabs.query({ active: true, windowId: win?.id });
  if (!newTab?.id) throw new Error("Failed to create new Chrome window");
  return newTab;
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
      let targetTab: chrome.tabs.Tab;
      if (msg.newTab) {
        const createProps: chrome.tabs.CreateProperties = { url: msg.url as string, active: true };
        if (claudeWindowId) createProps.windowId = claudeWindowId;
        targetTab = await chrome.tabs.create(createProps);
      } else {
        // Reuse active tab
        const active = await getActiveTab();
        await chrome.tabs.update(active.id!, { url: msg.url as string });
        targetTab = { ...active, id: active.id };
      }
      await new Promise<void>((resolve) => {
        const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
          if (id === targetTab.id && info.status === "complete") {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
        setTimeout(resolve, 15000);
      });
      return { type: "action_done" };
    }

    case "switch_to_tab": {
      const query = (msg.query as string).toLowerCase();
      const allTabs = await chrome.tabs.query(claudeWindowId ? { windowId: claudeWindowId } : { currentWindow: true });
      // Match by 1-based index, URL substring, or title substring
      const byIndex = parseInt(query, 10);
      let target: chrome.tabs.Tab | undefined;
      if (!isNaN(byIndex)) {
        target = allTabs[byIndex - 1];
      } else {
        target = allTabs.find(
          (t) =>
            (t.url ?? "").toLowerCase().includes(query) ||
            (t.title ?? "").toLowerCase().includes(query)
        );
      }
      if (!target?.id) {
        const list = allTabs.map((t, i) => `${i + 1}. ${t.title} — ${t.url}`).join("\n");
        throw new Error(`No tab matching "${msg.query}". Open tabs:\n${list}`);
      }
      await chrome.tabs.update(target.id, { active: true });
      return { type: "action_done" };
    }

    case "list_tabs": {
      const allTabs = await chrome.tabs.query(claudeWindowId ? { windowId: claudeWindowId } : { currentWindow: true });
      const tabs = allTabs.map((t, i) => ({
        index: i + 1,
        title: t.title ?? "",
        url: t.url ?? "",
        active: t.active ?? false,
      }));
      return { type: "tabs_response", tabs };
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

      return { type: "screenshot_response", image: base64, width: finalWidth, height: finalHeight };
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

        // Race condition guard: if the user clicked a link and the page finished
        // loading before this handler ran, onUpdated already fired with no pending
        // clicks. Check recentNavigations and resolve immediately if so.
        const wq = claudeWindowId ? { active: true, windowId: claudeWindowId } : { active: true, currentWindow: true };
        chrome.tabs.query(wq, ([activeTab]) => {
          if (!activeTab?.id) return;
          const nav = recentNavigations.get(activeTab.id);
          if (nav && Date.now() - nav.time < 5000) {
            finish({ type: "navigation_complete", url: nav.url });
          }
        });
      });
    }

    case "wait_for_selector": {
      const selector = msg.selector as string;
      const timeout = (msg.timeout as number) ?? 30_000;
      const pollMs = (msg.refresh as number | undefined) ?? 500;
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
              setTimeout(check, pollMs);
            }
          } catch {
            setTimeout(check, pollMs);
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
          let result: unknown;
          try {
            result = (0, eval)(code);
          } catch (e) {
            // Top-level `return` statements are illegal outside a function.
            // Retry wrapped in an IIFE so they work as expected.
            if (String(e).includes("Illegal return")) {
              try {
                result = (0, eval)(`(function() { ${code} })()`);
              } catch (e2) {
                result = `Error: ${e2}`;
              }
            } else {
              result = `Error: ${e}`;
            }
          }
          const captured = (window as any)._alertCapture ?? null;
          if (captured) (window as any)._alertCapture = null;
          return JSON.stringify({ result: String(result ?? "undefined"), alert: captured });
        },
        args: [msg.code as string],
      });
      let result = "undefined";
      let alertMsg: string | null = null;
      try {
        const parsed = JSON.parse(String(results[0]?.result ?? "{}"));
        result = parsed.result ?? "undefined";
        alertMsg = parsed.alert ?? null;
      } catch {
        result = String(results[0]?.result ?? "undefined");
      }
      return {
        type: "script_response",
        requestId: msg.requestId,
        result,
        alert: alertMsg,
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

      // Check if a JS alert/confirm/prompt fired during or after the click.
      // The interceptor (injected on page load) captures these non-blockingly.
      let alertMessage: string | null = null;
      if (isScriptableUrl(tab.url)) {
        try {
          const alertResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            world: "MAIN",
            func: () => {
              const captured = (window as any)._alertCapture ?? null;
              if (captured) (window as any)._alertCapture = null;
              return captured;
            },
          });
          alertMessage = (alertResults[0]?.result as string | null) ?? null;
        } catch { /* non-scriptable or unloaded tab — ignore */ }
      }

      let message = navigationResult
        ? `Clicked and navigated to ${navigationResult}`
        : result.message;

      if (alertMessage) {
        message += `\n\nPAGE ALERT: "${alertMessage}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
      }

      return { type: "click_element_response", success: true, message };
    }

    case "set_file_input": {
      const tab = await getActiveTab();

      // Ask content script to find and tag the file input
      const tagResult = await forwardToContentScript(tab, {
        type: "tag_file_input",
        requestId: msg.requestId,
        hint: msg.hint,
      }) as { found: boolean; message?: string };

      if (!tagResult.found) {
        return { type: "action_done", requestId: msg.requestId, success: false, message: tagResult.message ?? "No file input found" };
      }

      const tabId = tab.id!;

      // Use Chrome DevTools Protocol to set the file — the only way to bypass
      // the browser's script restriction on file inputs.
      await (chrome.debugger as any).attach({ tabId }, "1.3");
      try {
        // Use Runtime.evaluate to get a live reference — more reliable than DOM.querySelector
        // because it survives React re-renders that may have discarded the tagged element.
        const evalResult = await (chrome.debugger as any).sendCommand({ tabId }, "Runtime.evaluate", {
          expression: `document.querySelector('[data-chromeflow-file-target="true"]')`,
          returnByValue: false,
        }) as { result: { objectId?: string } };

        if (!evalResult.result?.objectId) throw new Error("Could not locate tagged file input via CDP");

        // Pass objectId directly — DOM.setFileInputFiles accepts objectId, nodeId, or
        // backendNodeId. Using objectId avoids the need to call DOM.getDocument first
        // (which was causing "Could not resolve file input node" failures on DataAnnotation
        // and PingLine forms where the DOM domain wasn't initialized).
        await (chrome.debugger as any).sendCommand({ tabId }, "DOM.setFileInputFiles", {
          objectId: evalResult.result.objectId,
          files: [msg.filePath],
        });

        // Dispatch change/input events so React and other frameworks pick up the new file.
        // CDP's setFileInputFiles fires a native change event, but React sometimes misses it
        // due to its synthetic event system. Dispatching explicitly ensures the handler fires.
        await (chrome.debugger as any).sendCommand({ tabId }, "Runtime.evaluate", {
          expression: `(function() {
            var el = document.querySelector('[data-chromeflow-file-target="true"]');
            if (el) {
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          })()`,
          returnByValue: true,
        });
      } finally {
        await (chrome.debugger as any).detach({ tabId }).catch(() => {});
        // Clean up the tag regardless of success/failure
        await forwardToContentScript(tab, {
          type: "untag_file_input",
          requestId: msg.requestId,
        }).catch(() => {});
      }

      const filename = (msg.filePath as string).split("/").pop();
      return { type: "action_done", requestId: msg.requestId, success: true, message: `File "${filename}" set on input` };
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
