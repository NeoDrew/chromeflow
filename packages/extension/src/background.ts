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
    // instance's assigned Chrome window. Skip unassigned ports entirely —
    // we must never treat the user's currently-focused window as ours.
    const wid = getWindowId(entry.port);
    if (!wid) continue;
    chrome.tabs.query({ active: true, windowId: wid }, ([activeTab]) => {
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
  let wid = getWindowId(port);

  // If we have an assignment, validate the window still exists. If the user
  // closed it since assignment, fall through to creating a fresh one.
  if (wid) {
    const [tab] = await chrome.tabs.query({ active: true, windowId: wid });
    if (tab?.id) return tab;
    // Stale assignment — window was closed. Drop it and re-assign below.
    wid = null;
    try {
      const { claudeInstances } = await chrome.storage.local.get("claudeInstances");
      const instances = (claudeInstances as Record<string, number>) ?? {};
      if (instances[String(port)] !== undefined) {
        delete instances[String(port)];
        await chrome.storage.local.set({ claudeInstances: instances });
      }
    } catch { /* best-effort cleanup */ }
  }

  // UNASSIGNED path: do NOT touch the user's currently-focused window.
  // Creating a brand-new window means chromeflow only ever operates on
  // tabs it opened itself. Overwriting a user's existing tab (e.g. an
  // open report, a live chat) would be destructive — they could lose work.
  const win = await chrome.windows.create({ focused: true, url: "about:blank" });
  if (!win?.id) throw new Error("Failed to create a new Chrome window for this Claude Code instance.");
  await setWindowId(port, win.id);

  // Poll briefly for the new window's active tab to be ready.
  for (let i = 0; i < 20; i++) {
    const [newTab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (newTab?.id) return newTab;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Created new Chrome window but its active tab never appeared.");
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
      const background = msg.background === true;
      if (msg.newTab) {
        // Ensure an assignment exists BEFORE creating the tab — otherwise
        // chrome.tabs.create with no windowId drops the tab into whatever
        // window Chrome considers "current" (the user's active window).
        await getActiveTab(port);
        const wid = getWindowId(port)!;
        // background:true creates the tab without focus-switching, so a
        // partially-filled form on the current tab keeps focus and doesn't
        // trigger the page's blur/auto-save behavior.
        targetTab = await chrome.tabs.create({ url: targetUrl, active: !background, windowId: wid });
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
      // Ensure this instance has an assigned window before listing/switching tabs,
      // so we never accidentally operate on the user's currently-focused window.
      await getActiveTab(port);
      const wid = getWindowId(port)!;
      const allTabs = await chrome.tabs.query({ windowId: wid });
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
      // Ensure this instance has an assigned window before listing tabs,
      // so the list only shows tabs chromeflow owns (not the user's own window).
      await getActiveTab(port);
      const wid = getWindowId(port)!;
      const allTabs = await chrome.tabs.query({ windowId: wid });
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
      // instead of estimating them visually. Skip when `grid: false` (e.g.
      // take_and_copy_screenshot, which produces screenshots the user shares
      // externally — the grid would be visual noise).
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
        // Skip entirely for unassigned ports — we must not treat the user's
        // currently-focused window as ours.
        const widWatch = getWindowId(port);
        if (!widWatch) return;
        chrome.tabs.query({ active: true, windowId: widWatch }, ([activeTab]) => {
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
      const requireShadow = (msg.shadow_root as boolean | undefined) ?? false;
      const tab = await getActiveTab(port);
      return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = async () => {
          if (Date.now() - start > timeout) {
            const reason = requireShadow
              ? `Selector "${selector}" never grew an attached shadowRoot within ${timeout / 1000}s`
              : `Selector "${selector}" not found after ${timeout / 1000}s`;
            reject(new Error(reason));
            return;
          }
          try {
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id! },
              func: (sel: string, requireShadow: boolean) => {
                // Shadow-piercing query: walks open shadow roots so selectors
                // for elements inside web components (Outlier, Lit, Stencil)
                // are found without needing a shadow-DOM-aware caller.
                function findFirst(root: Document | Element | ShadowRoot): Element | null {
                  const direct = root.querySelector(sel);
                  if (direct) return direct;
                  for (const el of Array.from(root.querySelectorAll<Element>("*"))) {
                    const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                    if (sr) {
                      const inner = findFirst(sr);
                      if (inner) return inner;
                    }
                  }
                  return null;
                }
                const found = findFirst(document);
                if (!found) return false;
                if (requireShadow) {
                  const sr = (found as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                  return sr != null;
                }
                return true;
              },
              args: [selector, requireShadow],
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

      // Detect top-level `await` so the script can use it directly. The
      // word-boundary check excludes false positives like `myawaitable`. With
      // await, we wrap the code in an async IIFE expression and either:
      //  - chrome.scripting path: make the injected func async, await eval'd promise
      //  - CDP path: pass awaitPromise: true to Runtime.evaluate
      const usesAwait = /\bawait\b/.test(code);

      // Try normal content-script injection first
      let result = "undefined";
      let alertMsg: string | null = null;
      let cspBlocked = false;

      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: async (code: string, usesAwait: boolean) => {
            let result: unknown;
            try {
              if (usesAwait) {
                // Wrap in an async IIFE expression so eval parses the body as
                // an async function (top-level await works inside async fns).
                // Then await the returned promise here.
                result = await (0, eval)(`(async () => { ${code} })()`);
              } else {
                result = (0, eval)(code);
              }
            } catch (e) {
              if (String(e).includes("Illegal return")) {
                try {
                  if (usesAwait) {
                    result = await (0, eval)(`(async () => { ${code} })()`);
                  } else {
                    result = (0, eval)(`(function() { ${code} })()`);
                  }
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
          args: [code, usesAwait],
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
          // CDP Runtime.evaluate can await a returned promise directly via
          // awaitPromise: true. So in the await-detected path we just have the
          // expression be the async IIFE; awaitPromise resolves it for us.
          const wrappedCode = usesAwait
            ? `(async () => {
                var __result;
                try { __result = await (async () => { ${code} })(); }
                catch(e) { __result = "Error: " + e; }
                var __alert = window._alertCapture || null;
                if (__alert) window._alertCapture = null;
                return JSON.stringify({ result: String(__result ?? "undefined"), alert: __alert });
              })()`
            : `(function() {
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
            awaitPromise: usesAwait,
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
      // Retry up to 3 times with 500ms gap. Elements briefly disappear during
      // a React re-render and a single attempt fails; a short retry loop
      // turns those into successful clicks instead of 30s timeouts.
      let prep: { success: boolean; message: string; x?: number; y?: number; width?: number; height?: number; label?: string; skipClick?: boolean } | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        prep = await forwardToContentScript(tab, {
          type: "prepare_click_target",
          requestId: msg.requestId,
          textHint: msg.textHint,
          nth: msg.nth,
        }) as { success: boolean; message: string; x?: number; y?: number; width?: number; height?: number; label?: string; skipClick?: boolean };
        if (prep.success) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }

      if (!prep || !prep.success) {
        return { type: "click_element_response", success: false, message: prep?.message ?? "click failed" };
      }

      // Pre-flight skip: matched element resolved to an already-checked radio.
      // The page is already in the desired state, so firing the click would
      // toggle it OFF on React-controlled forms.
      if (prep.skipClick) {
        return { type: "click_element_response", success: true, message: prep.message };
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

            // Build a curved path from an offset start point to the target,
            // using a quadratic bezier with a random control point. Humans
            // move in arcs, not straight lines — behavioral fingerprinters
            // (LinkedIn, Akamai) score on trajectory smoothness and curvature.
            const sx = cx + Math.round((Math.random() - 0.5) * 60);
            const sy = cy + Math.round((Math.random() - 0.5) * 60);
            // Control point offset perpendicular to the line, random magnitude.
            const midX = (sx + cx) / 2;
            const midY = (sy + cy) / 2;
            const perpDx = -(cy - sy);
            const perpDy = cx - sx;
            const perpLen = Math.sqrt(perpDx * perpDx + perpDy * perpDy) || 1;
            // Control-point offset in pixels, along the unit-perpendicular
            // vector. Random sign + magnitude scaled with path length (capped).
            const bowPx = (Math.random() * 0.4 - 0.2) * Math.min(80, perpLen);
            const ctlX = midX + (perpDx / perpLen) * bowPx;
            const ctlY = midY + (perpDy / perpLen) * bowPx;

            const steps = 6 + Math.floor(Math.random() * 4); // 6-9 waypoints
            for (let i = 1; i <= steps; i++) {
              const t = i / steps;
              // Quadratic bezier B(t) = (1-t)^2 P0 + 2(1-t)t P1 + t^2 P2
              const bx = Math.round((1 - t) * (1 - t) * sx + 2 * (1 - t) * t * ctlX + t * t * cx);
              const by = Math.round((1 - t) * (1 - t) * sy + 2 * (1 - t) * t * ctlY + t * t * cy);
              await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
                type: "mouseMoved", x: bx, y: by, button: "none", clickCount: 0,
              });
              // Slight ease-out: gaps shorter in the middle, longer at the ends
              await new Promise((r) => setTimeout(r, 8 + Math.random() * 14));
            }
            // Small settle pause before the press
            await new Promise((r) => setTimeout(r, 25 + Math.random() * 40));
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

      // If the caller specified an until-clause, poll for it before returning.
      // This catches the "click_element returned success but the click didn't
      // register" case on React-heavy sites — Claude can require an observable
      // post-click condition (URL change, new selector, new page text) instead
      // of trusting the synthetic-success message.
      const untilSelector = msg.until_selector as string | undefined;
      const untilUrlContains = msg.until_url_contains as string | undefined;
      const untilTextContains = msg.until_text_contains as string | undefined;
      const untilTimeoutMs = (msg.until_timeout_ms as number | undefined) ?? 5000;
      const hasUntil = !!(untilSelector || untilUrlContains || untilTextContains);

      let untilResult: { ok: boolean; reason: string } | null = null;
      let navigationResult: string | null = null;

      if (hasUntil) {
        const start = Date.now();
        while (Date.now() - start < untilTimeoutMs) {
          // Pull the current tab state each iteration (URL may change after navigation).
          const [currentTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
          const currentUrl = currentTab?.url ?? "";

          if (untilUrlContains && currentUrl.includes(untilUrlContains)) {
            untilResult = { ok: true, reason: `URL now contains "${untilUrlContains}"` };
            navigationResult = currentUrl;
            break;
          }

          if (currentTab?.id && isScriptableUrl(currentUrl)) {
            try {
              if (untilSelector) {
                const r = await chrome.scripting.executeScript({
                  target: { tabId: currentTab.id },
                  func: (sel: string) => !!document.querySelector(sel),
                  args: [untilSelector],
                });
                if (r[0]?.result) {
                  untilResult = { ok: true, reason: `Selector "${untilSelector}" appeared` };
                  break;
                }
              }
              if (untilTextContains) {
                const r = await chrome.scripting.executeScript({
                  target: { tabId: currentTab.id },
                  func: (needle: string) => (document.body?.innerText ?? "").includes(needle),
                  args: [untilTextContains],
                });
                if (r[0]?.result) {
                  untilResult = { ok: true, reason: `Text "${untilTextContains}" appeared` };
                  break;
                }
              }
            } catch { /* page may be navigating — keep polling */ }
          }

          await new Promise((r) => setTimeout(r, 250));
        }
        if (!untilResult) {
          const conditions = [
            untilSelector && `selector "${untilSelector}"`,
            untilUrlContains && `URL containing "${untilUrlContains}"`,
            untilTextContains && `text "${untilTextContains}"`,
          ].filter(Boolean).join(" or ");
          untilResult = { ok: false, reason: `Click fired but ${conditions} did not appear within ${untilTimeoutMs}ms — the click may not have registered. Try execute_script with a direct .click() on the matched element, or pass a different until_* value.` };
        }
      } else {
        // No until-clause — keep the existing race so callers without explicit
        // verification still get the navigation URL when the click navigated.
        navigationResult = await Promise.race([
          waitForNavigation(tab.id!, 4000),
          new Promise<null>((r) => setTimeout(() => r(null), 600)),
        ]);
      }

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

      let message: string;
      if (untilResult) {
        // The until-clause is the authoritative signal — a successful click
        // is the one whose post-click condition was met. Failure is reported
        // as success:false so callers can branch on it.
        message = `${result.message}${untilResult.ok ? "" : "\n"}${untilResult.ok ? ` — ${untilResult.reason}` : `\n⚠ ${untilResult.reason}`}`;
        if (alertMessage) {
          message += `\n\nPAGE ALERT: "${alertMessage}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
        }
        return { type: "click_element_response", success: untilResult.ok, message };
      }

      message = navigationResult
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
      const frameSelector = msg.frame as string | undefined;

      // If `frame` is given, focus a contenteditable/input inside that iframe
      // BEFORE the CDP keys fire. eBay's "se-rte" description editor is an
      // iframe containing a contenteditable; without focus inside the iframe,
      // the CDP keys land on the outer document and are silently dropped.
      // Only works for same-origin iframes (contentDocument access requires it).
      let frameFocusOk: boolean | null = null;
      if (frameSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (sel: string) => {
              const iframe = document.querySelector(sel);
              if (!(iframe instanceof HTMLIFrameElement)) return "no-iframe";
              let doc: Document | null = null;
              try { doc = iframe.contentDocument; } catch { doc = null; }
              if (!doc) return "cross-origin";
              const editable = doc.querySelector<HTMLElement>(
                '[contenteditable="true"], [contenteditable=""], textarea, input:not([type=hidden])'
              );
              if (!editable) return "no-editable-in-frame";
              editable.focus();
              // Place caret at the end so typing appends rather than overwriting selection
              if (editable.isContentEditable) {
                const sel = doc.getSelection();
                const range = doc.createRange();
                range.selectNodeContents(editable);
                range.collapse(false);
                sel?.removeAllRanges();
                sel?.addRange(range);
              } else if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
                const len = editable.value.length;
                editable.setSelectionRange(len, len);
              }
              return "ok";
            },
            args: [frameSelector],
          });
          frameFocusOk = r[0]?.result === "ok";
          if (!frameFocusOk) {
            return {
              type: "action_done",
              requestId: msg.requestId,
              success: false,
              message: `Could not focus an editable element inside iframe "${frameSelector}" (${r[0]?.result ?? "unknown"}). The iframe may be cross-origin or empty.`,
            };
          }
        } catch (e) {
          return {
            type: "action_done",
            requestId: msg.requestId,
            success: false,
            message: `Error focusing iframe "${frameSelector}": ${(e as Error).message}`,
          };
        }
      }

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

      // If we were typing into an iframe, also dispatch input/change on the
      // iframe's focused element. CDP's Runtime.evaluate above runs in the
      // top-level frame's execution context, so events dispatched there don't
      // reach the iframe's React tree.
      let frameVerify = "";
      if (frameSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (sel: string) => {
              const iframe = document.querySelector(sel);
              if (!(iframe instanceof HTMLIFrameElement)) return "";
              let doc: Document | null = null;
              try { doc = iframe.contentDocument; } catch { doc = null; }
              if (!doc) return "";
              const active = doc.activeElement;
              if (active instanceof HTMLElement) {
                active.dispatchEvent(new Event("input", { bubbles: true }));
                active.dispatchEvent(new Event("change", { bubbles: true }));
                const txt = active.isContentEditable
                  ? (active.textContent ?? "")
                  : (active as HTMLInputElement).value ?? "";
                return `[frame editor now has ${txt.length} chars]`;
              }
              return "";
            },
            args: [frameSelector],
          });
          frameVerify = (r[0]?.result as string) ?? "";
        } catch { /* best-effort verification */ }
      }

      return {
        type: "action_done",
        requestId: msg.requestId,
        success: true,
        message: `Typed ${text.length} characters via individual keystrokes${frameSelector ? ` into iframe "${frameSelector}"${frameVerify ? " " + frameVerify : ""}` : ""}`,
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
      const filename = (msg.filePath as string).split("/").pop() ?? "";
      const waitMs = (msg.waitMs as number | undefined) ?? 3000;
      const verifySelector = msg.verifySelector as string | undefined;

      // Snapshot the page-level file count BEFORE we attach. This is the
      // single most useful signal that the upload landed: if the page shows
      // 4 file inputs with 0 files total before, and 1 file after, the
      // upload committed. Inputs that are visually hidden (drag-and-drop
      // zones) count too.
      const pre = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type=file]"));
          let total = 0;
          for (const el of inputs) total += el.files?.length ?? 0;
          return { totalFiles: total, inputCount: inputs.length };
        },
      });
      const preTotal = (pre[0]?.result as { totalFiles: number; inputCount: number } | undefined)?.totalFiles ?? 0;

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

      // Poll for the upload to commit. Issue #2 (rapid back-to-back set_file_input
      // calls duplicate or overwrite uploads) and Issue #3 (no signal that the page
      // accepted the file) are both fixed by waiting here for an observable change
      // before returning. Two signals:
      //  (a) total file count across input[type=file] increased — the input still
      //      holds the file (most uploaders).
      //  (b) the page now matches verifySelector — caller-supplied confirmation
      //      element (e.g. ".photo-thumbnail" for an image carousel).
      // (a)-or-(b) success short-circuits the wait. Otherwise we wait the full
      // waitMs and report no observable change.
      const pollStart = Date.now();
      let committed = false;
      let consumed = false;
      let postTotal = preTotal;
      let verifyMatched = false;

      while (Date.now() - pollStart < waitMs) {
        await new Promise((r) => setTimeout(r, 200));

        const post = await chrome.scripting.executeScript({
          target: { tabId },
          func: (name: string, sel: string | undefined) => {
            const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input[type=file]"));
            let total = 0;
            let stillHasOurFile = false;
            for (const el of inputs) {
              const files = el.files;
              if (!files) continue;
              total += files.length;
              for (let i = 0; i < files.length; i++) {
                if (files[i].name === name) stillHasOurFile = true;
              }
            }
            const verifyOk = sel ? !!document.querySelector(sel) : false;
            return { total, stillHasOurFile, verifyOk };
          },
          args: [filename, verifySelector ?? ""],
        });
        const result = post[0]?.result as { total: number; stillHasOurFile: boolean; verifyOk: boolean } | undefined;
        if (!result) continue;

        postTotal = result.total;
        verifyMatched = result.verifyOk;

        if (verifyMatched) { committed = true; break; }
        if (postTotal > preTotal) { committed = true; break; }
        // Some uploaders consume the file: read it from .files and reset the input.
        // If our file disappeared without an increase elsewhere, treat it as consumed.
        if (!result.stillHasOurFile && Date.now() - pollStart > 400) {
          committed = true;
          consumed = true;
          break;
        }
      }

      const noteParts: string[] = [];
      noteParts.push(`page-level file count: ${preTotal} → ${postTotal}`);
      if (verifySelector) noteParts.push(`verifySelector "${verifySelector}" ${verifyMatched ? "matched" : "did not match"}`);
      if (consumed) noteParts.push("file was consumed by the page (input was reset)");
      const note = noteParts.join("; ");

      if (committed) {
        return {
          type: "action_done",
          requestId: msg.requestId,
          success: true,
          message: `File "${filename}" uploaded — ${note}`,
        };
      }
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: false,
        message: `File "${filename}" set on input but the page did not show an observable change within ${waitMs}ms — ${note}. The page may have rejected the upload (size, type, format), or the change handler may be slower than the wait window. Use verifySelector or get_page_text to confirm.`,
      };
    }

    case "react_set_input": {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      if (!isScriptableUrl(tab.url)) {
        return { type: "action_done", requestId: msg.requestId, success: false, message: `Cannot run on ${tab.url}` };
      }

      const selector = msg.selector as string;
      const value = msg.value as string;
      const frameSelector = msg.frame as string | undefined;

      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (sel: string, val: string, frameSel: string | undefined) => {
          // Resolve the input — top-frame document by default, contentDocument
          // when frameSel is given (same-origin iframes only).
          let doc: Document = document;
          if (frameSel) {
            const iframe = document.querySelector(frameSel);
            if (!(iframe instanceof HTMLIFrameElement)) return { ok: false, reason: `iframe "${frameSel}" not found` };
            try {
              const fdoc = iframe.contentDocument;
              if (!fdoc) return { ok: false, reason: `iframe "${frameSel}" is cross-origin` };
              doc = fdoc;
            } catch {
              return { ok: false, reason: `iframe "${frameSel}" is cross-origin` };
            }
          }
          const el = doc.querySelector(sel);
          if (!el) return { ok: false, reason: `selector "${sel}" not found${frameSel ? ` inside iframe "${frameSel}"` : ""}` };

          // Use the prototype FROM THE INSTANCE so the setter is callable on
          // the input directly. Inputs hosted inside an iframe have their own
          // window.HTMLInputElement that differs from the outer one — calling
          // window.HTMLInputElement.prototype's value setter on them throws
          // "Illegal invocation". Object.getPrototypeOf(el) sidesteps that.
          if (!(el instanceof HTMLElement)) return { ok: false, reason: "selector matched a non-HTMLElement" };

          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (!desc?.set) return { ok: false, reason: `element does not expose a value setter (tag=${el.tagName.toLowerCase()})` };

          (el as HTMLElement).focus();
          desc.set.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));

          // Read back to confirm React accepted it
          const readBack = (el as unknown as { value?: unknown }).value;
          return {
            ok: true,
            reason: "set",
            tag: el.tagName.toLowerCase(),
            name: (el as HTMLInputElement).name ?? "",
            id: el.id ?? "",
            type: (el as HTMLInputElement).type ?? "",
            readBack: typeof readBack === "string" ? readBack : String(readBack),
          };
        },
        args: [selector, value, frameSelector],
      });

      const result = r[0]?.result as
        | { ok: false; reason: string }
        | { ok: true; reason: string; tag: string; name: string; id: string; type: string; readBack: string }
        | undefined;
      if (!result) return { type: "action_done", requestId: msg.requestId, success: false, message: "no response from page" };
      if (!result.ok) return { type: "action_done", requestId: msg.requestId, success: false, message: result.reason };

      const accepted = result.readBack === value;
      const desc = `<${result.tag}${result.type ? ` type="${result.type}"` : ""}${result.name ? ` name="${result.name}"` : ""}${result.id ? ` id="${result.id}"` : ""}>`;
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: true,
        message: accepted
          ? `Set ${desc} to "${value.slice(0, 60)}"${frameSelector ? ` (inside iframe "${frameSelector}")` : ""}`
          : `Set ${desc} via native setter, but React reported back "${result.readBack.slice(0, 60)}" — the page may be controlling the value externally.`,
      };
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
