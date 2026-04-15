/**
 * Background service worker.
 *
 * Message flow:
 *   Offscreen (WS) → background → content script (DOM ops)
 *   Content script → background → offscreen (responses + events)
 *   Background handles tab ops directly (screenshot, navigate, navigation watch).
 */

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// ─── Per-instance Claude window assignments ────────────────────────────────
// Each Claude Code instance is identified by the WebSocket port it connects on
// (7878-7888). Each instance can be assigned its own Chrome window so multiple
// CC instances can run automations in parallel without colliding.
let claudeInstances: Record<string, number> = {};

chrome.storage.local.get(["claudeInstances", "claudeWindowId"]).then(async ({ claudeInstances: stored, claudeWindowId: legacy }) => {
  claudeInstances = (stored as Record<string, number>) ?? {};
  // Migrate legacy single-window storage → port 7878 instance
  if (typeof legacy === "number" && claudeInstances["7878"] === undefined) {
    claudeInstances["7878"] = legacy;
    await chrome.storage.local.set({ claudeInstances });
    await chrome.storage.local.remove("claudeWindowId");
  }
});
chrome.storage.onChanged.addListener((changes) => {
  if ("claudeInstances" in changes) {
    claudeInstances = (changes.claudeInstances.newValue as Record<string, number>) ?? {};
  }
});

function getWindowId(port: number): number | null {
  return claudeInstances[String(port)] ?? null;
}

async function setWindowId(port: number, windowId: number): Promise<void> {
  claudeInstances[String(port)] = windowId;
  await chrome.storage.local.set({ claudeInstances });
}

// Pending click-watch callbacks keyed by requestId. Each entry tracks the
// source port so we know which Claude window's tabs to watch.
const pendingClicks = new Map<
  string,
  { port: number; cb: (result: { type: string; url?: string }) => void }
>();

// Recent navigation completions per tab — used to resolve click-watches that
// register AFTER the navigation already fired (race condition when the user
// clicks a link and the page loads before wait_for_click is processed).
const recentNavigations = new Map<number, { url: string; time: number }>();

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

// Ensure the per-install DOM marker prefix is generated before any content
// script runs. Tag/ID names use this prefix so chromeflow doesn't leave a
// consistent "chromeflow" fingerprint on every page it touches. Generated
// once per install, persisted in chrome.storage.local.
async function ensureMarkerPrefix() {
  try {
    const { cfMarkerPrefix } = await chrome.storage.local.get("cfMarkerPrefix");
    if (typeof cfMarkerPrefix === "string" && cfMarkerPrefix.length >= 3) return;
    const chars = "abcdefghijkmnpqrstuvwxyz23456789";
    let p = "";
    for (let i = 0; i < 6; i++) p += chars[Math.floor(Math.random() * chars.length)];
    await chrome.storage.local.set({ cfMarkerPrefix: p });
  } catch { /* non-fatal */ }
}
chrome.runtime.onInstalled.addListener(ensureMarkerPrefix);
chrome.runtime.onStartup.addListener(ensureMarkerPrefix);
// Also kick once on service-worker boot, in case neither event fires soon.
ensureMarkerPrefix();

chrome.runtime.onInstalled.addListener(async () => { await ensureOffscreen(); });
chrome.runtime.onStartup.addListener(async () => { await ensureOffscreen(); });

// ─── Inbound messages ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.source === "chromeflow-offscreen") {
    // Status broadcasts carry the list of currently-connected WS ports.
    // Persist to chrome.storage.local so the popup can render them.
    if (msg.type === "status") {
      const livePorts = (msg.livePorts as Array<{ port: number; label?: string }>) ?? [];
      chrome.storage.local.set({ chromeflowLivePorts: livePorts }).catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
    const port: number = typeof msg.port === "number" ? msg.port : 7878;
    handleMcpMessage(msg.payload, port)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }

  if (msg.source === "chromeflow-content") {
    if (msg.type === "click_detected") {
      const entry = pendingClicks.get(msg.requestId);
      if (entry) {
        pendingClicks.delete(msg.requestId);
        entry.cb({ type: "click_detected" });
      }
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

  for (const [requestId, entry] of pendingClicks) {
    // Resolve the pending click-watch only for navigations in the watching
    // instance's assigned Chrome window.
    const wid = getWindowId(entry.port);
    const windowQuery = wid ? { active: true, windowId: wid } : { active: true, currentWindow: true };
    chrome.tabs.query(windowQuery, ([activeTab]) => {
      if (activeTab?.id === tabId) {
        pendingClicks.delete(requestId);
        entry.cb({ type: "navigation_complete", url });
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

// ─── Debugger mutex ────────────────────────────────────────────────────────
// Chrome allows only one debugger client per tab. If execute_script (CSP
// bypass path), type_text, and set_file_input all want to attach to the same
// tab, concurrent calls would race and the second attach fails with
// "Another debugger is already attached." This serializes all debugger
// operations per tab — each call waits for the previous one to detach.
const tabDebuggerLocks = new Map<number, Promise<void>>();

async function withDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tabDebuggerLocks.get(tabId);
  if (prev) await prev.catch(() => {});

  let release!: () => void;
  const lock = new Promise<void>((r) => { release = r; });
  tabDebuggerLocks.set(tabId, lock);

  try {
    // Retry attach up to 3 times with 500ms backoff — another chromeflow
    // instance (or DevTools) may briefly hold the debugger and release it.
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await (chrome.debugger as any).attach({ tabId }, "1.3");
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
        const msg = String(lastErr.message ?? err);
        if (msg.includes("Another debugger is already attached") && attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        if (msg.includes("Another debugger is already attached")) {
          throw new Error(
            "Another debugger is already attached to this tab after 3 retries. Close Chrome DevTools (Cmd+Opt+I) or ensure the other chromeflow instance is using a separate Chrome window."
          );
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;

    try {
      return await fn();
    } finally {
      await (chrome.debugger as any).detach({ tabId }).catch(() => {});
    }
  } finally {
    release();
    if (tabDebuggerLocks.get(tabId) === lock) tabDebuggerLocks.delete(tabId);
  }
}

async function getActiveTab(port: number): Promise<chrome.tabs.Tab> {
  const wid = getWindowId(port);
  const query = wid
    ? { active: true, windowId: wid }
    : { active: true, currentWindow: true };
  const [tab] = await chrome.tabs.query(query);
  if (tab?.id) return tab;

  // No active tab — create a new Chrome window and assign it to this instance
  const win = await chrome.windows.create({ focused: true });
  if (win?.id) {
    await setWindowId(port, win.id);
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
}, port: number): Promise<unknown> {
  switch (msg.type) {
    case "navigate": {
      let targetTab: chrome.tabs.Tab;
      const targetUrl = msg.url as string;
      if (msg.newTab) {
        const createProps: chrome.tabs.CreateProperties = { url: targetUrl, active: true };
        const wid = getWindowId(port);
        if (wid) createProps.windowId = wid;
        targetTab = await chrome.tabs.create(createProps);
      } else {
        // Reuse active tab. When the current page is already on the same origin,
        // navigate via in-page location.href so sec-fetch-site is "same-origin"
        // instead of "cross-site" — some sites (e.g. Outlier) serve a mobile /
        // blocked SSR response when hit with cross-site direct navigation.
        const active = await getActiveTab(port);
        const sameOrigin = (() => {
          try {
            return active.url && new URL(active.url).origin === new URL(targetUrl).origin;
          } catch { return false; }
        })();
        if (sameOrigin && active.id) {
          try {
            await chrome.scripting.executeScript({
              target: { tabId: active.id },
              world: "MAIN",
              func: (url: string) => { window.location.href = url; },
              args: [targetUrl],
            });
          } catch {
            // Fall back to tabs.update if scripting injection fails (e.g. on chrome:// pages)
            await chrome.tabs.update(active.id, { url: targetUrl });
          }
        } else {
          await chrome.tabs.update(active.id!, { url: targetUrl });
        }
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
      const wid = getWindowId(port);
      const allTabs = await chrome.tabs.query(wid ? { windowId: wid } : { currentWindow: true });
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
      const wid = getWindowId(port);
      const allTabs = await chrome.tabs.query(wid ? { windowId: wid } : { currentWindow: true });
      const tabs = allTabs.map((t, i) => ({
        index: i + 1,
        title: t.title ?? "",
        url: t.url ?? "",
        active: t.active ?? false,
      }));
      return { type: "tabs_response", tabs };
    }

    case "screenshot": {
      const tab = await getActiveTab(port);
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
      const tab = await getActiveTab(port);

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

        pendingClicks.set(msg.requestId, { port, cb: finish });

        // Race condition guard: if the user clicked a link and the page finished
        // loading before this handler ran, onUpdated already fired with no pending
        // clicks. Check recentNavigations and resolve immediately if so.
        const widWatch = getWindowId(port);
        const wq = widWatch ? { active: true, windowId: widWatch } : { active: true, currentWindow: true };
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
      const tab = await getActiveTab(port);
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
      const tab = await getActiveTab(port);
      if (!isScriptableUrl(tab.url)) {
        throw new Error(`Cannot execute script on ${tab.url}`);
      }
      const code = msg.code as string;
      const tabId = tab.id!;

      // Try normal content-script injection first
      let result = "undefined";
      let alertMsg: string | null = null;
      let cspBlocked = false;

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (code: string) => {
            let result: unknown;
            try {
              result = (0, eval)(code);
            } catch (e) {
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
          args: [code],
        });
        try {
          const parsed = JSON.parse(String(results[0]?.result ?? "{}"));
          result = parsed.result ?? "undefined";
          alertMsg = parsed.alert ?? null;
        } catch {
          result = String(results[0]?.result ?? "undefined");
        }
        // Check if the result indicates CSP blocked eval
        if (result.includes("EvalError") || result.includes("Content Security Policy") || result.includes("unsafe-eval")) {
          cspBlocked = true;
        }
      } catch (e) {
        const errStr = String(e);
        if (errStr.includes("EvalError") || errStr.includes("Content Security Policy") || errStr.includes("unsafe-eval")) {
          cspBlocked = true;
        } else {
          throw e;
        }
      }

      // CSP blocked eval — fall back to CDP Runtime.evaluate which bypasses CSP
      if (cspBlocked) {
        await withDebugger(tabId, async () => {
          const wrappedCode = `(function() {
            var __result;
            try { __result = (0, eval)(${JSON.stringify(code)}); }
            catch(e) {
              if (String(e).includes("Illegal return")) {
                try { __result = (0, eval)("(function() { " + ${JSON.stringify(code)} + " })()"); }
                catch(e2) { __result = "Error: " + e2; }
              } else { __result = "Error: " + e; }
            }
            var __alert = window._alertCapture || null;
            if (__alert) window._alertCapture = null;
            return JSON.stringify({ result: String(__result ?? "undefined"), alert: __alert });
          })()`;
          const evalResult = await (chrome.debugger as any).sendCommand({ tabId }, "Runtime.evaluate", {
            expression: wrappedCode,
            returnByValue: true,
            allowUnsafeEvalBlockedByCSP: true,
          }) as { result: { value?: string }; exceptionDetails?: unknown };
          try {
            const parsed = JSON.parse(evalResult.result.value ?? "{}");
            result = parsed.result ?? "undefined";
            alertMsg = parsed.alert ?? null;
          } catch {
            result = String(evalResult.result.value ?? "undefined");
          }
        });
      }

      return {
        type: "script_response",
        requestId: msg.requestId,
        result,
        alert: alertMsg,
      };
    }

    case "click_element": {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;

      // Phase 1: ask content script to find, scroll, and tag the element,
      // returning its viewport coordinates (with small jitter).
      const prep = await forwardToContentScript(tab, {
        type: "prepare_click_target",
        requestId: msg.requestId,
        textHint: msg.textHint,
        nth: msg.nth,
      }) as { success: boolean; message: string; x?: number; y?: number; width?: number; height?: number; label?: string };

      if (!prep.success) {
        return { type: "click_element_response", success: false, message: prep.message };
      }

      // Phase 2: dispatch the click via CDP (isTrusted=true events) if possible.
      // On sites with strict isTrusted checks (Outlier-tier), synthetic clicks
      // are ignored but CDP-dispatched events pass. Falls back to the content
      // script's synthetic-click path on chrome:// pages or debugger failure.
      let result: { success: boolean; message: string };
      let usedCdp = false;

      const canCdp = isScriptableUrl(tab.url) && typeof prep.x === "number" && typeof prep.y === "number";
      if (canCdp) {
        try {
          await withDebugger(tabId, async () => {
            const dbg = chrome.debugger as unknown as {
              sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
            };
            const cx = Math.round(prep.x!);
            const cy = Math.round(prep.y!);
            // Approach: a short move from a nearby offset toward the target,
            // then press/release. Humanlike, and produces isTrusted=true events.
            const ax = cx + Math.round((Math.random() - 0.5) * 40);
            const ay = cy + Math.round((Math.random() - 0.5) * 40);
            await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
              type: "mouseMoved", x: ax, y: ay, button: "none", clickCount: 0,
            });
            await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));
            await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
              type: "mouseMoved", x: cx, y: cy, button: "none", clickCount: 0,
            });
            await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
            await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
              type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1,
            });
            await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
            await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
              type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1,
            });
          });
          usedCdp = true;
        } catch {
          // CDP path failed — fall through to synthetic click.
        }
      }

      // Phase 3: inspect post-click state (radio/checkbox check state, 0×0 warnings)
      // and untag. Best-effort — skip if the click caused navigation.
      let postNote = "";
      try {
        const post = await forwardToContentScript(tab, {
          type: "post_click_inspect",
          requestId: msg.requestId + "-post",
        }) as { message?: string };
        postNote = post.message ?? "";
      } catch { /* page may have navigated away */ }

      if (usedCdp) {
        result = { success: true, message: `Clicked "${prep.label ?? msg.textHint}"${postNote}` };
      } else {
        // Fallback: content-script synthetic click (isTrusted=false).
        result = await forwardToContentScript(tab, msg) as { success: boolean; message: string };
        if (!result.success) {
          return { type: "click_element_response", success: false, message: result.message };
        }
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

    case "type_text": {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      const text = msg.text as string;

      // Type character-by-character with individual keyDown/keyUp events
      // and randomized delays to produce input indistinguishable from real typing.
      await withDebugger(tabId, async () => {
        for (let i = 0; i < text.length; i++) {
          const char = text[i];

          if (char === "\n") {
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
          } else if (char === "\t") {
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
            });
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
            });
          } else {
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyDown", key: char, text: char, unmodifiedText: char,
            });
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyUp", key: char,
            });
          }

          const baseDelay = 30 + Math.random() * 60;
          const pause = Math.random() < 0.05 ? 200 + Math.random() * 300 : baseDelay;
          await new Promise((r) => setTimeout(r, pause));
        }

        // After typing, dispatch an input event on the focused element to nudge
        // React's internal state reconciliation. Without this, React-controlled
        // textareas (especially inside shadow DOM) can show the text visually but
        // report the field as empty in form validation.
        await (chrome.debugger as any).sendCommand({ tabId }, "Runtime.evaluate", {
          expression: `(function() {
            var el = document.activeElement;
            if (el && el.shadowRoot) el = el.shadowRoot.activeElement || el;
            if (el) {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()`,
          returnByValue: true,
        });
      });

      return {
        type: "action_done",
        requestId: msg.requestId,
        success: true,
        message: `Typed ${text.length} characters via individual keystrokes`,
      };
    }

    case "set_file_input": {
      const tab = await getActiveTab(port);

      // Ask content script to find and tag the file input
      const tagResult = await forwardToContentScript(tab, {
        type: "tag_file_input",
        requestId: msg.requestId,
        hint: msg.hint,
      }) as { found: boolean; message?: string; attr?: string };

      if (!tagResult.found) {
        return { type: "action_done", requestId: msg.requestId, success: false, message: tagResult.message ?? "No file input found" };
      }

      const tabId = tab.id!;
      const fileAttr = tagResult.attr ?? "data-cf-file";

      // Use Chrome DevTools Protocol to set the file — the only way to bypass
      // the browser's script restriction on file inputs.
      try {
        await withDebugger(tabId, async () => {
          const evalResult = await (chrome.debugger as any).sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `document.querySelector('[${fileAttr}="true"]')`,
            returnByValue: false,
          }) as { result: { objectId?: string } };

          if (!evalResult.result?.objectId) throw new Error("Could not locate tagged file input via CDP");

          await (chrome.debugger as any).sendCommand({ tabId }, "DOM.setFileInputFiles", {
            objectId: evalResult.result.objectId,
            files: [msg.filePath],
          });

          await (chrome.debugger as any).sendCommand({ tabId }, "Runtime.evaluate", {
            expression: `(function() {
              var el = document.querySelector('[${fileAttr}="true"]');
              if (el) {
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new Event('input', { bubbles: true }));
              }
            })()`,
            returnByValue: true,
          });
        });
      } finally {
        // Clean up the tag regardless of success/failure
        await forwardToContentScript(tab, {
          type: "untag_file_input",
          requestId: msg.requestId,
        }).catch(() => {});
      }

      const filename = (msg.filePath as string).split("/").pop();
      return { type: "action_done", requestId: msg.requestId, success: true, message: `File "${filename}" set on input` };
    }

    case "inspect_request_headers": {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      const targetUrl = msg.url as string;

      const captured = await withDebugger(tabId, async () => {
        const dbg = chrome.debugger as unknown as {
          sendCommand: (target: { tabId: number }, method: string, params?: object) => Promise<unknown>;
        };

        await dbg.sendCommand({ tabId }, "Network.enable", {});

        // Buffer extraInfo events by requestId — per CDP spec they can arrive
        // before or after Network.requestWillBeSent.
        const extraInfoByReqId = new Map<string, Record<string, string>>();
        let pendingRequestId: string | null = null;
        let pendingMeta: { url: string; method: string } | null = null;

        const captureProm = new Promise<{ url: string; method: string; headers: Record<string, string> }>((resolve, reject) => {
          const finish = () => {
            if (!pendingRequestId || !pendingMeta) return;
            const headers = extraInfoByReqId.get(pendingRequestId);
            if (!headers) return;
            clearTimeout(timeout);
            chrome.debugger.onEvent.removeListener(listener);
            resolve({ ...pendingMeta, headers });
          };

          const listener = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
            if (source.tabId !== tabId) return;
            const p = (params ?? {}) as Record<string, unknown>;

            if (method === "Network.requestWillBeSent") {
              const req = p.request as { url: string; method: string } | undefined;
              if (!req) return;
              const type = p.type as string | undefined;
              // Match the main document request to targetUrl. Prefer type==="Document";
              // fall back to first URL-match if type is missing (edge cases).
              if ((req.url === targetUrl || req.url.startsWith(targetUrl)) && !pendingRequestId) {
                if (type === "Document" || !type) {
                  pendingRequestId = p.requestId as string;
                  pendingMeta = { url: req.url, method: req.method };
                  finish();
                }
              }
            }

            if (method === "Network.requestWillBeSentExtraInfo") {
              const reqId = p.requestId as string;
              const headers = p.headers as Record<string, string>;
              extraInfoByReqId.set(reqId, headers);
              finish();
            }
          };

          const timeout = setTimeout(() => {
            chrome.debugger.onEvent.removeListener(listener);
            if (pendingMeta && pendingRequestId) {
              // We saw the request but never got extra-info; return whatever we have.
              resolve({ ...pendingMeta, headers: extraInfoByReqId.get(pendingRequestId) ?? {} });
            } else {
              reject(new Error(`Timed out waiting for request to ${targetUrl}`));
            }
          }, 15000);

          chrome.debugger.onEvent.addListener(listener);
        });

        // Trigger navigation via CDP — works even when already on targetUrl,
        // unlike chrome.tabs.update which may silently no-op.
        await dbg.sendCommand({ tabId }, "Page.navigate", { url: targetUrl });

        return await captureProm;
      });

      const lines = [`${captured.method} ${captured.url}`, ""];
      const sortedKeys = Object.keys(captured.headers).sort();
      for (const k of sortedKeys) {
        lines.push(`${k}: ${captured.headers[k]}`);
      }
      if (sortedKeys.length === 0) {
        lines.push("(no headers captured — extra-info event never fired; try again)");
      }
      return { type: "action_done", requestId: msg.requestId, message: lines.join("\n") };
    }

    default: {
      const tab = await getActiveTab(port);
      return forwardToContentScript(tab, msg);
    }
  }
}
