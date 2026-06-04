/**
 * Background service worker.
 *
 * Message flow:
 *   Offscreen (WS) → background → content script (DOM ops)
 *   Content script → background → offscreen (responses + events)
 *   Background handles tab ops directly (screenshot, navigate, navigation watch).
 */

import { parseDoc, detectFormat, type SupportedFormat } from "./lib/parse-doc";
import { markerIds } from "./markers";

const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// ─── Per-instance Claude window assignments ────────────────────────────────
// Per-port instance metadata (label, host) from the WS identity handshake.
// Populated via the offscreen "status" broadcast so the background can push
// instance info to the content script for the info box overlay.
const portMeta = new Map<number, { label?: string; host?: string }>();

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
type ClickWatchResult = {
  type: string;
  url?: string;
  target?: { selector: string; text: string; tag: string; x: number; y: number } | null;
  redispatched?: boolean;
  redispatch_activity?: boolean;
};
const pendingClicks = new Map<
  string,
  { port: number; redispatch?: boolean; cb: (result: ClickWatchResult) => void }
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
      const livePorts = (msg.livePorts as Array<{ port: number; label?: string; host?: "claude" | "codex" }>) ?? [];
      chrome.storage.local.set({ chromeflowLivePorts: livePorts }).catch(() => {});
      for (const lp of livePorts) {
        portMeta.set(lp.port, { label: lp.label, host: lp.host });
      }
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
        const target = msg.target as ClickWatchResult["target"] ?? null;
        if (entry.redispatch && target && target.x > 0 && target.y > 0) {
          (async () => {
            try {
              const wid = getWindowId(entry.port);
              if (!wid) { entry.cb({ type: "click_detected", target }); return; }
              const [tab] = await chrome.tabs.query({ active: true, windowId: wid });
              if (!tab?.id || !isScriptableUrl(tab.url)) {
                entry.cb({ type: "click_detected", target });
                return;
              }
              const beforeUrl = tab.url ?? "";
              await dispatchHumanMouseClick(tab.id, target.x, target.y);
              const probe = await runActivityProbe(tab.id, beforeUrl, 1500, null).catch(() => ({
                activity: true, reason: "(probe failed)", mutation_count: 0,
                url_changed: false, after_url: beforeUrl, focused_after: null,
              } as ActivityProbeResult));
              entry.cb({
                type: "click_detected",
                target,
                redispatched: true,
                redispatch_activity: probe.activity,
              });
            } catch {
              entry.cb({ type: "click_detected", target, redispatched: false });
            }
          })();
        } else {
          entry.cb({ type: "click_detected", target });
        }
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

        // In-flight request counter for click_element's network-aware
        // until-poll. The Resource Timing API only records entries AFTER a
        // request completes, so it can't report in-flight requests — we have
        // to count them ourselves by wrapping fetch + XHR. window.__cfInflight
        // holds the live count of pending fetch/XHR requests.
        if (!(window as any).__cfInflightPatched) {
          (window as any).__cfInflightPatched = true;
          (window as any).__cfInflight = 0;
          const dec = () => { (window as any).__cfInflight = Math.max(0, ((window as any).__cfInflight || 0) - 1); };
          const origFetch = window.fetch;
          if (typeof origFetch === "function") {
            window.fetch = function (this: unknown, ...a: unknown[]) {
              (window as any).__cfInflight = ((window as any).__cfInflight || 0) + 1;
              let p: unknown;
              try { p = (origFetch as (...x: unknown[]) => unknown).apply(this, a); }
              catch (e) { dec(); throw e; }
              return Promise.resolve(p as Promise<unknown>).finally(dec);
            } as typeof window.fetch;
          }
          const XHR = window.XMLHttpRequest;
          if (XHR && XHR.prototype && typeof XHR.prototype.send === "function") {
            const origSend = XHR.prototype.send;
            XHR.prototype.send = function (this: XMLHttpRequest, ...a: unknown[]) {
              try {
                (window as any).__cfInflight = ((window as any).__cfInflight || 0) + 1;
                this.addEventListener("loadend", dec, { once: true });
              } catch { /* ignore */ }
              return (origSend as (...x: unknown[]) => unknown).apply(this, a);
            } as typeof XHR.prototype.send;
          }
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
// Refcount for nested withDebugger calls on the same tab. Lets click_element
// hold a single outer attach across prep + CDP click + activity probe +
// fallback chain + until-poll so a beforeunload listener registered at the
// outer scope stays armed when nested CDP helpers (dispatchHumanMouseClick,
// dispatchTapGesture, dispatchKeyboardActivation) finish their inner blocks.
// Without this, the inner withDebugger detaches between the click and the
// probe, and a "Leave site?" dialog that fires during the probe hangs the
// tab because the listener can no longer send Page.handleJavaScriptDialog.
const tabDebuggerRefCount = new Map<number, number>();

async function withDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  // Nested call inside an outer attach: skip both the queue and the
  // attach/detach pair. Just bump the refcount and run.
  const existing = tabDebuggerRefCount.get(tabId) ?? 0;
  if (existing > 0) {
    tabDebuggerRefCount.set(tabId, existing + 1);
    try {
      return await fn();
    } finally {
      const cur = tabDebuggerRefCount.get(tabId) ?? 1;
      if (cur <= 1) tabDebuggerRefCount.delete(tabId);
      else tabDebuggerRefCount.set(tabId, cur - 1);
    }
  }

  const prev = tabDebuggerLocks.get(tabId);
  if (prev) await prev.catch(() => {});

  let release!: () => void;
  const lock = new Promise<void>((r) => { release = r; });
  tabDebuggerLocks.set(tabId, lock);

  try {
    // Retry attach up to 5 times with 500ms..2500ms backoff. The most common
    // failure isn't a real conflict (DevTools, second chromeflow instance) —
    // it's a transient race inside chromeflow itself where one handler's
    // detach hasn't propagated yet when the next handler tries to attach.
    // Bumped from 3 → 5 attempts because the 3-attempt budget (~1.5s) was
    // tripping on these races even when no real conflict existed.
    const MAX_ATTEMPTS = 5;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await (chrome.debugger as any).attach({ tabId }, "1.3");
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
        const msg = String(lastErr.message ?? err);
        if (msg.includes("Another debugger is already attached") && attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        if (msg.includes("Another debugger is already attached")) {
          throw new Error(
            `Another debugger is already attached to this tab after ${MAX_ATTEMPTS} retries (waited ~7.5s). If you do not have Chrome DevTools open (Cmd+Opt+I) and no other chromeflow instance is using this tab, this is likely a transient internal race — retrying the same call should succeed. If it persists, close DevTools or move the other chromeflow instance to a separate Chrome window.`
          );
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;

    tabDebuggerRefCount.set(tabId, 1);
    try {
      return await fn();
    } finally {
      tabDebuggerRefCount.delete(tabId);
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

/**
 * Count anti-bot-friendly "something happened" selectors on the active page.
 * Used by click_element's `expect_submit` flag: snapshot pre-click counts,
 * compare after to detect NEW alerts/toasts/modals appearing. Without the
 * snapshot, a pre-existing toast would be misread as a post-submit signal.
 *
 * Selectors chosen to cover the common UI libraries: Radix (role=alert),
 * Sonner (data-sonner-toast), shadcn / Tailwind UI (.toast, .notification),
 * accessibility-correct apps (aria-live), and any modal / dialog. Excludes
 * aria-hidden elements (offscreen carriers used for screen-reader semantics).
 */
async function getSubmitSignalCounts(tabId: number): Promise<{ alert: number; toast: number; modal: number }> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const c = (sel: string) => {
          try { return document.querySelectorAll(sel).length; }
          catch { return 0; }
        };
        return {
          alert:
            c('[role="alert"]:not([aria-hidden="true"])') +
            c('[aria-live="polite"]:not(:empty):not([aria-hidden="true"])') +
            c('[aria-live="assertive"]:not(:empty):not([aria-hidden="true"])'),
          toast:
            c('[data-sonner-toast]') +
            c('.toast:not(.hidden):not([aria-hidden="true"])') +
            c('.notification:not(.hidden):not([aria-hidden="true"])'),
          modal:
            c('[role="dialog"]:not([aria-hidden="true"])') +
            c('[aria-modal="true"]'),
        };
      },
    });
    return (r[0]?.result as { alert: number; toast: number; modal: number } | undefined) ?? { alert: 0, toast: 0, modal: 0 };
  } catch {
    return { alert: 0, toast: 0, modal: 0 };
  }
}

/**
 * Per-click activity probe. Watches the page for a short window after a
 * click dispatch and reports whether ANY observable side-effect happened —
 * DOM mutation, focus change, URL change, value/checked change on the
 * clicked element, or alert/toast/modal appearance.
 *
 * Returns early (before the full `windowMs` elapses) as soon as activity is
 * detected, so the common case adds only ~100ms of latency. When 0 activity
 * is detected at the end of the window, the caller can fail fast with a
 * "silently rejected by anti-bot" message instead of sitting in a long
 * until_* poll waiting for a condition that will never resolve.
 *
 * Also returns the focused element after the window — used by click_element
 * to populate the `focused_after` response field so callers can chain
 * type_text/fill_input without guessing whether focus landed.
 */
type ActivityProbeResult = {
  activity: boolean;
  reason: string;
  mutation_count: number;
  url_changed: boolean;
  after_url: string;
  focused_after: {
    tag: string;
    id: string;
    name: string;
    type: string;
    aria_label: string;
    value_preview: string;
  } | null;
};

/**
 * Race a promise against a labeled timeout. Used by click_element to convert
 * a single 30s WS-cap into per-phase timeouts so when something hangs we
 * know WHICH phase hung (CDP attach, bezier dispatch, activity probe, fiber
 * walk, post-click read), not just "timed out somewhere in 30s".
 *
 * The PHASE_BUDGET_MULT env var lets the user field-tune budgets without a
 * release. Defaults to 1.0; set CHROMEFLOW_PHASE_BUDGET_MULT in the popup or
 * via runtime config when iterating on a particular hang.
 */
const PHASE_BUDGET_MULT = 1.0; // multiplicative knob, future runtime config
function phaseRace<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  const budget = Math.max(50, ms * PHASE_BUDGET_MULT);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`phase=${label} exceeded ${budget}ms`) as Error & { phase?: string; phaseTimedOut?: boolean };
      err.phase = label;
      err.phaseTimedOut = true;
      reject(err);
    }, budget);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Attach a CDP listener that auto-accepts Chrome's native "Leave site?" /
 * "Reload site?" beforeunload dialog on the given tab. Returns a `release`
 * callback that detaches the listener and reports whether a dialog was
 * dismissed during the protected window.
 *
 * Used by navigate, close_tab, and close_other_tabs so the agent doesn't
 * hang at the WS timeout when the target tab has unsaved form state. The
 * `dismissed_beforeunload` field in the tool response tells the caller
 * that the page HAD unsaved content (so they can navigate back + recover
 * if it mattered).
 *
 * Best-effort: if the debugger attach fails (already attached, no
 * permission, non-scriptable URL), the dialog will block as before and
 * dismissed stays false. Caller can detect that via the response field.
 */
async function setupBeforeunloadAutoDismiss(tabId: number): Promise<{
  release: () => Promise<{ dismissed: boolean }>;
}> {
  let dismissed = false;
  let attached = false;
  let handler:
    | ((source: chrome.debugger.Debuggee, method: string, params?: object) => void)
    | null = null;
  try {
    await (chrome.debugger as unknown as { attach: (t: { tabId: number }, v: string) => Promise<void> })
      .attach({ tabId }, "1.3");
    attached = true;
    await (chrome.debugger as unknown as { sendCommand: (t: { tabId: number }, m: string) => Promise<unknown> })
      .sendCommand({ tabId }, "Page.enable");
    handler = (source, method, params) => {
      if (source.tabId !== tabId) return;
      const p = params as { type?: string } | undefined;
      if (method === "Page.javascriptDialogOpening" && p?.type === "beforeunload") {
        (chrome.debugger as unknown as { sendCommand: (t: { tabId: number }, m: string, args?: object) => Promise<unknown> })
          .sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true })
          .catch(() => {});
        dismissed = true;
      }
    };
    chrome.debugger.onEvent.addListener(handler);
  } catch {
    // Debugger attach failed. Navigation/close proceeds without protection.
  }
  return {
    release: async () => {
      if (handler) {
        chrome.debugger.onEvent.removeListener(handler);
        handler = null;
      }
      if (attached) {
        try {
          await (chrome.debugger as unknown as { detach: (t: { tabId: number }) => Promise<void> })
            .detach({ tabId });
        } catch { /* may already be detached after tab close / navigation */ }
      }
      return { dismissed };
    },
  };
}

/**
 * Run the full human-like CDP mouse-click sequence at (x, y): bezier
 * approach path, settle-hover micro-tremor, press, release, post-click
 * micro-move. Reused by click_element (where coordinates come from the
 * matched element) and click_at_coordinates (where coordinates come from
 * the caller — typically for cross-origin iframes whose targets can't be
 * found by find_text). Coordinates are viewport CSS pixels.
 *
 * Anti-bot bypass: stricter Web Components (Reddit's faceplate-*,
 * Twitter's composer, etc.) check `event instanceof PointerEvent &&
 * event.isPrimary` in addition to isTrusted. We pass pointerType="mouse"
 * which makes Chrome fire PointerEvent alongside MouseEvent (isPrimary=true,
 * pointerId=1) with a realistic pressure via `force`. Combined with the
 * bezier path and settle hover, this passes every behavioral check we've
 * seen short of OS-level input.
 */
/**
 * Fallback click using CDP's high-level synthesizeTapGesture. Unlike
 * Input.dispatchMouseEvent (where the auto-generated `click` event has
 * isPrimary=false even when the source pointerdown/pointerup were
 * isPrimary=true), synthesizeTapGesture produces a fuller pointer chain
 * where the click event carries isPrimary=true.
 *
 * This is the fallback that handles Reddit's faceplate-* Lit web
 * components: their click handlers gate on
 * `event.isTrusted && event.isPrimary` on the click event itself, which
 * dispatchHumanMouseClick passes for isTrusted but fails for isPrimary.
 * The most visible casualty is the new-post flair button — pre-0.10.3
 * synthetic clicks silently_rejected even though the pointer events were
 * landing correctly. Used only when the primary CDP click probe shows
 * zero activity, so well-behaved targets aren't double-clicked.
 */
async function dispatchTapGesture(
  tabId: number,
  cx: number,
  cy: number,
): Promise<void> {
  await withDebugger(tabId, async () => {
    const dbg = chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
    };
    await dbg.sendCommand({ tabId }, "Input.synthesizeTapGesture", {
      x: cx,
      y: cy,
      duration: 50,
      tapCount: 1,
      gestureSourceType: "mouse",
    });
  });
}

/**
 * Keyboard activation fallback. When a button's click handler is
 * gated on something beyond isTrusted=true (Reddit's web components
 * check user-activation provenance — CDP mouse events count as trusted
 * but apparently not "trusted enough" for some custom-element handlers),
 * a CDP keyboard Enter press still activates the button. Buttons handle
 * Enter and Space natively via the browser's built-in keyboard activation
 * path, which bypasses any mouse-event source checks the page added.
 *
 * The element must be focused first (handled by the caller via
 * scripting.executeScript + el.focus()).
 */
async function dispatchKeyboardActivation(tabId: number): Promise<void> {
  await withDebugger(tabId, async () => {
    const dbg = chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
    };
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 40));
    // Full keystroke: rawKeyDown (creates DOM keydown event), char (creates
    // keypress / fires button activation), keyUp (releases). The char step is
    // critical: without it, Web Components that listen for `click` derived
    // from keyboard activation never see the activation fire. Chromium's
    // input system processes \r as the "default action" for Enter on focused
    // buttons (analogous to Space activating buttons).
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 20));
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "char",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 20));
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  });
}

async function dispatchHumanMouseClick(
  tabId: number,
  cx: number,
  cy: number,
  options: { button?: "left" | "right" | "middle"; double?: boolean } = {},
): Promise<void> {
  await withDebugger(tabId, async () => {
    const dbg = chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
    };
    // Beforeunload auto-dismiss is owned by the outer click_element handler
    // (see armBeforeunloadDismissOnAttachedTab) so the listener stays armed
    // across the activity probe and fallback chain — a late-firing dialog
    // (Reddit submit can fire it 1-2s after the click, as the API response
    // resolves and the redirect begins) would otherwise hang the tab because
    // the listener registered here was already removed.

    // (Previously: Page.bringToFront here to seed user activation. Removed in
    // 0.10.14 because the stealth shim in stealth.ts now patches
    // document.hasFocus and navigator.userActivation at document_start, which
    // covers the same gates without stealing OS focus from the user's
    // terminal/IDE.)
    const button = options.button ?? "left";
    const ptr = { pointerType: "mouse" as const, force: 0.5 };
    const sx = cx + Math.round((Math.random() - 0.5) * 60);
    const sy = cy + Math.round((Math.random() - 0.5) * 60);
    const midX = (sx + cx) / 2;
    const midY = (sy + cy) / 2;
    const perpDx = -(cy - sy);
    const perpDy = cx - sx;
    const perpLen = Math.sqrt(perpDx * perpDx + perpDy * perpDy) || 1;
    const bowPx = (Math.random() * 0.4 - 0.2) * Math.min(80, perpLen);
    const ctlX = midX + (perpDx / perpLen) * bowPx;
    const ctlY = midY + (perpDy / perpLen) * bowPx;
    const steps = 6 + Math.floor(Math.random() * 4);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const bx = Math.round((1 - t) * (1 - t) * sx + 2 * (1 - t) * t * ctlX + t * t * cx);
      const by = Math.round((1 - t) * (1 - t) * sy + 2 * (1 - t) * t * ctlY + t * t * cy);
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: bx, y: by, button: "none", clickCount: 0, ...ptr,
      });
      await new Promise((r) => setTimeout(r, 8 + Math.random() * 14));
    }
    for (let j = 0; j < 3; j++) {
      const jx = cx + Math.round((Math.random() - 0.5) * 4);
      const jy = cy + Math.round((Math.random() - 0.5) * 4);
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: jx, y: jy, button: "none", clickCount: 0, ...ptr,
      });
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 40));
    const clickCount = options.double ? 2 : 1;
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: cx, y: cy, button, clickCount, buttons: 1, ...ptr,
    });
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: cx, y: cy, button, clickCount, buttons: 0, ...ptr,
    });
    if (options.double) {
      // Second click of a double-click within the OS double-click window.
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: cx, y: cy, button, clickCount: 2, buttons: 1, ...ptr,
      });
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: cx, y: cy, button, clickCount: 2, buttons: 0, ...ptr,
      });
    }
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
    const px = cx + Math.round((Math.random() - 0.5) * 6);
    const py = cy + Math.round((Math.random() - 0.5) * 6);
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0, ...ptr,
    });
    // Short tail so an immediately-firing beforeunload dialog is dismissed by
    // the outer click_element handler's listener before this function returns.
    await new Promise((r) => setTimeout(r, 200));
  });
}

/**
 * Register a Page.javascriptDialogOpening listener that auto-dismisses the
 * native "Leave site?" / "Reload site?" beforeunload dialog on the given tab.
 * Assumes the caller is already inside an active withDebugger attach. Returns
 * a `release` callback that detaches the listener and reports whether a
 * dialog was dismissed during the protected window.
 *
 * Owned by click_element so the listener spans the entire flow: prep, CDP
 * click, activity probe, fallback chain, until-poll. Reddit's submit flow
 * fires the beforeunload 1-2s AFTER the click (post-API navigation), well
 * after dispatchHumanMouseClick's own withDebugger would have detached.
 */
async function armBeforeunloadDismissOnAttachedTab(tabId: number): Promise<{
  release: () => { dismissed: boolean };
}> {
  let dismissed = false;
  let handler:
    | ((source: chrome.debugger.Debuggee, method: string, params?: object) => void)
    | null = null;
  try {
    await (chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, m: string) => Promise<unknown>;
    }).sendCommand({ tabId }, "Page.enable");
    handler = (source, method, params) => {
      if (source.tabId !== tabId) return;
      const p = params as { type?: string } | undefined;
      if (method === "Page.javascriptDialogOpening" && p?.type === "beforeunload") {
        (chrome.debugger as unknown as {
          sendCommand: (t: { tabId: number }, m: string, args?: object) => Promise<unknown>;
        }).sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        dismissed = true;
      }
    };
    chrome.debugger.onEvent.addListener(handler);
  } catch { /* Page.enable failed; flow proceeds without protection */ }
  return {
    release: () => {
      if (handler) {
        try { chrome.debugger.onEvent.removeListener(handler); } catch { /* ignore */ }
        handler = null;
      }
      return { dismissed };
    },
  };
}

/**
 * Snapshot the shadow-pierce visible-element count for `tabId` BEFORE
 * a click is dispatched. The activity probe needs a baseline that pre-
 * dates any state change the click might trigger; if we baseline inside
 * the probe (post-click), Lit / Stencil renders that complete synchronously
 * during click dispatch end up already-counted and the delta reads 0
 * (Reddit's flair picker is the canonical case — open synchronously,
 * adds ~78 visible elements, post-click baseline matches post-render
 * state and the probe falsely reports silently_rejected).
 */
async function snapshotVisibleCount(tabId: number): Promise<number | null> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function getShadowRoot(el: Element): ShadowRoot | null {
          const cdom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
          if (cdom?.openOrClosedShadowRoot) {
            try {
              const sr = cdom.openOrClosedShadowRoot(el);
              if (sr) return sr;
            } catch { /* fall through */ }
          }
          return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
        }
        let count = 0;
        const seenRoots = new WeakSet<ShadowRoot>();
        function walk(root: Document | ShadowRoot) {
          const all = root.querySelectorAll("*");
          for (const el of Array.from(all)) {
            if ((el as HTMLElement).offsetParent !== null) count++;
            const sr = getShadowRoot(el);
            if (sr && !seenRoots.has(sr)) {
              seenRoots.add(sr);
              walk(sr);
            }
          }
        }
        walk(document);
        return count;
      },
    });
    const val = r[0]?.result;
    return typeof val === "number" ? val : null;
  } catch {
    return null;
  }
}

async function runActivityProbe(
  tabId: number,
  beforeUrl: string,
  windowMs: number = 1500,
  externalBaseline: number | null = null,
  targetMarkerAttr: string | null = null,
): Promise<ActivityProbeResult> {
  const empty: ActivityProbeResult = {
    activity: true,
    reason: "(probe skipped or failed; assuming activity)",
    mutation_count: 0,
    url_changed: false,
    after_url: beforeUrl,
    focused_after: null,
  };
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: (windowMs: number, beforeUrl: string, externalBaseline: number | null, targetMarkerAttr: string | null) => {
        return new Promise<ActivityProbeResult>((resolve) => {
          function getShadowRoot(el: Element): ShadowRoot | null {
            const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
            if (chromeDom?.openOrClosedShadowRoot) {
              try {
                const sr = chromeDom.openOrClosedShadowRoot(el);
                if (sr) return sr;
              } catch { /* fall through */ }
            }
            return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
          }
          function getFocused(): ActivityProbeResult["focused_after"] {
            let el: Element | null = document.activeElement;
            while (el) {
              const sr = getShadowRoot(el);
              if (!sr || !sr.activeElement) break;
              el = sr.activeElement;
            }
            if (!el || el === document.body) return null;
            const anyEl = el as Element & { name?: string; type?: string; value?: string };
            const innerText = (el as HTMLElement).innerText ?? "";
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || "",
              name: anyEl.name ?? "",
              type: anyEl.type ?? "",
              aria_label: el.getAttribute("aria-label") || "",
              value_preview: (anyEl.value ?? innerText ?? "").slice(0, 60),
            };
          }
          function getSignalCounts() {
            const c = (sel: string) => {
              try { return document.querySelectorAll(sel).length; }
              catch { return 0; }
            };
            return {
              alert:
                c('[role="alert"]:not([aria-hidden="true"])') +
                c('[aria-live="polite"]:not(:empty):not([aria-hidden="true"])') +
                c('[aria-live="assertive"]:not(:empty):not([aria-hidden="true"])'),
              toast:
                c('[data-sonner-toast]') +
                c('.toast:not(.hidden):not([aria-hidden="true"])') +
                c('.notification:not(.hidden):not([aria-hidden="true"])'),
              modal:
                c('[role="dialog"]:not([aria-hidden="true"])') +
                c('[aria-modal="true"]'),
            };
          }
          // Shadow-piercing VISIBLE element count. The plain MutationObserver
          // does NOT pierce shadow DOM, so when a Lit / Stencil / Radix
          // component swaps visibility on pre-rendered content (e.g.
          // Reddit's r-post-flairs-modal flair picker — the whole
          // FACEPLATE-FORM tree is rendered up-front and shown/hidden via
          // CSS classes on shadow children when the trigger is clicked),
          // the observer reports zero mutations and the click looks
          // silently_rejected even though it worked.
          //
          // We snapshot the count of visible elements (offsetParent !==
          // null filters out display:none and detached subtrees) walking
          // through every shadow root via chrome.dom.openOrClosedShadowRoot,
          // and re-check during the probe window as a fallback signal.
          function deepVisibleCount(): number {
            let count = 0;
            const seenRoots = new WeakSet<ShadowRoot>();
            function walk(root: Document | ShadowRoot) {
              const all = root.querySelectorAll("*");
              for (const el of Array.from(all)) {
                const htmlEl = el as HTMLElement;
                if (htmlEl.offsetParent !== null) count++;
                const sr = getShadowRoot(el);
                if (sr && !seenRoots.has(sr)) {
                  seenRoots.add(sr);
                  walk(sr);
                }
              }
            }
            walk(document);
            return count;
          }
          const focusedBefore = getFocused();
          const focusedKeyBefore = focusedBefore ? JSON.stringify(focusedBefore) : "";
          const signalsBefore = getSignalCounts();
          // Snapshot the tagged click target's state-bearing attributes so
          // we can detect state changes that don't produce general DOM
          // mutations (a faceplate-radio-input toggling aria-checked, a
          // Lit dropdown flipping aria-expanded, a contenteditable changing
          // its value). Without this, the probe reports "no activity" on
          // every Reddit radio click even though the radio IS now selected.
          const STATE_ATTRS = [
            "aria-checked", "aria-selected", "aria-expanded",
            "aria-pressed", "aria-current", "data-state",
            "checked", "value", "disabled",
          ];
          function snapshotTargetState(): string | null {
            if (!targetMarkerAttr) return null;
            const stack: (Document | ShadowRoot)[] = [document];
            while (stack.length) {
              const root = stack.pop()!;
              const found = root.querySelector(`[${targetMarkerAttr}]`);
              if (found) {
                const parts: string[] = [];
                for (const a of STATE_ATTRS) parts.push(`${a}=${found.getAttribute(a) ?? ""}`);
                if (found instanceof HTMLInputElement) parts.push(`prop_checked=${found.checked}`);
                return parts.join("|");
              }
              for (const el of Array.from(root.querySelectorAll("*"))) {
                const sr = getShadowRoot(el);
                if (sr) stack.push(sr);
              }
            }
            return null;
          }
          const targetStateBefore = snapshotTargetState();
          // Prefer caller-supplied pre-click baseline. If absent, fall
          // back to taking it now (sufficient for most callers; only
          // synchronous-render Lit components require the pre-click path).
          const deepCountBefore = typeof externalBaseline === "number"
            ? externalBaseline
            : deepVisibleCount();
          let mutationCount = 0;
          const observer = new MutationObserver((records) => {
            mutationCount += records.length;
          });
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          // Last time deepVisibleCount() was sampled. The deep walk is the
          // single most expensive check in the probe (50-150ms on a heavy
          // page with many shadow hosts). Cheap signals (URL, mutations,
          // focus, target attr, role-based count) fire every 100ms tick;
          // the deep walk only runs every 500ms AND on the final tick.
          // Catches Lit/Stencil/Radix visibility flips with ~half the CPU.
          let lastDeepCheckAt = 0;
          function check(isFinalTick: boolean): { activity: boolean; reason: string; url_changed: boolean } {
            const after_url = location.href;
            if (after_url !== beforeUrl) {
              return { activity: true, reason: `URL changed to ${after_url}`, url_changed: true };
            }
            if (mutationCount > 0) {
              return { activity: true, reason: `${mutationCount} DOM mutation${mutationCount === 1 ? "" : "s"}`, url_changed: false };
            }
            const focusedNow = getFocused();
            const focusedKeyNow = focusedNow ? JSON.stringify(focusedNow) : "";
            if (focusedKeyNow !== focusedKeyBefore) {
              return { activity: true, reason: "focused element changed", url_changed: false };
            }
            // Target element attribute change — catches form-input state
            // changes (aria-checked, checked) and Lit/Radix dropdown state
            // changes (aria-expanded, data-state) on the SPECIFIC element
            // that was clicked. MutationObserver detects these at the
            // document level too, but radios in shadow DOM with custom
            // attribute names sometimes evade general subtree observation.
            const targetStateNow = snapshotTargetState();
            if (targetStateBefore !== null && targetStateNow !== null && targetStateNow !== targetStateBefore) {
              return { activity: true, reason: "target element state attribute changed", url_changed: false };
            }
            const c = getSignalCounts();
            if (c.alert > signalsBefore.alert) return { activity: true, reason: "alert/aria-live element appeared", url_changed: false };
            if (c.toast > signalsBefore.toast) return { activity: true, reason: "toast / notification appeared", url_changed: false };
            if (c.modal > signalsBefore.modal) return { activity: true, reason: "modal / [role=dialog] appeared", url_changed: false };
            // Throttled shadow-pierce VISIBLE-element count check (catches
            // Lit / Stencil / Radix shows that flip visibility on pre-
            // rendered shadow-DOM content, which MutationObserver misses
            // entirely because no nodes are added — only CSS visibility
            // changes). Threshold >= 5 to filter background tickers / single-
            // node spinners. Reddit's flair picker exposes ~78 newly-visible
            // elements when opened. Sampled every 500ms + on the final tick
            // to keep cost ~3x lower than the previous every-100ms sampling.
            const now = Date.now();
            if (isFinalTick || now - lastDeepCheckAt >= 500) {
              lastDeepCheckAt = now;
              const deepCountNow = deepVisibleCount();
              const delta = deepCountNow - deepCountBefore;
              if (delta >= 5) {
                return { activity: true, reason: `shadow-pierce visible-element count grew by ${delta}`, url_changed: false };
              }
            }
            return { activity: false, reason: "", url_changed: false };
          }
          const start = Date.now();
          function tick() {
            const elapsed = Date.now() - start;
            const isFinalTick = elapsed + 100 >= windowMs;
            const r = check(isFinalTick);
            if (r.activity || elapsed >= windowMs) {
              observer.disconnect();
              resolve({
                activity: r.activity,
                reason: r.reason,
                mutation_count: mutationCount,
                url_changed: r.url_changed,
                after_url: location.href,
                focused_after: getFocused(),
              });
              return;
            }
            setTimeout(tick, 100);
          }
          tick();
        });
      },
      args: [windowMs, beforeUrl, externalBaseline, targetMarkerAttr],
      // Default ISOLATED world — chrome.dom.openOrClosedShadowRoot is only
      // available in extension content-script contexts, not in the page's
      // MAIN world. ISOLATED still shares the live DOM so MutationObserver
      // / activeElement / location.href all reflect the page accurately.
    });
    const result = r[0]?.result as ActivityProbeResult | undefined;
    return result ?? empty;
  } catch {
    return empty;
  }
}

/**
 * Count in-flight fetch/XHR requests on the page. Lets click_element's
 * until-poll tell a slow-but-real submit (API request still resolving, so the
 * URL change is merely pending) apart from a click that never registered.
 * `responseEnd === 0` means started-but-not-finished. We ignore entries older
 * than 30s so a long-lived SSE / websocket opened at page load isn't mistaken
 * for a pending submit, and only count fetch/XHR (not images, scripts, css).
 */
async function countInFlightRequests(tabId: number): Promise<number> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      // MAIN world: window.__cfInflight is the live pending-request count
      // maintained by the fetch/XHR wrappers installed in injectAlertCapture.
      // (Resource Timing can't see in-flight requests — it records on
      // completion — so we count them ourselves.)
      world: "MAIN",
      func: () => {
        try {
          const n = (window as unknown as { __cfInflight?: number }).__cfInflight;
          return typeof n === "number" && n > 0 ? n : 0;
        } catch {
          return 0;
        }
      },
    });
    return (r[0]?.result as number | undefined) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Sync a React-controlled radio/checkbox's store after a click that flipped the
 * DOM .checked but didn't reach React's onChange (shadow-boundary retargeting).
 * Runs in MAIN world because React's __reactProps$<hash> expando is only
 * visible there. SAFE / idempotent: fires onChange ONLY when the element's
 * controlled `checked` prop (what React last rendered) disagrees with the
 * current DOM .checked — so an already-committed change is left alone and a
 * functional-toggle handler is never double-fired.
 */
async function commitReactControlState(
  tabId: number,
  markerAttr: string,
): Promise<{ committed: boolean; kind?: string }> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (attr: string) => {
        try {
          // Find the tagged element, piercing OPEN shadow roots (MAIN world has
          // no chrome.dom, so closed roots aren't reachable here — but React
          // state that MAIN-world code can touch lives in light/open DOM).
          function deepFind(sel: string): Element | null {
            const stack: (Document | ShadowRoot)[] = [document];
            while (stack.length) {
              const root = stack.pop()!;
              const hit = root.querySelector(sel);
              if (hit) return hit;
              for (const el of Array.from(root.querySelectorAll("*"))) {
                const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                if (sr) stack.push(sr);
              }
            }
            return null;
          }
          const target = deepFind(`[${attr}]`);
          if (!target) return { committed: false };

          // Resolve to the actual radio/checkbox input (the target may be a
          // wrapping label or a custom control).
          let input: HTMLInputElement | null = null;
          if (target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) {
            input = target;
          } else {
            const forId = target.getAttribute?.("for");
            if (forId) {
              const t = document.getElementById(forId);
              if (t instanceof HTMLInputElement && (t.type === "radio" || t.type === "checkbox")) input = t;
            }
            if (!input) {
              const inner = target.querySelector?.('input[type="radio"], input[type="checkbox"]');
              if (inner instanceof HTMLInputElement) input = inner;
            }
          }
          if (!input) return { committed: false };

          // Walk up from the input looking for __reactProps$ with an onChange.
          // Use the INPUT's controlled `checked` prop for the desync test.
          let node: Element | null = input;
          let onChange: ((e: unknown) => void) | null = null;
          let controlledChecked: boolean | undefined;
          for (let depth = 0; depth < 6 && node; depth++) {
            const key = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
            const props = key ? (node as unknown as Record<string, { onChange?: unknown; checked?: unknown }>)[key] : undefined;
            if (props) {
              if (controlledChecked === undefined && typeof props.checked === "boolean") {
                controlledChecked = props.checked;
              }
              if (!onChange && typeof props.onChange === "function") {
                onChange = props.onChange as (e: unknown) => void;
              }
            }
            if (onChange && controlledChecked !== undefined) break;
            node = node.parentElement;
          }

          // Only act on a genuine controlled-state desync.
          if (!onChange || controlledChecked === undefined) return { committed: false };
          if (controlledChecked === input.checked) return { committed: false };

          const ev = {
            target: input,
            currentTarget: input,
            type: "change",
            bubbles: true,
            cancelable: true,
            defaultPrevented: false,
            nativeEvent: { isTrusted: true },
            preventDefault() { /* noop */ },
            stopPropagation() { /* noop */ },
            stopImmediatePropagation() { /* noop */ },
            persist() { /* noop */ },
            isDefaultPrevented: () => false,
            isPropagationStopped: () => false,
          };
          onChange(ev);
          return { committed: true, kind: input.type };
        } catch {
          return { committed: false };
        }
      },
      args: [markerAttr],
    });
    return (r[0]?.result as { committed: boolean; kind?: string } | undefined) ?? { committed: false };
  } catch {
    return { committed: false };
  }
}

/**
 * Inlined helpers for `set_file_input`'s pre/post snapshots. Each function is
 * shipped via chrome.scripting.executeScript and runs in the page's ISOLATED
 * world, where chrome.dom.openOrClosedShadowRoot is available. Inlining the
 * shadow-piercing query here means file inputs nested inside Stencil/Lit/
 * Radix web components are counted, not invisible.
 */
function pierceFileCount(): { totalFiles: number; inputCount: number } {
  function getShadowRoot(el: Element): ShadowRoot | null {
    const cdom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
    if (cdom?.openOrClosedShadowRoot) {
      try {
        const sr = cdom.openOrClosedShadowRoot(el);
        if (sr) return sr;
      } catch { /* fall through */ }
    }
    return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
  }
  function deepInputs(root: Document | ShadowRoot): HTMLInputElement[] {
    const out: HTMLInputElement[] = [];
    const seen = new WeakSet<Element>();
    function recurse(r: ParentNode) {
      for (const m of Array.from(r.querySelectorAll<HTMLInputElement>("input[type=file]"))) {
        if (!seen.has(m)) { seen.add(m); out.push(m); }
      }
      for (const el of Array.from(r.querySelectorAll<Element>("*"))) {
        const sr = getShadowRoot(el);
        if (sr) recurse(sr);
      }
    }
    recurse(root);
    return out;
  }
  const inputs = deepInputs(document);
  let total = 0;
  for (const el of inputs) total += el.files?.length ?? 0;
  return { totalFiles: total, inputCount: inputs.length };
}

function pierceFilePoll(name: string, sel: string): { total: number; stillHasOurFile: boolean; verifyOk: boolean } {
  function getShadowRoot(el: Element): ShadowRoot | null {
    const cdom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
    if (cdom?.openOrClosedShadowRoot) {
      try {
        const sr = cdom.openOrClosedShadowRoot(el);
        if (sr) return sr;
      } catch { /* fall through */ }
    }
    return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
  }
  function deepQuery<E extends Element = Element>(root: ParentNode, selector: string): E[] {
    const out: E[] = [];
    const seen = new WeakSet<Element>();
    function recurse(r: ParentNode) {
      for (const m of Array.from(r.querySelectorAll<E>(selector))) {
        if (!seen.has(m)) { seen.add(m); out.push(m); }
      }
      for (const el of Array.from(r.querySelectorAll<Element>("*"))) {
        const sr = getShadowRoot(el);
        if (sr) recurse(sr);
      }
    }
    recurse(root);
    return out;
  }
  const inputs = deepQuery<HTMLInputElement>(document, "input[type=file]");
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
  const verifyOk = sel ? deepQuery(document, sel).length > 0 : false;
  return { total, stillHasOurFile, verifyOk };
}

/**
 * Walk a CDP DOM tree (from DOM.getDocument({pierce: true})) and return the
 * backendNodeId of the first node carrying `attrName="true"`. Pierces shadow
 * roots and same-origin iframes via the CDP-side `shadowRoots` and
 * `contentDocument` fields.
 *
 * Used by set_file_input to locate the content-script-tagged file input from
 * the background worker. The legacy path used Runtime.evaluate + document
 * .querySelector, which is MAIN-world and can't see shadow-rooted elements.
 */
interface CDPNode {
  backendNodeId: number;
  attributes?: string[];
  children?: CDPNode[];
  shadowRoots?: CDPNode[];
  contentDocument?: CDPNode;
}

async function findShadowMarkedBackendNodeId(tabId: number, attrName: string): Promise<number | null> {
  const dbg = chrome.debugger as unknown as {
    sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
  };
  const docResult = await dbg.sendCommand({ tabId }, "DOM.getDocument", { pierce: true, depth: -1 }) as { root: CDPNode };
  return walkForMarker(docResult.root, attrName);
}

function walkForMarker(node: CDPNode, attrName: string): number | null {
  if (node.attributes) {
    for (let i = 0; i < node.attributes.length - 1; i += 2) {
      if (node.attributes[i] === attrName && node.attributes[i + 1] === "true") {
        return node.backendNodeId;
      }
    }
  }
  for (const child of node.children ?? []) {
    const found = walkForMarker(child, attrName);
    if (found) return found;
  }
  for (const sr of node.shadowRoots ?? []) {
    const found = walkForMarker(sr, attrName);
    if (found) return found;
  }
  if (node.contentDocument) {
    const found = walkForMarker(node.contentDocument, attrName);
    if (found) return found;
  }
  return null;
}

/**
 * Hard-coded URL refusal — mirrors `packages/mcp-server/src/policy.ts`. The
 * MCP-server layer already refuses these calls before the WS hop; this is
 * defence in depth so a direct WS caller (or a future bypass) sees the same
 * answer.
 *
 * Commitment to GitHub Support during account-restoration review (2026-05-14):
 * chromeflow refuses to drive the browser at github.com / githubusercontent
 * .com or through any OAuth /authorize endpoint.
 */
function isBlockedUrl(rawUrl: string): { blocked: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { blocked: false };
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "github.com" ||
    host.endsWith(".github.com") ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  ) {
    return {
      blocked: true,
      reason:
        "chromeflow refuses to drive the browser at github.com (hard-coded; account-restoration commitment 2026-05-14). Use a normal browser tab manually.",
    };
  }
  const pathLower = parsed.pathname.toLowerCase();
  if (pathLower.includes("oauth") && pathLower.includes("authorize")) {
    return {
      blocked: true,
      reason:
        "chromeflow refuses to drive the browser through OAuth /authorize endpoints (hard-coded). Complete OAuth manually in a normal browser tab.",
    };
  }
  return { blocked: false };
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

/**
 * High-confidence anti-bot block-page detection. Runs a regex pass against
 * response HTML and returns a short human-readable label for the matched
 * vendor when a block is recognised, or null otherwise.
 *
 * Read-only signal: surfaces on open_page and fetch_url responses as
 * `anti_bot_detected`. Does not change behaviour, does not retry, does not
 * fire events. The agent reads the field and decides what to do.
 *
 * Only Tier-1 structural markers (unique to block pages, virtually zero
 * false-positive risk). The generic-term and structural-integrity tiers
 * from crawler libraries are deliberately omitted — they false-positive
 * on legitimate "Access Denied" articles, login forms, and empty SPA
 * shells before hydration.
 */
function detectAntiBot(html: string): string | null {
  if (!html || html.length < 50) return null;
  // Cap the regex pass at 200KB. Block pages are typically tiny; legitimate
  // SPA shells are huge and would slow scans without informative matches.
  const slice = html.length > 200_000 ? html.slice(0, 200_000) : html;
  const patterns: Array<[RegExp, string]> = [
    // Akamai
    [/Reference\s*#\s*[\d]+\.[0-9a-f]+\.\d+\.[0-9a-f]+/i, "Akamai block (Reference #)"],
    [/Pardon\s+Our\s+Interruption/i, "Akamai challenge (Pardon Our Interruption)"],
    // Cloudflare
    [/challenge-form[\s\S]*?__cf_chl_f_tk=/i, "Cloudflare challenge form"],
    [/<span\s+class="cf-error-code">\d{4}<\/span>/i, "Cloudflare firewall block"],
    [/\/cdn-cgi\/challenge-platform\/\S+orchestrate/i, "Cloudflare JS challenge"],
    // PerimeterX / HUMAN
    [/window\._pxAppId\s*=/i, "PerimeterX block"],
    [/captcha\.px-cdn\.net/i, "PerimeterX captcha"],
    // DataDome
    [/captcha-delivery\.com/i, "DataDome captcha"],
    // Imperva / Incapsula
    [/_Incapsula_Resource/i, "Imperva/Incapsula block"],
    [/Incapsula\s+incident\s+ID/i, "Imperva/Incapsula incident"],
    // Sucuri
    [/Sucuri\s+WebSite\s+Firewall/i, "Sucuri firewall block"],
    // Kasada
    [/KPSDK\.scriptStart\s*=\s*KPSDK\.now\(\)/i, "Kasada challenge"],
    // Network security block (Reddit-style large SPA shell with the message buried in)
    [/blocked\s+by\s+network\s+security/i, "Network security block"],
  ];
  for (const [re, label] of patterns) {
    if (re.test(slice)) return label;
  }
  return null;
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

const tabsWithInfoBox = new Set<number>();

async function pushInstanceInfoIfNeeded(portOrTab: number | chrome.tabs.Tab, port: number) {
  let tab: chrome.tabs.Tab;
  if (typeof portOrTab === "number") {
    const wid = getWindowId(port);
    if (!wid) return;
    const [t] = await chrome.tabs.query({ active: true, windowId: wid });
    if (!t?.id) return;
    tab = t;
  } else {
    tab = portOrTab;
  }
  if (!tab.id || !isScriptableUrl(tab.url) || tabsWithInfoBox.has(tab.id)) return;
  tabsWithInfoBox.add(tab.id);
  const meta = portMeta.get(port);
  try {
    await forwardToContentScript(tab, {
      type: "show_instance_info",
      requestId: "info-" + Date.now(),
      label: meta?.label,
      port,
      host: meta?.host,
    });
  } catch { /* best-effort */ }
}

async function handleMcpMessage(msg: {
  type: string;
  requestId: string;
  [key: string]: unknown;
}, port: number): Promise<unknown> {
  switch (msg.type) {
    case "navigate": {
      // Navigation reloads the page, destroying any injected info box.
      // Clear the tracking so pushInstanceInfoIfNeeded re-injects after load.
      const preNavTab = getWindowId(port)
        ? (await chrome.tabs.query({ active: true, windowId: getWindowId(port)! }))[0]
        : null;
      if (preNavTab?.id) tabsWithInfoBox.delete(preNavTab.id);

      let targetTab: chrome.tabs.Tab;
      const targetUrl = msg.url as string;
      const blockNav = isBlockedUrl(targetUrl);
      if (blockNav.blocked) {
        throw new Error(blockNav.reason!);
      }
      const background = msg.background === true;

      // beforeunload protection: when navigating away from a same-tab page
      // that has unsaved content, Chrome's native "Are you sure you want to
      // leave?" dialog blocks navigation. setupBeforeunloadAutoDismiss
      // attaches a CDP listener that auto-accepts the dialog (i.e. "Leave")
      // so navigation goes through. dismissed_beforeunload in the response
      // reports when it fired so the caller knows the page HAD unsaved
      // content (and can choose to navigate back + recover if it cares).
      let beforeunloadCtx: Awaited<ReturnType<typeof setupBeforeunloadAutoDismiss>> | null = null;
      if (!msg.newTab) {
        const preActive = await getActiveTab(port);
        if (preActive.id && isScriptableUrl(preActive.url)) {
          beforeunloadCtx = await setupBeforeunloadAutoDismiss(preActive.id);
        }
      }

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
        // instead of "cross-site" — some sites serve a mobile / blocked SSR
        // response when hit with cross-site direct navigation.
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

      // Cleanup beforeunload protection now that navigation has settled.
      // We detach the debugger here (rather than holding it across the
      // settle check / anti-bot detection) so other handlers (click_element,
      // type_text) can attach freely without waiting.
      const dismissedBeforeunload = beforeunloadCtx
        ? (await beforeunloadCtx.release()).dismissed
        : false;

      // Settle check — beyond chrome.tabs status=complete, verify the page
      // is interactive (readyState=complete) AND no spinner/loading-state UI
      // is blocking the content (some SPA routes leave a permanent
      // .spinner-wrapper that the user can't recover from when the underlying
      // API request dies). If a expect_selector was passed, wait for it to
      // appear.
      //
      // Time-bounded at 6s so a genuinely-slow page doesn't hang the agent.
      // The probe returns whatever it observed; the caller decides whether
      // stuck_spinner is fatal.
      const expectSelector = msg.expect_selector as string | undefined;
      let stuckSpinner = false;
      let spinnerSelector: string | null = null;
      let currentUrl = targetUrl;
      let expectSelectorAppeared: boolean | null = expectSelector ? false : null;
      if (targetTab.id && isScriptableUrl(targetTab.url ?? targetUrl)) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            func: (expectSelector: string | undefined, timeoutMs: number) => {
              return new Promise<{
                stuck_spinner: boolean;
                spinner_selector: string | null;
                expect_selector_appeared: boolean | null;
                current_url: string;
              }>((resolve) => {
                const SPINNER_SELECTORS = [
                  '[aria-busy="true"]',
                  '.spinner-wrapper',
                  '[data-loading="true"]',
                  '[role="progressbar"]',
                  '.loading-spinner',
                  '.loader:not(.hidden)',
                ];
                function isVisible(el: Element): boolean {
                  const rect = (el as HTMLElement).getBoundingClientRect?.();
                  if (!rect || rect.width === 0 || rect.height === 0) return false;
                  const s = getComputedStyle(el);
                  return s.display !== "none" && s.visibility !== "hidden" && s.opacity !== "0";
                }
                function findSpinner(): string | null {
                  for (const sel of SPINNER_SELECTORS) {
                    const el = document.querySelector(sel);
                    if (el && isVisible(el)) return sel;
                  }
                  return null;
                }
                function expectSelectorPresent(): boolean {
                  if (!expectSelector) return true;
                  try { return !!document.querySelector(expectSelector); }
                  catch { return false; }
                }
                const start = Date.now();
                let lastMutationAt = Date.now();
                const observer = new MutationObserver(() => {
                  lastMutationAt = Date.now();
                });
                observer.observe(document, { subtree: true, childList: true, attributes: true });
                function tick() {
                  const ready = document.readyState === "complete";
                  const spinner = findSpinner();
                  const expectOk = expectSelectorPresent();
                  const quietEnough = Date.now() - lastMutationAt >= 250;
                  if (ready && !spinner && expectOk && quietEnough) {
                    observer.disconnect();
                    resolve({
                      stuck_spinner: false,
                      spinner_selector: null,
                      expect_selector_appeared: expectSelector ? true : null,
                      current_url: location.href,
                    });
                    return;
                  }
                  if (Date.now() - start >= timeoutMs) {
                    observer.disconnect();
                    resolve({
                      stuck_spinner: !!spinner,
                      spinner_selector: spinner,
                      expect_selector_appeared: expectSelector ? expectOk : null,
                      current_url: location.href,
                    });
                    return;
                  }
                  setTimeout(tick, 200);
                }
                tick();
              });
            },
            args: [expectSelector, 6000],
          });
          const res = r[0]?.result as { stuck_spinner: boolean; spinner_selector: string | null; expect_selector_appeared: boolean | null; current_url: string } | undefined;
          if (res) {
            stuckSpinner = res.stuck_spinner;
            spinnerSelector = res.spinner_selector;
            expectSelectorAppeared = res.expect_selector_appeared;
            currentUrl = res.current_url;
          }
        } catch { /* non-scriptable or unloaded — skip settle check */ }
      }

      // Anti-bot block-page detection: read the page's outerHTML (capped at
      // 200KB) and regex against the Tier-1 vendor patterns. Read-only
      // signal; no behaviour change. Field is null/absent when nothing
      // matches, which is the common case.
      let antiBotDetected: string | null = null;
      if (targetTab.id && isScriptableUrl(targetTab.url ?? targetUrl)) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id },
            func: () => document.documentElement.outerHTML.slice(0, 200_000),
          });
          const html = r[0]?.result as string | undefined;
          if (html) antiBotDetected = detectAntiBot(html);
        } catch { /* best-effort */ }
      }

      if (stuckSpinner || (expectSelector && expectSelectorAppeared === false)) {
        // Caller decides whether to navigate elsewhere — we don't auto-reload
        // because the same page might just need a few more seconds.
        return {
          type: "action_done",
          stuck_spinner: stuckSpinner,
          spinner_selector: spinnerSelector,
          expect_selector_appeared: expectSelectorAppeared,
          current_url: currentUrl,
          anti_bot_detected: antiBotDetected,
          dismissed_beforeunload: dismissedBeforeunload,
        };
      }
      await pushInstanceInfoIfNeeded(port, port);

      return {
        type: "action_done",
        current_url: currentUrl,
        anti_bot_detected: antiBotDetected,
        dismissed_beforeunload: dismissedBeforeunload,
      };
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
      // Re-read post-update so the response carries the actual landed URL
      // and title — useful when the agent wants to verify it switched to
      // the intended tab without a separate list_tabs round trip.
      const landed = await chrome.tabs.get(target.id).catch(() => target);
      return {
        type: "switch_to_tab_response",
        success: true,
        message: `Switched to tab matching "${msg.query}"`,
        url: landed?.url ?? target.url ?? "",
        title: landed?.title ?? target.title ?? "",
      };
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

    case "close_tab": {
      await getActiveTab(port);
      const wid = getWindowId(port)!;
      const allTabs = await chrome.tabs.query({ windowId: wid });
      const query = msg.query as string | undefined;

      let target: chrome.tabs.Tab | undefined;
      if (query === undefined) {
        // No query: close the active tab.
        target = allTabs.find(t => t.active);
      } else {
        const lower = query.toLowerCase();
        const byIndex = parseInt(query, 10);
        if (!isNaN(byIndex)) {
          target = allTabs[byIndex - 1];
        } else {
          target = allTabs.find(
            (t) =>
              (t.url ?? "").toLowerCase().includes(lower) ||
              (t.title ?? "").toLowerCase().includes(lower)
          );
        }
      }
      if (!target?.id) {
        const list = allTabs.map((t, i) => `${i + 1}. ${t.title} — ${t.url}`).join("\n");
        return { type: "action_done", message: `No tab matching "${query ?? "(active)"}". Open tabs:\n${list}` };
      }
      const snapshot = { index: allTabs.indexOf(target) + 1, title: target.title ?? "", url: target.url ?? "" };
      // Attach the beforeunload auto-dismiss BEFORE chrome.tabs.remove, so the
      // dialog gets accepted automatically if the target tab has unsaved
      // form state (Reddit composer with typed text is the canonical trigger).
      // Without this, chrome.tabs.remove blocks on the native Leave site
      // dialog and the WS bridge times out at 30s.
      const closeCtx = isScriptableUrl(target.url)
        ? await setupBeforeunloadAutoDismiss(target.id)
        : null;
      await chrome.tabs.remove(target.id);
      const closeDismissed = closeCtx ? (await closeCtx.release()).dismissed : false;
      return { type: "action_done", closed: [snapshot], dismissed_beforeunload: closeDismissed };
    }

    case "close_other_tabs": {
      await getActiveTab(port);
      const wid = getWindowId(port)!;
      const allTabs = await chrome.tabs.query({ windowId: wid });
      const keepQuery = msg.keep_query as string | undefined;
      const keepLower = keepQuery?.toLowerCase();

      // Determine which tabs to keep. Either matches keep_query, or active when no query.
      const kept: chrome.tabs.Tab[] = [];
      const toClose: chrome.tabs.Tab[] = [];
      for (const t of allTabs) {
        const matchesKeep = keepLower
          ? (t.url ?? "").toLowerCase().includes(keepLower) || (t.title ?? "").toLowerCase().includes(keepLower)
          : !!t.active;
        if (matchesKeep) kept.push(t);
        else toClose.push(t);
      }

      // Refuse to close ALL tabs — Chrome will close the window. Keep the
      // active tab as a safety floor.
      if (kept.length === 0) {
        const active = allTabs.find(t => t.active);
        if (active) {
          kept.push(active);
          const idx = toClose.indexOf(active);
          if (idx >= 0) toClose.splice(idx, 1);
        }
      }

      const closedSnapshot = toClose.map(t => ({ index: allTabs.indexOf(t) + 1, title: t.title ?? "", url: t.url ?? "" }));
      const keptSnapshot = kept.map(t => ({ index: allTabs.indexOf(t) + 1, title: t.title ?? "", url: t.url ?? "" }));
      const closeIds = toClose.map(t => t.id).filter((id): id is number => id !== undefined);
      // Attach beforeunload auto-dismiss to every closing tab in parallel so
      // none of them hang on a native Leave site dialog (typically Reddit /
      // Gmail / Discord composers with unsaved text). Non-scriptable URLs
      // (chrome://, about:, file:// without permission) can't have a dialog
      // anyway, so we skip them.
      const protections = await Promise.all(
        toClose
          .filter(t => t.id !== undefined && isScriptableUrl(t.url))
          .map(async t => ({ tabId: t.id!, ctx: await setupBeforeunloadAutoDismiss(t.id!) }))
      );
      if (closeIds.length > 0) await chrome.tabs.remove(closeIds);
      const dismissedTabIndexes: number[] = [];
      for (const p of protections) {
        const r = await p.ctx.release();
        if (r.dismissed) {
          const idx = toClose.findIndex(t => t.id === p.tabId);
          if (idx >= 0) dismissedTabIndexes.push(closedSnapshot[idx].index);
        }
      }
      return {
        type: "action_done",
        closed: closedSnapshot,
        kept: keptSnapshot,
        dismissed_beforeunload_tabs: dismissedTabIndexes,
      };
    }

    case "screenshot": {
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

    case "start_click_watch": {
      const timeout = (msg.timeout as number) ?? 120_000;
      const redispatch = msg.redispatch === true;
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

        const finish = (result: ClickWatchResult) => {
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

        pendingClicks.set(msg.requestId, { port, redispatch, cb: finish });

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
                // Shadow-piercing query: walks open AND closed shadow roots
                // (via chrome.dom.openOrClosedShadowRoot when available in
                // isolated-world content scripts) so selectors for elements
                // inside web components (Lit, Stencil, Radix portals,
                // Reddit's faceplate-* web components) are found without
                // needing a shadow-DOM-aware caller.
                const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
                function getShadowRoot(el: Element): ShadowRoot | null {
                  if (chromeDom?.openOrClosedShadowRoot) {
                    try {
                      const sr = chromeDom.openOrClosedShadowRoot(el);
                      if (sr) return sr;
                    } catch { /* fall through */ }
                  }
                  return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
                }
                function findFirst(root: Document | Element | ShadowRoot): Element | null {
                  const direct = root.querySelector(sel);
                  if (direct) return direct;
                  for (const el of Array.from(root.querySelectorAll<Element>("*"))) {
                    const sr = getShadowRoot(el);
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
                  return getShadowRoot(found) != null;
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
      // Resolve target tab: tab_query lets the caller target a tab without
      // focus-switching. Used by self-rescheduling loops where the active tab
      // may have drifted while the user was AFK.
      const tabQuery = msg.tab_query as string | undefined;
      let tab: chrome.tabs.Tab;
      if (tabQuery) {
        await getActiveTab(port);
        const wid = getWindowId(port)!;
        const allTabs = await chrome.tabs.query({ windowId: wid });
        const lower = tabQuery.toLowerCase();
        const byIndex = parseInt(tabQuery, 10);
        const match = !isNaN(byIndex)
          ? allTabs[byIndex - 1]
          : allTabs.find((t) => (t.url ?? "").toLowerCase().includes(lower) || (t.title ?? "").toLowerCase().includes(lower));
        if (!match?.id) {
          const list = allTabs.map((t, i) => `${i + 1}. ${t.title} — ${t.url}`).join("\n");
          throw new Error(`tab_query "${tabQuery}" matched no tab. Open tabs:\n${list}`);
        }
        tab = match;
      } else {
        tab = await getActiveTab(port);
      }
      if (!isScriptableUrl(tab.url)) {
        throw new Error(`Cannot execute script on ${tab.url}`);
      }
      const code = msg.code as string;
      let tabId = tab.id!;
      let reauthorized = false;
      const beforeUrl = tab.url ?? "";

      // Race a chrome.scripting / chrome.debugger call against a tab-navigation
      // listener. If the page navigates away mid-script, the chrome APIs can
      // hang indefinitely (sync `location.href` = ... followed by `await` is
      // the canonical case). The listener rejects with a Frame-removed-shaped
      // error so the existing catch routes it to the [navigated] response.
      const raceWithNavigation = async <T>(p: Promise<T>): Promise<T> => {
        let listener: ((id: number, info: chrome.tabs.TabChangeInfo) => void) | null = null;
        const navPromise = new Promise<never>((_, reject) => {
          listener = (id, info) => {
            if (id === tabId && info.url && info.url !== beforeUrl) {
              reject(new Error("Frame removed — page navigated during script execution"));
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
        try {
          return await Promise.race([p, navPromise]);
        } finally {
          if (listener) chrome.tabs.onUpdated.removeListener(listener);
        }
      };

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

      // Shadow-DOM-piercing helpers ($deep, $deepAll, shadowDocument) are
      // injected into the user's script via a wrapper that declares them as
      // local variables of an IIFE. Direct eval inside the IIFE sees the
      // locals, so `$deep('button')` works without polluting window.* on
      // the page.
      //
      // Open shadow roots only — MAIN world can't reach
      // chrome.dom.openOrClosedShadowRoot. For closed roots, callers should
      // use find_text / get_page_text / click_element / fill_input which DO
      // pierce both kinds via the content-script API.
      const SHADOW_HELPERS = `
        var $deep = function(selector, root) {
          root = root || document;
          var direct = root.querySelector(selector);
          if (direct) return direct;
          var all = root.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) {
              var nested = $deep(selector, all[i].shadowRoot);
              if (nested) return nested;
            }
          }
          return null;
        };
        var $deepAll = function(selector, root) {
          root = root || document;
          var out = [];
          var seen = new WeakSet();
          var recurse = function(r) {
            var matches = r.querySelectorAll(selector);
            for (var i = 0; i < matches.length; i++) {
              if (!seen.has(matches[i])) { seen.add(matches[i]); out.push(matches[i]); }
            }
            var all = r.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              if (all[i].shadowRoot) recurse(all[i].shadowRoot);
            }
          };
          recurse(root);
          return out;
        };
        var shadowDocuments = (function() {
          var roots = [];
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) roots.push(all[i].shadowRoot);
          }
          return roots;
        })();
        var shadowDocument = (function() {
          if (shadowDocuments.length === 0) return document;
          if (shadowDocuments.length === 1) return shadowDocuments[0];
          var best = shadowDocuments[0];
          var bestScore = 0;
          for (var i = 0; i < shadowDocuments.length; i++) {
            var sr = shadowDocuments[i];
            var score = sr.querySelectorAll('button, input, select, textarea, a, [role="button"], [role="radio"], [role="checkbox"], [role="link"], [contenteditable]').length;
            if (score > bestScore) { bestScore = score; best = sr; }
          }
          return bestScore > 0 ? best : shadowDocuments[0];
        })();
      `;

      const runInjection = () => chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (code: string, usesAwait: boolean, shadowHelpers: string) => {
          let result: unknown;
          // Build a single source string that declares $deep/$deepAll/
          // shadowDocument as locals of an IIFE, then runs the user code
          // inside that IIFE. Direct eval inside the IIFE picks up the
          // helpers without leaking them onto window.
          //
          // For non-await: try direct eval first (expression returns work)
          // and fall back to a wrapping function on "Illegal return".
          // For await: always wrap as async IIFE since top-level await
          // only makes sense inside an async function anyway.
          const wrap = (body: string) => `(function() { ${shadowHelpers}; return (function() { ${body} })(); })()`;
          const wrapAsync = (body: string) => `(async function() { ${shadowHelpers}; return await (async function() { ${body} })(); })()`;
          // Expression form: helpers declared in an outer IIFE, user code
          // evaluated via direct eval to allow `42` / `document.title`-style
          // returns. var declarations inside indirect eval would leak globally;
          // direct eval inside the IIFE scopes them to the IIFE.
          const wrapExpr = `(function() { ${shadowHelpers}; return eval(${JSON.stringify(code)}); })()`;
          try {
            if (usesAwait) {
              result = await (0, eval)(wrapAsync(code));
            } else {
              result = (0, eval)(wrapExpr);
            }
          } catch (e) {
            if (String(e).includes("Illegal return")) {
              try {
                if (usesAwait) {
                  result = await (0, eval)(wrapAsync(code));
                } else {
                  result = (0, eval)(wrap(code));
                }
              } catch (e2) {
                result = `Error: ${e2}`;
              }
            } else {
              result = `Error: ${e}`;
            }
          }
          // Auto-stringify objects so callers don't have to wrap every return
          // in JSON.stringify themselves. Strings, numbers, booleans, null,
          // undefined all pass through String(). Arrays and objects become
          // JSON; circular refs fall back to String() (which yields
          // "[object Object]" but that's the documented behavior for circular
          // structures the caller would have hit anyway).
          let serialized: string;
          if (result === null || result === undefined) {
            serialized = "undefined";
          } else if (typeof result === "object") {
            try {
              serialized = JSON.stringify(result);
            } catch {
              serialized = String(result);
            }
          } else {
            serialized = String(result);
          }
          const captured = (window as any)._alertCapture ?? null;
          if (captured) (window as any)._alertCapture = null;
          return JSON.stringify({ result: serialized, alert: captured });
        },
        args: [code, usesAwait, SHADOW_HELPERS],
      });

      try {
        let results;
        try {
          results = await raceWithNavigation(runInjection());
        } catch (e) {
          const errStr = String(e);
          if (errStr.includes("Cannot access contents of the page") || errStr.includes("Extension manifest must request permission")) {
            // Idle tab lost host access (Chrome silently revokes after long
            // periods, navigation between origin variants, etc). Reload the
            // tab once to re-attach the content script, then retry.
            await new Promise<void>((resolve) => {
              const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
                if (id === tabId && info.status === "complete") {
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
              chrome.tabs.reload(tabId).catch(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              });
              setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }, 15_000);
            });
            reauthorized = true;
            results = await raceWithNavigation(runInjection());
          } else {
            throw e;
          }
        }
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
        } else if (
          /Frame with ID \d+ was removed/i.test(errStr)
          || errStr.includes("No frame with id")
          || errStr.includes("page navigated during script execution")
        ) {
          // Page navigated during script execution. The script's effects may
          // or may not have completed; surface as a non-error signal so the
          // caller can verify post-navigation state rather than treating
          // this as a hard failure.
          return {
            type: "script_response",
            requestId: msg.requestId,
            result: "[navigated]",
            alert: null,
            context: "main" as const,
            navigated: true,
            reauthorized: reauthorized || undefined,
          };
        } else {
          throw e;
        }
      }

      // CSP blocked eval: fall back to CDP Runtime.evaluate which bypasses CSP.
      // Race against a configurable timeout (default 30s) to prevent hung scripts
      // from locking the debugger indefinitely ("Another debugger is already
      // attached" on every subsequent call until the tab is refreshed).
      const scriptTimeoutMs = (msg.timeout_ms as number | undefined) ?? 30000;
      if (cspBlocked) {
        try {
          await raceWithNavigation(withDebugger(tabId, async () => {
            const dbg = chrome.debugger as unknown as {
              sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
            };
            const SERIALIZER = `function(__r) {
              if (__r === null || __r === undefined) return "undefined";
              if (typeof __r === "object") {
                try { return JSON.stringify(__r); } catch (e) { return String(__r); }
              }
              return String(__r);
            }`;
            const wrappedCode = usesAwait
              ? `(async () => {
                  var __serialize = ${SERIALIZER};
                  ${SHADOW_HELPERS}
                  var __result;
                  try { __result = await (async () => { ${code} })(); }
                  catch(e) { __result = "Error: " + e; }
                  var __alert = window._alertCapture || null;
                  if (__alert) window._alertCapture = null;
                  return JSON.stringify({ result: __serialize(__result), alert: __alert });
                })()`
              : `(function() {
                  var __serialize = ${SERIALIZER};
                  ${SHADOW_HELPERS}
                  var __result;
                  try { __result = eval(${JSON.stringify(code)}); }
                  catch(e) {
                    if (String(e).includes("Illegal return")) {
                      try { __result = (function() { ${code} })(); }
                      catch(e2) { __result = "Error: " + e2; }
                    } else { __result = "Error: " + e; }
                  }
                  var __alert = window._alertCapture || null;
                  if (__alert) window._alertCapture = null;
                  return JSON.stringify({ result: __serialize(__result), alert: __alert });
                })()`;
            const evalPromise = dbg.sendCommand({ tabId }, "Runtime.evaluate", {
              expression: wrappedCode,
              returnByValue: true,
              allowUnsafeEvalBlockedByCSP: true,
              awaitPromise: usesAwait,
            });
            const evalResult = await Promise.race([
              evalPromise,
              new Promise<never>((_, reject) => setTimeout(async () => {
                try { await dbg.sendCommand({ tabId }, "Runtime.terminateExecution"); } catch { /* best-effort */ }
                reject(new Error(`execute_script timed out after ${scriptTimeoutMs}ms. Script execution was terminated and the debugger will be released. Retry the call; no page refresh needed.`));
              }, scriptTimeoutMs)),
            ]) as { result: { value?: string }; exceptionDetails?: unknown };
            try {
              const parsed = JSON.parse(evalResult.result.value ?? "{}");
              result = parsed.result ?? "undefined";
              alertMsg = parsed.alert ?? null;
            } catch {
              result = String(evalResult.result.value ?? "undefined");
            }
          }));
        } catch (e) {
          const errStr = String((e as { message?: string })?.message ?? e);
          if (
            /Frame with ID \d+ was removed/i.test(errStr)
            || errStr.includes("No frame with id")
            || errStr.includes("Inspected target navigated or closed")
            || errStr.includes("target closed")
            || errStr.includes("page navigated during script execution")
          ) {
            return {
              type: "script_response",
              requestId: msg.requestId,
              result: "[navigated]",
              alert: null,
              context: "main" as const,
              navigated: true,
              reauthorized: reauthorized || undefined,
            };
          }
          throw e;
        }
      }

      return {
        type: "script_response",
        requestId: msg.requestId,
        result,
        alert: alertMsg,
        context: "main" as const,
        reauthorized: reauthorized || undefined,
      };
    }

    case "click_element": {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      const before_url = tab.url ?? "";

      // Phase 1: ask content script to find, scroll, and tag the element,
      // returning its viewport coordinates (with small jitter).
      // Retry up to 3 times with 500ms gap. Elements briefly disappear during
      // a React re-render and a single attempt fails; a short retry loop
      // turns those into successful clicks instead of 30s timeouts.
      type PrepResult = {
        success: boolean;
        message: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        label?: string;
        skipClick?: boolean;
        nextCandidate?: string;
        scope_missed?: boolean;
        target_disabled?: boolean;
        disabled_state?: {
          disabled: boolean;
          aria_disabled: string | null;
          pointer_events: string;
          opacity: string;
          visible: boolean;
        };
      };
      // via:"fiber" skips the CDP click entirely and goes straight to React
      // fiber prop invocation. Use when the caller already knows the site is
      // React-fiber-only and wants to skip ~3 seconds of bezier-ceremony +
      // activity probe. via:"cdp" is the historical default — no fiber
      // fallback ever fires. via:"auto" (default) does CDP first, then fiber
      // when try_fiber=true was also set and activity probe failed.
      const via = (msg.via as "auto" | "cdp" | "fiber" | undefined) ?? "auto";

      if (via === "fiber") {
        const fiberResult = await forwardToContentScript(tab, {
          type: "react_fiber_click",
          requestId: msg.requestId + "-fiber-only",
          textHint: msg.textHint,
          nth: msg.nth,
          within_selector: msg.within_selector,
          near_text: msg.near_text,
          in_dialog: msg.in_dialog,
          dialog_query: msg.dialog_query,
        }).catch((e) => ({ success: false, message: String(e), fired: false })) as {
          success: boolean; message: string; fired: boolean; component?: string; label?: string;
        };
        const [postTabF] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
        const afterUrlF = postTabF?.url ?? before_url;
        return {
          type: "click_element_response",
          success: fiberResult.success,
          message: fiberResult.message,
          before_url,
          after_url: afterUrlF,
          navigated: afterUrlF !== before_url,
          fiber_attempted: true,
        };
      }

      let prep: PrepResult | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        prep = await forwardToContentScript(tab, {
          type: "prepare_click_target",
          requestId: msg.requestId,
          textHint: msg.textHint,
          selector: msg.selector,
          nth: msg.nth,
          within_selector: msg.within_selector,
          near_text: msg.near_text,
          in_dialog: msg.in_dialog,
          dialog_query: msg.dialog_query,
        }) as PrepResult;
        if (prep.success) break;
        // Don't retry when the scope itself was missing — it won't appear on a 500ms delay.
        if (prep.scope_missed) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }

      if (!prep || !prep.success) {
        return { type: "click_element_response", success: false, message: prep?.message ?? "click failed", before_url, after_url: before_url, navigated: false, scope_missed: prep?.scope_missed };
      }

      // Pre-flight skip: matched element resolved to an already-checked radio.
      // The page is already in the desired state, so firing the click would
      // toggle it OFF on React-controlled forms.
      if (prep.skipClick) {
        return { type: "click_element_response", success: true, message: prep.message, before_url, after_url: before_url, navigated: false };
      }

      // Pre-flight disabled handling. When the resolved match is disabled and
      // the caller supplied wait_until_enabled_ms, poll prepareClickTarget
      // briefly. Many "Submit" buttons go from disabled (validating) to enabled
      // within ~1s; this avoids the agent re-reading state mid-async via
      // execute_script and chasing a phantom missing field.
      //
      // When wait_until_enabled_ms is 0 (default) OR the wait times out, return
      // a structured target_disabled response with the full signal snapshot so
      // the agent can read disabled / aria-disabled / pointer-events / opacity
      // in one call instead of four separate execute_script reads.
      const waitUntilEnabledMs = (msg.wait_until_enabled_ms as number | undefined) ?? 0;
      if (prep.target_disabled && waitUntilEnabledMs > 0) {
        const start = Date.now();
        // Re-poll every 250ms. The first poll already happened above; start
        // the wait loop with a delay so we don't immediately re-issue.
        while (Date.now() - start < waitUntilEnabledMs) {
          await new Promise((r) => setTimeout(r, 250));
          const reprep = await forwardToContentScript(tab, {
            type: "prepare_click_target",
            requestId: msg.requestId + "-enabledpoll",
            textHint: msg.textHint,
            selector: msg.selector,
            nth: msg.nth,
            within_selector: msg.within_selector,
            near_text: msg.near_text,
            in_dialog: msg.in_dialog,
            dialog_query: msg.dialog_query,
          }) as PrepResult;
          if (reprep.success && !reprep.target_disabled) {
            prep = reprep;
            prep.message = `Target became enabled after ${Date.now() - start}ms wait. ${prep.message}`;
            break;
          }
        }
      }
      if (prep.target_disabled) {
        const ds = prep.disabled_state;
        return {
          type: "click_element_response",
          success: false,
          message: `Refusing to click "${prep.label ?? msg.textHint}" — element is disabled (disabled=${ds?.disabled}, aria-disabled=${ds?.aria_disabled ?? "null"}, pointer-events=${ds?.pointer_events}, opacity=${ds?.opacity}). If the disable is transient (mid-async-validate), retry with wait_until_enabled_ms=3000. If permanent, run get_form_fields(only_empty:true) to surface required-but-empty fields.`,
          before_url,
          after_url: before_url,
          navigated: false,
          target_disabled: true,
          disabled_state: ds,
        };
      }

      // Pre-flight refusal: matched element is 0×0 (display:none, off-DOM, or
      // a render-time race). A click at coords inside a 0×0 element doesn't
      // dispatch any useful event and any until_* clause is guaranteed to
      // time out (5s wasted per call). Better to fail fast with a clear
      // message so the caller can wait for visibility first.
      //
      // When the caller did NOT pin a specific nth and the matcher found a
      // visible peer, auto-advance to it before refusing — the most common
      // case is a duplicated label on a card grid where the hidden detail-
      // panel copy outranks the visible card. Respect explicit nth: if the
      // user pinned the 3rd "Confirmed" radio, we shouldn't silently
      // re-resolve to the 2nd one.
      if (prep.width === 0 && prep.height === 0) {
        const label = prep.label ?? msg.textHint;
        const nthExplicit = typeof msg.nth === "number" && (msg.nth as number) >= 1;
        if (!nthExplicit && prep.nextCandidate) {
          const reprep = await forwardToContentScript(tab, {
            type: "prepare_click_target",
            requestId: msg.requestId + "-advance",
            textHint: msg.textHint,
            selector: msg.selector,
            // Skip the hidden first match by asking for nth=2 — findClickableAll
            // ranks visible candidates before hidden ones, so nth=2 lands on
            // the first visible peer (or a later visible candidate if there
            // are multiple hidden ones in front).
            nth: 2,
            within_selector: msg.within_selector,
            near_text: msg.near_text,
            in_dialog: msg.in_dialog,
            dialog_query: msg.dialog_query,
          }) as PrepResult;
          if (reprep.success && reprep.width !== 0 && reprep.height !== 0) {
            // Replace prep so the rest of the flow uses the visible candidate.
            prep = reprep;
            prep.message = `Auto-advanced from hidden first match for "${msg.textHint}" → visible candidate "${prep.label ?? msg.textHint}". ${prep.message}`;
          } else {
            return {
              type: "click_element_response",
              success: false,
              message: `Matched element "${label}" is 0×0 (hidden, display:none, or not yet rendered) and the next visible candidate (${prep.nextCandidate}) couldn't be re-resolved. Retry without nth=, with a different nth, or with a more specific textHint.`,
              before_url,
              after_url: before_url,
              navigated: false,
            };
          }
        } else {
          const nextSuggestion = prep.nextCandidate
            ? ` Next visible candidate: ${prep.nextCandidate}. Retry without nth=, with a different nth, or with a more specific textHint.`
            : ` No visible candidates matched "${msg.textHint}".`;
          return {
            type: "click_element_response",
            success: false,
            message: `Matched element "${label}" is 0×0 (hidden, display:none, or not yet rendered). Refusing to click — a click at this size would dispatch no useful event.${nextSuggestion}`,
            before_url,
            after_url: before_url,
            navigated: false,
          };
        }
      }

      // Phase 2: dispatch the click via CDP (isTrusted=true events) if possible.
      // On isTrusted-strict sites, synthetic clicks are ignored but
      // CDP-dispatched events pass. Falls back to the content script's
      // synthetic-click path on chrome:// pages or debugger failure.
      //
      // ANTI-BOT BYPASS: stricter Web Components (Reddit's faceplate-*, Twitter's
      // tweet composer, etc.) check `event instanceof PointerEvent && event.isPrimary`
      // in addition to isTrusted. The default Input.dispatchMouseEvent fires only
      // MouseEvent, NOT PointerEvent. We pass pointerType="mouse" which makes
      // Chrome fire PointerEvent alongside (isPrimary=true, pointerId=1, plus
      // a realistic pressure value via `force`). Combined with the bezier
      // trajectory, settle hover, and post-click jitter, this passes
      // every behavioral check we've seen short of OS-level input.
      //
      // BEFOREUNLOAD HANG FIX (0.10.22): wrap from here through the entire
      // fallback chain + until-poll in a single outer withDebugger attach so
      // a Page.javascriptDialogOpening listener registered here stays armed
      // for the whole flow. Reddit's submit redirect fires "Leave site?" 1-2s
      // post-click, well after dispatchHumanMouseClick's own withDebugger
      // would have detached — hangs the tab if the listener is gone.
      // via === "fiber" returned early above, so by here via is "auto" or "cdp"
      // and CDP is always allowed when canCdp is true.
      const canCdp = isScriptableUrl(tab.url) && typeof prep.x === "number" && typeof prep.y === "number";

      const runClickFlow = async (): Promise<unknown> => {
      let result: { success: boolean; message: string };
      let usedCdp = false;
      const activityTimeoutMs = (msg.activity_timeout_ms as number | undefined) ?? 1500;
      // The probe is implicitly skipped when an until-clause is set (the until
      // poll IS the verification) or the caller passes skip_activity_probe.
      // Compute this here, BEFORE the click, so we can skip the expensive
      // pre-click snapshotVisibleCount baseline walk. On a heavy Outlier-class
      // page this deep walk costs 50-150ms per click; wasting it when the
      // probe won't run accounts for a measurable chunk of perceived slowness.
      const willSkipProbe =
        msg.skip_activity_probe === true ||
        !!(msg.until_selector || msg.until_url_contains || msg.until_text_contains || msg.until_url_changes);
      // Snapshot the shadow-pierce visible-element count BEFORE dispatching
      // the click, so the activity probe has a baseline that pre-dates any
      // synchronous Lit / Stencil render the click might trigger. See
      // snapshotVisibleCount jsdoc for why this can't be deferred to inside
      // the probe.
      const preClickVisibleCount = canCdp && tab.id && !willSkipProbe
        ? await snapshotVisibleCount(tab.id).catch(() => null)
        : null;
      let cdpPhaseError: string | null = null;
      if (canCdp) {
        try {
          // Per-phase budget: bezier + settle + press/release usually completes
          // in well under 2s. Cap at 8s so a hung CDP attach reports the phase
          // explicitly instead of dragging the whole click to the 30s WS cap.
          await phaseRace("cdp_click", 8000, dispatchHumanMouseClick(tabId, Math.round(prep.x!), Math.round(prep.y!)));
          usedCdp = true;
        } catch (e) {
          const err = e as Error & { phase?: string; phaseTimedOut?: boolean };
          if (err.phaseTimedOut) cdpPhaseError = err.phase ?? "cdp_click";
          // Either CDP attach failed (fall through to synthetic) or the
          // phase exceeded its budget (record so the response carries it).
        }
      }

      // Phase 3: inspect post-click state (radio/checkbox check state, 0×0 warnings)
      // and untag. Best-effort — skip if the click caused navigation.
      let postNote = "";
      // Structured record of which fallback (if any) actually fired, so the MCP
      // server's flow-memory can tell a hard-won click apart from a trivial one
      // without parsing the free-text message.
      let recoveredVia = "";
      let postClickStateChanged = false;
      try {
        const post = await forwardToContentScript(tab, {
          type: "post_click_inspect",
          requestId: msg.requestId + "-post",
        }) as { message?: string; stateChanged?: boolean };
        postNote = post.message ?? "";
        postClickStateChanged = post.stateChanged === true;
      } catch { /* page may have navigated away */ }

      if (usedCdp) {
        result = { success: true, message: `Clicked "${prep.label ?? msg.textHint}"${postNote}` };
      } else if (cdpPhaseError) {
        // CDP phase hit its budget. Try the content-script synthetic click
        // as a graceful fallback, but tag the message so the agent sees the
        // CDP path didn't run. Helps diagnose "click_element succeeded but
        // looks like a synthetic click" cases.
        try {
          result = await forwardToContentScript(tab, msg) as { success: boolean; message: string };
          result.message = `${result.message} (CDP phase "${cdpPhaseError}" timed out; used synthetic click fallback)`;
        } catch {
          return {
            type: "click_element_response",
            success: false,
            message: `Clicked "${prep.label ?? msg.textHint}" failed: CDP phase "${cdpPhaseError}" exceeded its budget and the synthetic-click fallback also failed. Likely a hung debugger session or a tab whose content script was evicted.`,
            before_url,
            after_url: before_url,
            navigated: false,
            phase_timed_out: cdpPhaseError,
          };
        }
      } else {
        // Fallback: content-script synthetic click (isTrusted=false).
        try {
          result = await forwardToContentScript(tab, msg) as { success: boolean; message: string };
        } catch (e) {
          const errStr = String(e);
          if (/Frame with ID \d+ was removed/i.test(errStr) || errStr.includes("No frame with id")) {
            // Click triggered navigation mid-handler — treat as success.
            result = { success: true, message: `Clicked "${prep.label ?? msg.textHint}" — page navigated during click` };
          } else {
            throw e;
          }
        }
        if (!result.success) {
          const [postFailTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
          const after_url = postFailTab?.url ?? before_url;
          return { type: "click_element_response", success: false, message: result.message, before_url, after_url, navigated: after_url !== before_url };
        }
      }

      // Implicit skip_activity_probe when an until-clause was set. The until
      // clause IS the verification: it polls for selector/text/URL appearance
      // for up to until_timeout_ms (default 5s). Running the activity probe
      // in addition produces false negatives on slow async submits (Reddit
      // post submit takes 2-3s before the page redirects, the probe times
      // out at 1500ms and reports silently_rejected), and the fallback chain
      // (tap gesture, pointer chain, DOM .click()) fires duplicate events on
      // the SAME button that the original click already hit — which on
      // Reddit gets deduped and on other sites can double-submit forms.
      const hasUntilClause = !!(
        msg.until_selector || msg.until_url_contains ||
        msg.until_text_contains || msg.until_url_changes
      );
      // postClickStateChanged is set when post_click_inspect confirmed a
      // radio/checkbox toggled state. That's a direct observation of click
      // success — running the activity probe in addition produces false
      // negatives on form inputs whose state change doesn't trigger DOM
      // mutations (Reddit's faceplate-radio-input is the canonical case).
      const effectiveSkipProbe =
        msg.skip_activity_probe === true ||
        hasUntilClause ||
        postClickStateChanged;

      if (msg.skip_activity_probe && usedCdp) {
        result.message += " (activity probe skipped; verify state manually)";
      }

      // Fast-fail probe: watch the page for ANY observable activity in the
      // 1500ms after dispatch. When 0 activity is detected, the click was
      // almost certainly silently rejected by anti-bot detection.
      //
      // Returns early as soon as activity is detected, so most clicks add
      // only ~100ms before continuing to the until-poll / expect_submit flow.
      const probeBudgetMs = activityTimeoutMs + 2000;
      const probeSkipReason = postClickStateChanged
        ? "(probe skipped: post-click state change already confirmed)"
        : hasUntilClause
          ? "(probe skipped: until-clause verifies)"
          : "(probe skipped)";
      // Cleanup helper: postClickInspect no longer removes the click-target
      // marker because the activity probe needs it to read post-click state.
      // Untag after all probes and fallbacks finish. Shadow-piercing because
      // the tagged element may live inside a closed shadow root.
      const untagClickTarget = async () => {
        if (!isScriptableUrl(tab.url) || !tab.id) return;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (markerAttr: string) => {
              const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
              function getShadowRoot(el: Element): ShadowRoot | null {
                if (chromeDom?.openOrClosedShadowRoot) {
                  try { const sr = chromeDom.openOrClosedShadowRoot(el); if (sr) return sr; } catch { /* ignore */ }
                }
                return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
              }
              const stack: (Document | ShadowRoot)[] = [document];
              while (stack.length) {
                const root = stack.pop()!;
                root.querySelectorAll(`[${markerAttr}]`).forEach((el) => el.removeAttribute(markerAttr));
                root.querySelectorAll("*").forEach((el) => {
                  const sr = getShadowRoot(el);
                  if (sr) stack.push(sr);
                });
              }
            },
            args: [markerIds.clickTargetAttr()],
          });
        } catch { /* best-effort */ }
      };

      // Fallback probe budget. Each step in the fallback chain re-runs the
      // activity probe — and on a heavy antibot page where every step
      // silently_rejects, the cumulative probe wait was 5x activityTimeoutMs
      // (~7.5s on the default). Fallback probes only need a quick "did THIS
      // alternate dispatch fire" answer — successful fallbacks tend to show
      // activity within ~300-500ms. Cap each fallback at min(800,
      // activityTimeoutMs) so worst-case fallback-chain probe wait is
      // ~3.2s instead of ~6s, with no measured loss in success detection.
      const fallbackProbeTimeoutMs = Math.min(800, activityTimeoutMs);
      const probe = effectiveSkipProbe
        ? { activity: true, reason: probeSkipReason, mutation_count: 0, url_changed: false, after_url: before_url, focused_after: null } as ActivityProbeResult
        : isScriptableUrl(tab.url) && tab.id
        ? await phaseRace("activity_probe", probeBudgetMs, runActivityProbe(tab.id, before_url, activityTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr())).catch((e) => {
            const err = e as Error & { phase?: string };
            return {
              activity: true,
              reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
              mutation_count: 0,
              url_changed: false,
              after_url: before_url,
              focused_after: null,
            } as ActivityProbeResult;
          })
        : ({ activity: true, reason: "(non-scriptable; probe skipped)", mutation_count: 0, url_changed: false, after_url: before_url, focused_after: null } as ActivityProbeResult);

      if (!probe.activity) {
        // First-line automatic fallback when the primary CDP click had
        // valid coordinates: re-dispatch as a CDP synthesizeTapGesture.
        // This is also isTrusted=true (same trust level as the primary)
        // but the auto-generated click event carries isPrimary=true on
        // the click stage — dispatchHumanMouseClick's click stage gets
        // isPrimary=false because Chromium derives the click from the
        // already-released pointer. Reddit's faceplate-* Lit components
        // gate on `event.isTrusted && event.isPrimary` on the click event
        // (most visibly the new-post flair button), and that combination
        // is exactly what the tap gesture satisfies.
        if (
          canCdp &&
          typeof prep.x === "number" &&
          typeof prep.y === "number" &&
          tab.id
        ) {
          try {
            await phaseRace(
              "tap_gesture_fallback",
              3500,
              dispatchTapGesture(tabId, Math.round(prep.x), Math.round(prep.y)),
            );
            const probeTap = await phaseRace(
              "activity_probe_tap_fallback",
              3500,
              runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr()),
            ).catch((e) => {
              const err = e as Error & { phase?: string };
              return {
                activity: true,
                reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
                mutation_count: 0,
                url_changed: false,
                after_url: before_url,
                focused_after: null,
              } as ActivityProbeResult;
            });
            if (probeTap.activity) {
              postNote += ` (fired via CDP synthesizeTapGesture after dispatchMouseEvent silently_rejected)`;
              recoveredVia = "tap-gesture";
              probe.activity = true;
              probe.after_url = probeTap.after_url;
              probe.focused_after = probeTap.focused_after;
              probe.mutation_count = probeTap.mutation_count;
              probe.url_changed = probeTap.url_changed;
            }
          } catch {
            // synthesizeTapGesture failed (older Chrome, debugger detached).
            // Fall through to the DOM .click() path below.
          }
        }
      }

      if (!probe.activity) {
        // Keyboard activation fallback. Reddit's <faceplate-*> web
        // components (flair button, comment composer expand) and similar
        // strict gates check something beyond isTrusted=true on the click
        // event — likely the activation provenance. CDP mouse events count
        // as trusted but get rejected anyway. Dispatching a CDP keyboard
        // Enter on the focused element activates the button via the
        // browser's native keyboard activation path, which bypasses any
        // mouse-event source checks the page added.
        //
        // Focuses the tagged element via execute_script (ISOLATED world so
        // the marker attribute resolves), then dispatches Input.dispatchKeyEvent
        // for Enter. Buttons and most form controls handle Enter natively.
        if (canCdp && tab.id) {
          try {
            // Two focus strategies:
            // 1. el.focus() via execute_script (works for plain buttons; programmatic focus)
            // 2. Fallback: send a CDP-level Tab keypress until the element gets focus
            //    (slower but creates a "real" focus via the browser's tab order)
            // After focus, dispatchKeyboardActivation sends Enter via CDP.
            const focusOk = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (markerAttr: string) => {
                const el = document.querySelector<HTMLElement>(`[${markerAttr}]`);
                if (!el) return false;
                el.focus({ preventScroll: false });
                // Some custom elements delegate focus — accept if activeElement is el OR descendant
                const ae = document.activeElement;
                return ae === el || (ae && el.contains(ae));
              },
              args: [markerIds.clickTargetAttr()],
            });
            if (focusOk[0]?.result === true) {
              await phaseRace("keyboard_activation_fallback", 3500, dispatchKeyboardActivation(tabId));
              const probeKB = await phaseRace(
                "activity_probe_keyboard_fallback",
                3500,
                runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr()),
              ).catch((e) => {
                const err = e as Error & { phase?: string };
                return {
                  activity: true,
                  reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
                  mutation_count: 0,
                  url_changed: false,
                  after_url: before_url,
                  focused_after: null,
                } as ActivityProbeResult;
              });
              if (probeKB.activity) {
                postNote += ` (fired via CDP keyboard Enter after mouse silently_rejected)`;
                recoveredVia = "keyboard-enter";
                probe.activity = true;
                probe.after_url = probeKB.after_url;
                probe.focused_after = probeKB.focused_after;
                probe.mutation_count = probeKB.mutation_count;
                probe.url_changed = probeKB.url_changed;
              }
            }
          } catch { /* fall through to pointer chain */ }
        }
      }

      if (!probe.activity) {
        // Pointer chain fallback: dispatch the full pointer event sequence
        // (pointerdown, mousedown, pointerup, mouseup, click) directly ON
        // the tagged element via the content script. This avoids the shadow
        // DOM event retargeting problem: CDP coordinate-based clicks fire
        // correctly inside the shadow root, but when the event bubbles OUT
        // of the shadow boundary, event.target is retargeted to the shadow
        // host. React event delegation checks event.target to route to the
        // component handler, finds the host instead of the button, and
        // discards the event. Dispatching directly on the element keeps
        // event.target correct within the shadow root's delegation context.
        if (
          usedCdp &&
          isScriptableUrl(tab.url) &&
          tab.id
        ) {
          const pcResult = await phaseRace(
            "pointer_chain_fallback",
            3500,
            forwardToContentScript(tab, {
              type: "pointer_chain_click",
              requestId: msg.requestId + "-pc",
            }),
          ).catch(() => null) as { fired?: boolean; label?: string } | null;

          if (pcResult?.fired) {
            const probePC = await phaseRace(
              "activity_probe_pointer_chain",
              3500,
              runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr()),
            ).catch((e) => {
              const err = e as Error & { phase?: string };
              return {
                activity: true,
                reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
                mutation_count: 0,
                url_changed: false,
                after_url: before_url,
                focused_after: null,
              } as ActivityProbeResult;
            });

            if (probePC.activity) {
              postNote += ` (fired via pointer chain fallback after CDP silently_rejected inside shadow DOM)`;
              recoveredVia = "pointer-chain";
              probe.activity = true;
              probe.after_url = probePC.after_url;
              probe.focused_after = probePC.focused_after;
              probe.mutation_count = probePC.mutation_count;
              probe.url_changed = probePC.url_changed;
            }
          }
        }
      }

      if (!probe.activity) {
        // DOM .click() fallback (only when the primary CDP path ran):
        // re-dispatch the click via the content-script's `.click()` method,
        // which loses isTrusted=true but catches a class of handlers the CDP
        // click misses: HTML Popover API triggers (button[popovertarget]
        // toggling <r-post-flairs-modal> on Reddit's new-post composer),
        // <faceplate-*> Lit web components that bind via addEventListener
        // without isTrusted gating, and onclick handlers attached on hosts
        // whose pointer-events:none parents ate the coordinate-based event.
        //
        // Outer `if (!probe.activity)` already gates on confident inactivity
        // so double-firing isn't a real risk; gate only on CDP having been
        // the primary path so the content-script .click() hasn't already
        // run (cdpPhaseError + non-scriptable url paths run it pre-probe).
        // Sites that gate strictly on isTrusted (Reddit comment submit
        // pre-0.9.12, X submit) will still silently_reject here.
        if (
          usedCdp &&
          isScriptableUrl(tab.url) &&
          tab.id
        ) {
          const domResult = await phaseRace(
            "dom_click_fallback",
            3500,
            forwardToContentScript(tab, msg),
          ).catch(() => null) as { success: boolean; message: string } | null;

          if (domResult?.success) {
            const probeDom = await phaseRace(
              "activity_probe_dom_fallback",
              3500,
              runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr()),
            ).catch((e) => {
              const err = e as Error & { phase?: string };
              return {
                activity: true,
                reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
                mutation_count: 0,
                url_changed: false,
                after_url: before_url,
                focused_after: null,
              } as ActivityProbeResult;
            });

            if (probeDom.activity) {
              postNote += ` (fired via DOM .click() fallback after CDP silently_rejected)`;
              recoveredVia = "dom-click";
              // Refresh probe with the post-fallback state so the until_*
              // poll below sees the right after_url / focused_after.
              probe.activity = true;
              probe.after_url = probeDom.after_url;
              probe.focused_after = probeDom.focused_after;
              probe.mutation_count = probeDom.mutation_count;
              probe.url_changed = probeDom.url_changed;
            }
          }
        }
      }

      if (!probe.activity) {
        // Opt-in last resort: walk the React fiber tree from the matched
        // element and invoke __reactProps$.onClick directly. Helps on React-
        // heavy SPAs whose action buttons pass through isTrusted=true checks
        // even on CDP-dispatched events. Auto-disabled (caller opts in via
        // try_fiber=true) because the fiber-prop path is undocumented and
        // could no-op or misbehave on non-React or mangled-prod builds.
        if (msg.try_fiber === true) {
          const fiberResult = await phaseRace("react_fiber_click", 3500, forwardToContentScript(tab, {
            type: "react_fiber_click",
            requestId: msg.requestId + "-fiber",
            textHint: msg.textHint,
            nth: msg.nth,
            within_selector: msg.within_selector,
            near_text: msg.near_text,
            in_dialog: msg.in_dialog,
            dialog_query: msg.dialog_query,
          })).catch((e) => ({ success: false, message: String(e), fired: false })) as {
            success: boolean; message: string; fired: boolean; component?: string; label?: string;
          };

          // Re-probe activity after the fiber invocation. If the onClick
          // handler actually did something (state change, navigation, mutation),
          // the second probe sees it and we fall through to the rest of the
          // click flow (until_*, expect_submit, etc).
          const probe2 = isScriptableUrl(tab.url) && tab.id
            ? await phaseRace("activity_probe_2", 3500, runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr())).catch((e) => {
                const err = e as Error & { phase?: string };
                return {
                  activity: true,
                  reason: `(probe2 phase exceeded budget: ${err.phase}; treating as activity)`,
                  mutation_count: 0,
                  url_changed: false,
                  after_url: before_url,
                  focused_after: null,
                } as ActivityProbeResult;
              })
            : ({ activity: true, reason: "(non-scriptable; probe skipped)", mutation_count: 0, url_changed: false, after_url: before_url, focused_after: null } as ActivityProbeResult);

          if (probe2.activity) {
            // Fiber click succeeded. Continue with the existing flow (until_*
            // poll lower down). Stash a note so the success message records
            // that the fiber path was used.
            postNote += ` (fired via React fiber after CDP silently_rejected)`;
            recoveredVia = "react-fiber";
          } else {
            return {
              type: "click_element_response",
              success: false,
              message: `Clicked "${prep.label ?? msg.textHint}" but no observable activity (DOM mutations, focus change, URL change, alert/toast/modal) within ${activityTimeoutMs}ms even after try_fiber=true (${fiberResult.fired ? "fiber onClick invoked, no DOM/URL/focus/alert change" : `no React fiber __reactProps$.onClick found: ${fiberResult.message}`}). The click MAY have succeeded for actions whose state change isn't observable in the DOM (toggling internal state, opening native dialogs). Verify with find_text or execute_script before retrying. If genuinely rejected, switch to highlight_region + wait_for_click.`,
              before_url,
              after_url: probe2.after_url,
              navigated: false,
              focused_after: probe2.focused_after,
              silently_rejected: true,
              fiber_attempted: true,
            };
          }
        } else {
          return {
            type: "click_element_response",
            success: false,
            message: `Clicked "${prep.label ?? msg.textHint}" but no observable activity (DOM mutations, focus change, URL change, alert/toast/modal) within ${activityTimeoutMs}ms. Possible causes: (1) the click DID work but the state change isn't observable in the DOM (toggling internal Lit state, opening native dialogs, setting a value) — verify with find_text or execute_script before retrying; (2) the action takes longer than ${activityTimeoutMs}ms — retry with activity_timeout_ms=3000+; (3) genuine anti-bot rejection — switch to highlight_region + wait_for_click, or retry with try_fiber=true on React SPAs.`,
            before_url,
            after_url: probe.after_url,
            navigated: false,
            focused_after: probe.focused_after,
            silently_rejected: true,
          };
        }
      }

      // React controlled radio/checkbox commit. A CDP/synthetic click flips the
      // input's DOM .checked (so the activity probe reports success), but
      // React's delegated change listener can MISS the event when event.target
      // is retargeted at a shadow boundary — leaving the form-level store stale
      // and a "This question is required" error stuck. If the clicked target is
      // a radio/checkbox whose React-controlled `checked` prop disagrees with
      // the DOM, call __reactProps$.onChange directly to sync the store. Runs
      // in MAIN world (the only place page expandos like __reactProps$ are
      // visible). Idempotent: only fires on a genuine prop/DOM mismatch, so it
      // never double-toggles an already-committed change.
      if (isScriptableUrl(tab.url) && tab.id) {
        const committed = await phaseRace(
          "react_state_commit",
          2500,
          commitReactControlState(tab.id, markerIds.clickTargetAttr()),
        ).catch(() => null) as { committed: boolean; kind?: string } | null;
        if (committed?.committed) {
          result.message += ` (synced stale React ${committed.kind ?? "control"} state via onChange)`;
          if (!recoveredVia) recoveredVia = `react-onchange-${committed.kind ?? "control"}`;
        }
      }

      // Probe + fallbacks done. Remove the marker so the next click doesn't
      // hit a stale tag.
      await untagClickTarget();

      // If the caller specified an until-clause, poll for it before returning.
      // This catches the "click_element returned success but the click didn't
      // register" case on React-heavy sites — Claude can require an observable
      // post-click condition (URL change, new selector, new page text) instead
      // of trusting the synthetic-success message.
      const untilSelector = msg.until_selector as string | undefined;
      const untilUrlContains = msg.until_url_contains as string | undefined;
      const untilTextContains = msg.until_text_contains as string | undefined;
      const untilUrlChanges = msg.until_url_changes === true;
      // url-change waits gate submit-style navigations whose backend roundtrip
      // can run 5-15s before the URL flips, so default them longer than
      // selector/text waits. Caller can still override with until_timeout_ms.
      const untilTimeoutMs = (msg.until_timeout_ms as number | undefined) ?? (untilUrlChanges ? 15000 : 5000);
      const expectSubmit = msg.expect_submit === true;
      const hasUntil = !!(untilSelector || untilUrlContains || untilTextContains || untilUrlChanges);
      // If the substring is already present in the pre-click URL, require
      // an actual URL change too — otherwise /tasks/OLD → /tasks/NEW with
      // until_url_contains="tasks/" matches instantly on the pre-click URL.
      const urlContainsRequiresChange = !!(untilUrlContains && before_url.includes(untilUrlContains));

      // For expect_submit: snapshot the pre-click counts of alert/toast/modal
      // selectors so we can detect NEW ones appearing after the click.
      // Without this snapshot, a pre-existing toast would be misread as a
      // post-submit signal.
      const preSubmitCounts = expectSubmit && !hasUntil && isScriptableUrl(tab.url)
        ? await getSubmitSignalCounts(tabId)
        : null;

      let untilResult: {
        ok: boolean;
        reason: string;
        request_in_flight?: boolean;
        dialog?: { kind: string; label: string; primary_action: string };
      } | null = null;
      let navigationResult: string | null = null;

      if (hasUntil) {
        const start = Date.now();
        // Hard ceiling for the grace-extension below: if a submit request is
        // still in flight at the base deadline, keep waiting (up to this cap)
        // rather than declaring failure on a click that genuinely fired.
        const maxDeadline = start + Math.max(untilTimeoutMs, untilUrlChanges ? 30000 : untilTimeoutMs);
        let deadline = start + untilTimeoutMs;
        let sawInFlight = false;
        while (Date.now() < deadline) {
          // Pull the current tab state each iteration (URL may change after navigation).
          const [currentTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
          const currentUrl = currentTab?.url ?? "";

          if (untilUrlChanges && currentUrl && currentUrl !== before_url) {
            untilResult = { ok: true, reason: `URL changed to ${currentUrl}` };
            navigationResult = currentUrl;
            break;
          }

          if (
            untilUrlContains
            && currentUrl.includes(untilUrlContains)
            && (!urlContainsRequiresChange || currentUrl !== before_url)
          ) {
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

          // Network-aware deadline extension. A click whose handler fired an
          // API request (submit, save) often navigates only AFTER the request
          // resolves — sometimes past the base timeout. If a fresh fetch/XHR is
          // in flight when we'd otherwise give up, keep waiting (up to
          // maxDeadline) instead of reporting "click may not have registered"
          // and inviting a dangerous double-submit retry.
          if (currentTab?.id && isScriptableUrl(currentUrl) && Date.now() >= deadline - 500) {
            const inflight = await countInFlightRequests(currentTab.id);
            if (inflight > 0) {
              sawInFlight = true;
              deadline = Math.min(maxDeadline, Date.now() + 4000);
            }
          }

          await new Promise((r) => setTimeout(r, 250));
        }
        if (!untilResult) {
          const conditions = [
            untilSelector && `selector "${untilSelector}"`,
            untilUrlContains && `URL containing "${untilUrlContains}"`,
            untilTextContains && `text "${untilTextContains}"`,
            untilUrlChanges && `URL change`,
          ].filter(Boolean).join(" or ");

          // Check if a dialog/modal opened post-click and CLASSIFY it. Two very
          // different things both open a [role=dialog]:
          //   - a confirmation step ("Submit?" -> [Confirm]) — the click worked,
          //     it's just a two-step action; the agent should click through.
          //   - a required-input prompt (flair picker, "answer this first") —
          //     the agent must supply the missing value before retrying.
          // The old code labelled everything "required-input prompt", which was
          // misleading on confirm dialogs. We now distinguish them by content
          // (form fields / validation text => required-input, else => confirm)
          // and surface the primary action label so the agent knows what to
          // click next.
          let blockerHint = "";
          let dialogInfo: { kind: string; label: string; primary_action: string } | undefined;
          if (isScriptableUrl(tab.url) && tab.id) {
            try {
              const r = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                  const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
                  function getShadowRoot(el: Element): ShadowRoot | null {
                    if (chromeDom?.openOrClosedShadowRoot) {
                      try { const sr = chromeDom.openOrClosedShadowRoot(el); if (sr) return sr; } catch { /* ignore */ }
                    }
                    return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
                  }
                  function deepFind(sel: string): Element | null {
                    const stack: (Document | ShadowRoot)[] = [document];
                    while (stack.length) {
                      const root = stack.pop()!;
                      const found = root.querySelector(sel);
                      if (found) return found;
                      for (const el of Array.from(root.querySelectorAll("*"))) {
                        const sr = getShadowRoot(el);
                        if (sr) stack.push(sr);
                      }
                    }
                    return null;
                  }
                  function deepAllWithin(root: Element, sel: string): Element[] {
                    const out: Element[] = [];
                    const stack: (Element | ShadowRoot)[] = [root];
                    while (stack.length) {
                      const r = stack.pop()!;
                      for (const el of Array.from(r.querySelectorAll(sel))) out.push(el);
                      const scope = r instanceof Element ? [r, ...Array.from(r.querySelectorAll("*"))] : Array.from(r.querySelectorAll("*"));
                      for (const el of scope) {
                        const sr = getShadowRoot(el);
                        if (sr) stack.push(sr);
                      }
                    }
                    return out;
                  }
                  // First VISIBLE dialog — skip stale hidden dialog nodes that
                  // SPAs (Radix/headless) leave mounted but display:none, which
                  // would otherwise mask the real one that just opened.
                  const dialogSel = '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"], dialog[open], faceplate-dialog:not([hidden])';
                  let dialog: Element | null = null;
                  for (const cand of deepAllWithin(document.documentElement, dialogSel)) {
                    const cr = (cand as HTMLElement).getBoundingClientRect?.();
                    if (cr && cr.width === 0 && cr.height === 0) continue;
                    dialog = cand;
                    break;
                  }
                  if (!dialog) return null;
                  const heading = dialog.querySelector("h1, h2, h3, [role='heading']")?.textContent?.trim() ?? "";
                  const aria = dialog.getAttribute("aria-label") ?? "";
                  const label = (heading || aria || dialog.tagName.toLowerCase()).slice(0, 80);

                  // Does the dialog ask for input?
                  const hasField = deepAllWithin(dialog,
                    'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]), textarea, select, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="textbox"], [role="combobox"], [role="listbox"]'
                  ).length > 0;
                  const txt = (dialog.textContent ?? "").slice(0, 2000);
                  const validationText = /\b(is required|required field|please (?:answer|select|choose|enter|provide|complete)|you must (?:answer|select|choose|provide|complete))\b/i.test(txt);

                  // Primary action button: prefer an affirmative verb, else the
                  // last button (dialogs usually order [Cancel][Confirm]).
                  const btns = deepAllWithin(dialog, 'button, [role="button"], a[href]')
                    .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim())
                    .filter((t) => t.length > 0 && t.length < 40);
                  const affirmative = btns.find((t) => /\b(confirm|submit|continue|proceed|yes|ok|okay|accept|save|delete|got it|next)\b/i.test(t));
                  const primary = (affirmative || btns[btns.length - 1] || "").slice(0, 40);

                  const kind = (hasField || validationText) ? "required-input" : (primary ? "confirmation" : "dialog");
                  return { kind, label, primary_action: primary };
                },
              });
              const d = r[0]?.result as { kind: string; label: string; primary_action: string } | null | undefined;
              if (d) {
                dialogInfo = d;
                if (d.kind === "confirmation") {
                  blockerHint = ` A confirmation dialog opened: "${d.label}". This is a two-step action, not a validation error — the first click worked. Click its primary action${d.primary_action ? ` ("${d.primary_action}")` : ""} to complete, e.g. click_element with textHint="${d.primary_action || "Confirm"}".`;
                } else if (d.kind === "required-input") {
                  blockerHint = ` A required-input dialog opened: "${d.label}". Supply the missing value inside it${d.primary_action ? `, then click "${d.primary_action}"` : ""}, before retrying the original action.`;
                } else {
                  blockerHint = ` A dialog opened post-click: "${d.label}".`;
                }
              }
            } catch { /* best-effort */ }
          }

          const waited = Date.now() - start;
          if (sawInFlight && !dialogInfo) {
            // The click fired a network request that was still resolving — it
            // DID register. Surface that instead of "may not have registered",
            // which on a submit invites a double-submit retry.
            untilResult = {
              ok: false,
              request_in_flight: true,
              reason: `Click fired and triggered a network request still in flight after ${waited}ms; ${conditions} has not appeared yet. The click DID register — navigation/response is likely pending. Do NOT retry (double-submit risk). Re-check page state, or call again with a higher until_timeout_ms.`,
            };
          } else {
            untilResult = {
              ok: false,
              dialog: dialogInfo,
              reason: `Click fired but ${conditions} did not appear within ${waited}ms — the click may not have registered.${blockerHint} Try execute_script with a direct .click() on the matched element, or pass a different until_* value.`,
            };
          }
        }
      } else if (expectSubmit) {
        // expect_submit: poll for any anti-bot-friendly submit signal within
        // 4s. Catches the "synthetic click silently rejected" case on Reddit /
        // X submit without needing a specific until_* destination.
        const start = Date.now();
        while (Date.now() - start < 4000) {
          const [t] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
          const url = t?.url ?? "";
          if (url && url !== before_url) {
            untilResult = { ok: true, reason: `URL changed to ${url}` };
            navigationResult = url;
            break;
          }
          if (t?.id && isScriptableUrl(url)) {
            const counts = await getSubmitSignalCounts(t.id);
            const pre = preSubmitCounts ?? { alert: 0, toast: 0, modal: 0 };
            if (counts.alert > pre.alert) {
              untilResult = { ok: true, reason: `alert/aria-live element appeared` };
              break;
            }
            if (counts.toast > pre.toast) {
              untilResult = { ok: true, reason: `toast / notification element appeared` };
              break;
            }
            if (counts.modal > pre.modal) {
              untilResult = { ok: true, reason: `modal / [role=dialog] appeared` };
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!untilResult) {
          untilResult = {
            ok: false,
            reason: `submit silently rejected (likely anti-bot): no URL change, toast, alert, or modal appeared within 4s. Synthetic clicks fail on Reddit / X / mcp.so even though isTrusted passes — pre-fill the form, then highlight + wait_for_click so a real human gesture fires the submit.`,
          };
        }
      } else {
        // No until-clause and no expect_submit — race a real-load wait against
        // a brief hard cap. 1500ms is the SPA-pushState window — most React-
        // router clicks complete their pushState in <1000ms; 1500ms gives margin
        // without making non-navigating clicks feel slow.
        navigationResult = await Promise.race([
          waitForNavigation(tab.id!, 4000),
          new Promise<null>((r) => setTimeout(() => r(null), 1500)),
        ]);
        // pushState-only navigations: chrome.tabs URL can lag a few hundred ms
        // behind the actual location after a synchronous history.pushState.
        // Without this settle, navigated:false fires on legitimate SPA navs.
        if (!navigationResult) {
          await new Promise((r) => setTimeout(r, 300));
        }
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

      // Snapshot the post-click URL so callers can spot silent redirects.
      // A click "Assessment" link on Canvas that bounces to the course home
      // returns success today with no indication anything went wrong — the
      // before/after URL pair makes that visible.
      const [postTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
      const after_url = postTab?.url ?? navigationResult ?? before_url;
      const navigated = after_url !== before_url;

      // Post-click navigation guard: if the click navigated to a blocked URL
      // (e.g. clicked a github.com link), reverse the navigation immediately
      // and report a refusal. Honors the hard-coded URL policy at the
      // navigation result layer for clicks that originate as plain text-hint
      // clicks but resolve to blocked destinations.
      if (navigated) {
        const blockNav = isBlockedUrl(after_url);
        if (blockNav.blocked && postTab?.id) {
          try { await chrome.tabs.goBack(postTab.id); } catch { /* no history — leave tab as-is */ }
          return {
            type: "click_element_response",
            success: false,
            message: `Click navigated to a blocked URL (${after_url}). ${blockNav.reason} The navigation has been reversed.`,
            before_url,
            after_url,
            navigated: true,
          };
        }
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
        return {
          type: "click_element_response",
          success: untilResult.ok,
          message,
          before_url,
          after_url,
          navigated,
          focused_after: probe.focused_after,
          ...(recoveredVia ? { recovered_via: recoveredVia } : {}),
          ...(untilResult.request_in_flight ? { request_in_flight: true } : {}),
          ...(untilResult.dialog ? { dialog_opened: untilResult.dialog } : {}),
        };
      }

      message = navigationResult
        ? `Clicked and navigated to ${navigationResult}`
        : result.message;

      if (alertMessage) {
        message += `\n\nPAGE ALERT: "${alertMessage}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
      }

      return { type: "click_element_response", success: true, message, before_url, after_url, navigated, focused_after: probe.focused_after, ...(recoveredVia ? { recovered_via: recoveredVia } : {}) };
      }; // end runClickFlow

      // Wrap the entire post-prep flow in an outer withDebugger when CDP is
      // available, so the beforeunload listener registered inside stays armed
      // across the activity probe and fallback chain. When CDP isn't usable
      // (chrome:// pages, missing coords), run the flow without an attach.
      if (canCdp) {
        return await withDebugger(tabId, async () => {
          const buCtx = await armBeforeunloadDismissOnAttachedTab(tabId);
          try {
            return await runClickFlow();
          } finally {
            buCtx.release();
          }
        });
      }
      return await runClickFlow();
    }

    case "click_at_coordinates": {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      const before_url = tab.url ?? "";
      const x = Math.round(msg.x as number);
      const y = Math.round(msg.y as number);
      const button = (msg.button as "left" | "right" | "middle" | undefined) ?? "left";
      const double = msg.double === true;

      if (!isScriptableUrl(tab.url)) {
        return {
          type: "click_at_coordinates_response",
          requestId: msg.requestId,
          success: false,
          message: `Cannot click on ${tab.url} (non-scriptable URL — chrome://, devtools, etc.)`,
          before_url,
          after_url: before_url,
          navigated: false,
        };
      }
      // Cheap viewport sanity check: a click at (-50, 5000) is almost
      // certainly a coordinate-space mix-up. We don't know the actual viewport
      // size from background but we can spot obviously-bad values.
      if (x < 0 || y < 0 || x > 10000 || y > 10000) {
        return {
          type: "click_at_coordinates_response",
          requestId: msg.requestId,
          success: false,
          message: `click_at_coordinates refused: (${x}, ${y}) is outside any plausible viewport. Coordinates must be viewport CSS pixels relative to the active tab; list_frames reports each iframe at (x, y, width, height) in this space.`,
          before_url,
          after_url: before_url,
          navigated: false,
        };
      }

      try {
        await phaseRace("cdp_click_at", 8000, dispatchHumanMouseClick(tabId, x, y, { button, double }));
      } catch (e) {
        const err = e as Error & { phase?: string; phaseTimedOut?: boolean };
        return {
          type: "click_at_coordinates_response",
          requestId: msg.requestId,
          success: false,
          message: `click_at_coordinates failed at (${x}, ${y}): ${err.message}`,
          before_url,
          after_url: before_url,
          navigated: false,
        };
      }

      // Brief settle so navigations and modal openings register before we
      // read after_url. Don't run the full activity probe — coordinate
      // clicks frequently target cross-origin iframes whose state changes
      // are invisible to the parent.
      await new Promise((r) => setTimeout(r, 250));
      const [postTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
      const after_url = postTab?.url ?? before_url;
      return {
        type: "click_at_coordinates_response",
        requestId: msg.requestId,
        success: true,
        message: `Clicked at (${x}, ${y})${double ? " double-click" : ""}${button !== "left" ? ` button=${button}` : ""}${after_url !== before_url ? ` — navigated to ${after_url}` : ""}`,
        before_url,
        after_url,
        navigated: after_url !== before_url,
      };
    }

    case "type_text": {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      const text = msg.text as string;
      const frameSelector = msg.frame as string | undefined;
      const intoSelector = msg.into_selector as string | undefined;
      const clearFirst = msg.clear_first === true;

      // If `into_selector` is given, focus that element FIRST. Resolves via
      // shadow-piercing query so contenteditables inside Radix portals or
      // other closed shadow roots are reachable. clear_first does
      // selectAll+delete before typing — useful for replacing existing text
      // in a tiptap / ProseMirror editor in one call rather than the old
      // wait_for_click → execCommand → type_text pattern.
      let intoSelectorOk: boolean | null = null;
      if (intoSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector: string, clearFirst: boolean) => {
              function getShadowRoot(el: Element): ShadowRoot | null {
                const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
                if (chromeDom?.openOrClosedShadowRoot) {
                  try {
                    const sr = chromeDom.openOrClosedShadowRoot(el);
                    if (sr) return sr;
                  } catch { /* fall through */ }
                }
                return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
              }
              function queryDeep(root: ParentNode, sel: string): Element | null {
                const direct = root.querySelector(sel);
                if (direct) return direct;
                for (const el of Array.from(root.querySelectorAll<Element>("*"))) {
                  const sr = getShadowRoot(el);
                  if (sr) {
                    const found = queryDeep(sr, sel);
                    if (found) return found;
                  }
                }
                return null;
              }
              const target = queryDeep(document, selector);
              if (!target) return "not-found";
              if (!(target instanceof HTMLElement)) return "not-html";
              // If 0×0, scroll into view (best-effort) before focusing.
              const rect = target.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) {
                target.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
              }
              target.focus();
              // Tag the target so the MAIN-world clear step can find the
              // same element. Page-script expandos like __lexicalEditor are
              // ONLY visible in MAIN world; ISOLATED can't reach them.
              if (clearFirst) {
                target.setAttribute("data-chromeflow-clear-target", "1");
                // Native input/textarea clear: works in ISOLATED.
                if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                  target.value = "";
                  target.dispatchEvent(new Event("input", { bubbles: true }));
                  target.dispatchEvent(new Event("change", { bubbles: true }));
                  target.removeAttribute("data-chromeflow-clear-target");
                }
              }
              return "ok";
            },
            args: [intoSelector, clearFirst],
          });
          intoSelectorOk = r[0]?.result === "ok";
          if (!intoSelectorOk) {
            return {
              type: "action_done",
              requestId: msg.requestId,
              success: false,
              message: `into_selector "${intoSelector}" did not resolve to a focusable element (${r[0]?.result ?? "unknown"}). Either the selector is wrong, the element is detached, or it lives in a cross-origin iframe.`,
            };
          }
          // Second pass: clear Lexical / ProseMirror / TipTap state in MAIN world.
          // Page-script expandos like __lexicalEditor are only visible from
          // MAIN world; the ISOLATED-world pass above can't reach them.
          if (clearFirst) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: () => {
                  const target = document.querySelector<HTMLElement>('[data-chromeflow-clear-target]');
                  if (!target) return;
                  // Lexical
                  const lexicalKey = Object.keys(target).find((k) => k.startsWith("__lexicalEditor"));
                  if (lexicalKey) {
                    try {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const editor = (target as any)[lexicalKey];
                      const blank = editor.parseEditorState('{"root":{"children":[{"children":[],"direction":null,"format":"","indent":0,"type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"root","version":1}}');
                      editor.setEditorState(blank);
                      target.removeAttribute("data-chromeflow-clear-target");
                      return;
                    } catch { /* fall through */ }
                  }
                  // TipTap on closest [data-tiptap-editor] / .tiptap / .ProseMirror
                  const tiptapHost = target.closest("[data-tiptap-editor], .tiptap, .ProseMirror") as HTMLElement | null;
                  if (tiptapHost) {
                    const tiptapKey = Object.keys(tiptapHost).find((k) => k.startsWith("__tiptapEditor"));
                    if (tiptapKey) {
                      try {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const editor = (tiptapHost as any)[tiptapKey];
                        if (editor?.commands?.clearContent) {
                          editor.commands.clearContent();
                          target.removeAttribute("data-chromeflow-clear-target");
                          return;
                        }
                      } catch { /* fall through */ }
                    }
                  }
                  // ProseMirror via pmViewDesc
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const pmView = (target as any).pmViewDesc?.spec?.editor;
                  if (pmView?.state && pmView?.dispatch) {
                    try {
                      const tr = pmView.state.tr;
                      const size = pmView.state.doc.content.size;
                      pmView.dispatch(tr.delete(0, size));
                      target.removeAttribute("data-chromeflow-clear-target");
                      return;
                    } catch { /* fall through */ }
                  }
                  // Plain contenteditable: select all + delete
                  try { document.execCommand("selectAll"); } catch { /* ignore */ }
                  try { document.execCommand("delete"); } catch { /* ignore */ }
                  target.removeAttribute("data-chromeflow-clear-target");
                },
              });
            } catch { /* best-effort; typing will still happen */ }
          }
        } catch (e) {
          return {
            type: "action_done",
            requestId: msg.requestId,
            success: false,
            message: `Error focusing into_selector "${intoSelector}": ${(e as Error).message}`,
          };
        }
      }

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
      // For long typings, emit a progress heartbeat every 200 chars so the WS
      // request timer resets and we don't trip the timeout while still typing.
      await withDebugger(tabId, async () => {
        const PROGRESS_INTERVAL = 200;
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

          // Slow-pause cap tightened from 500ms to 250ms. Empirically the
          // upper tail wasn't load-bearing for behavioral-fingerprint defeat
          // and it pushed long-typing budgets past the WS timeout. Reddit /
          // X composer flows continue to accept synthetic input at the 250ms
          // cap (validated via the chromeflow anti-bot click sequence which
          // already lands isTrusted=true events).
          const baseDelay = 30 + Math.random() * 60;
          const pause = Math.random() < 0.05 ? 150 + Math.random() * 100 : baseDelay;
          await new Promise((r) => setTimeout(r, pause));

          // Heartbeat: tell the bridge we're still making forward progress so
          // the request-timeout clock resets. Without this, ~1800-char typings
          // can complete on the page but trip the WS timeout in the bridge.
          // Routed via offscreen so the heartbeat lands on the correct WS
          // connection (one per Claude Code instance).
          if ((i + 1) % PROGRESS_INTERVAL === 0) {
            try {
              chrome.runtime.sendMessage({
                source: "chromeflow-progress",
                port,
                requestId: msg.requestId,
                phase: "type_text",
                detail: `${i + 1}/${text.length} chars`,
              }).catch(() => {});
            } catch { /* best-effort */ }
          }
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

      // TipTap / ProseMirror silent-drop guard: CDP keystrokes land visually
      // but tiptap's internal state machine doesn't see them as valid input,
      // so a few hundred ms later the editor reverts to placeholder. We
      // verify post-type for any into_selector target and, when the editor's
      // text content is significantly shorter than what we typed AND the
      // target is inside a recognised rich-text editor, fall back to
      // execCommand('insertText') which tiptap DOES accept.
      let tiptapFallback = "";
      if (intoSelector && intoSelectorOk && !frameSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector: string, expectedText: string) => {
              function getShadowRoot(el: Element): ShadowRoot | null {
                const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
                if (chromeDom?.openOrClosedShadowRoot) {
                  try {
                    const sr = chromeDom.openOrClosedShadowRoot(el);
                    if (sr) return sr;
                  } catch { /* fall through */ }
                }
                return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
              }
              function queryDeep(root: ParentNode, sel: string): Element | null {
                const direct = root.querySelector(sel);
                if (direct) return direct;
                for (const el of Array.from(root.querySelectorAll<Element>("*"))) {
                  const sr = getShadowRoot(el);
                  if (sr) {
                    const found = queryDeep(sr, sel);
                    if (found) return found;
                  }
                }
                return null;
              }
              const target = queryDeep(document, selector);
              if (!(target instanceof HTMLElement)) return { ok: false };
              // Walk up to detect ProseMirror / tiptap ancestor.
              const isProseMirror =
                target.classList.contains("ProseMirror") ||
                target.classList.contains("tiptap") ||
                target.closest?.(".ProseMirror, .tiptap, [data-tiptap-editor]") !== null;
              const actual = target.isContentEditable
                ? (target.textContent ?? "")
                : ((target as HTMLInputElement | HTMLTextAreaElement).value ?? "");
              // Drop threshold: editor has < 50% of expected content. Stricter
              // than "0 chars" because tiptap sometimes lands a partial paste
              // before reverting; < 50% captures both full-drop and partial-drop.
              const dropped = actual.length < expectedText.length * 0.5;
              if (!isProseMirror || !dropped) {
                return { ok: true, fallback: false, isProseMirror, actualLength: actual.length, expectedLength: expectedText.length };
              }
              // Fallback: focus, select-all, replace via insertText.
              target.focus();
              try { document.execCommand("selectAll"); } catch { /* ignore */ }
              try { document.execCommand("delete"); } catch { /* ignore */ }
              try { document.execCommand("insertText", false, expectedText); } catch { /* ignore */ }
              target.dispatchEvent(new Event("input", { bubbles: true }));
              target.dispatchEvent(new Event("change", { bubbles: true }));
              const finalText = target.textContent ?? "";
              return {
                ok: true,
                fallback: true,
                isProseMirror: true,
                actualLength: actual.length,
                expectedLength: expectedText.length,
                finalLength: finalText.length,
              };
            },
            args: [intoSelector, text],
          });
          const v = r[0]?.result as
            | { ok: false }
            | { ok: true; fallback: boolean; isProseMirror: boolean; actualLength: number; expectedLength: number; finalLength?: number }
            | undefined;
          if (v && v.ok && v.fallback) {
            tiptapFallback =
              ` — TipTap/ProseMirror silently dropped the typed text (${v.actualLength}/${v.expectedLength} chars survived), recovered via execCommand insertText (${v.finalLength ?? "?"} chars now in editor)`;
          }
        } catch { /* best-effort */ }
      }

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
        message: `Typed ${text.length} characters via individual keystrokes${frameSelector ? ` into iframe "${frameSelector}"${frameVerify ? " " + frameVerify : ""}` : ""}${tiptapFallback}`,
      };
    }

    case "set_file_input": {
      const tab = await getActiveTab(port);

      // Ask content script to find and tag the file input. The content script
      // uses queryAllDeep, which pierces open AND closed shadow roots — file
      // inputs hidden behind Stencil/Lit/Radix drag-zones are reachable.
      const tagResult = await forwardToContentScript(tab, {
        type: "tag_file_input",
        requestId: msg.requestId,
        hint: msg.hint,
      }) as { found: boolean; message?: string; attr?: string; matched_desc?: string; matched_via?: string };

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
      //
      // The inline queryAllDeep helper pierces open and closed shadow roots
      // via chrome.dom.openOrClosedShadowRoot. Without it, file inputs nested
      // inside web-component shadow DOM are invisible to the count.
      const pre = await chrome.scripting.executeScript({
        target: { tabId },
        func: pierceFileCount,
      });
      const preTotal = (pre[0]?.result as { totalFiles: number; inputCount: number } | undefined)?.totalFiles ?? 0;

      // Use Chrome DevTools Protocol to set the file — the only way to bypass
      // the browser's script restriction on file inputs. Lookup goes through
      // DOM.getDocument({pierce: true}) so we can reach shadow-rooted inputs
      // (Runtime.evaluate's document.querySelector is MAIN-world and doesn't
      // pierce open OR closed shadow boundaries).
      try {
        await withDebugger(tabId, async () => {
          const backendNodeId = await findShadowMarkedBackendNodeId(tabId, fileAttr);
          if (!backendNodeId) throw new Error("Could not locate tagged file input via CDP");

          await (chrome.debugger as any).sendCommand({ tabId }, "DOM.setFileInputFiles", {
            backendNodeId,
            files: [msg.filePath],
          });
        });

        // Dispatch change + input events from the content script so the
        // pierce-aware queryAllDeep can find the tagged input. Doing this from
        // CDP Runtime.evaluate would silently no-op on closed-shadow-rooted
        // inputs.
        await forwardToContentScript(tab, {
          type: "dispatch_file_change_events",
          requestId: msg.requestId + "-dispatch",
          attr: fileAttr,
        }).catch(() => {});
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
          func: pierceFilePoll,
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
      if (tagResult.matched_desc) {
        noteParts.push(`targeted ${tagResult.matched_desc}${tagResult.matched_via ? ` (via ${tagResult.matched_via})` : ""}`);
      }
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

      // Tag the element in the content script first (queryAllDeep pierces
      // open AND closed shadow roots). The MAIN-world script then reads by
      // tag attribute. Top-frame only — same-origin iframe access is still
      // routed through doc.querySelector below since the content script
      // doesn't run inside iframe documents.
      const tagId = `chromeflow-react-target-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      let taggedInShadow = false;
      if (!frameSelector) {
        try {
          const tagResult = await forwardToContentScript(tab, {
            type: "tag_for_react",
            requestId: msg.requestId + "-tag",
            selector,
            tagId,
          }) as { tagged: boolean; in_shadow: boolean };
          if (tagResult?.tagged) {
            taggedInShadow = !!tagResult.in_shadow;
          }
        } catch {
          // Tagging is best-effort; fall back to plain doc.querySelector below
          // if it failed (e.g. content script not loaded on this page).
        }
      }

      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (sel: string, val: string, frameSel: string | undefined, tag: string) => {
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
          // Prefer the tag-based lookup when the content script tagged
          // something for us (closed-shadow-root reachable). Fall through to
          // plain querySelector when no tag was placed (iframe path, or
          // tagging failed).
          let el: Element | null = null;
          if (tag) {
            // Tag lookup walks open shadow roots only from MAIN world. The
            // content script already verified the element exists via
            // queryAllDeep, so we just need to find it in a re-attached form.
            const findTagged = (root: ParentNode): Element | null => {
              const direct = root.querySelector(`[data-chromeflow-react-target="${tag}"]`);
              if (direct) return direct;
              const all = root.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                const sr = (all[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                if (sr) {
                  const nested = findTagged(sr);
                  if (nested) return nested;
                }
              }
              return null;
            };
            el = findTagged(doc);
          }
          if (!el) el = doc.querySelector(sel);
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

          // Clean up the chromeflow tag so we don't pollute the DOM. Best
          // effort; if removeAttribute throws (frozen elements, custom
          // proxies), the tag is harmless.
          try { el.removeAttribute("data-chromeflow-react-target"); } catch { /* ignore */ }

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
        args: [selector, value, frameSelector, tagId],
      });

      const result = r[0]?.result as
        | { ok: false; reason: string }
        | { ok: true; reason: string; tag: string; name: string; id: string; type: string; readBack: string }
        | undefined;
      if (!result) return { type: "action_done", requestId: msg.requestId, success: false, message: "no response from page" };
      if (!result.ok) return { type: "action_done", requestId: msg.requestId, success: false, message: result.reason };

      let accepted = result.readBack === value;
      let normalizedNote = "";
      if (!accepted) {
        // Same false-negative as fill_input's textHint path: a controlled
        // `value={n || ""}` renders 0 as empty, and number inputs reformat
        // ("0.50" -> "0.5"). Both mean the value WAS accepted.
        const writtenNum = Number(value);
        const readNum = Number(result.readBack);
        const isZeroWrite = value.trim() !== "" && writtenNum === 0;
        if (isZeroWrite && (result.readBack === "" || readNum === 0)) {
          accepted = true;
          normalizedNote = result.readBack === "" ? " (wrote 0; field renders zero as empty, accepted as 0)" : "";
        } else if (result.readBack !== "" && !Number.isNaN(writtenNum) && !Number.isNaN(readNum) && writtenNum === readNum) {
          accepted = true;
          normalizedNote = ` (normalised "${value}" → "${result.readBack}")`;
        }
      }
      const desc = `<${result.tag}${result.type ? ` type="${result.type}"` : ""}${result.name ? ` name="${result.name}"` : ""}${result.id ? ` id="${result.id}"` : ""}>`;
      const shadowNote = taggedInShadow ? " (resolved inside shadow DOM)" : "";
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: true,
        message: accepted
          ? `Set ${desc} to "${value.slice(0, 60)}"${frameSelector ? ` (inside iframe "${frameSelector}")` : ""}${shadowNote}${normalizedNote}`
          : `Set ${desc} via native setter, but React reported back "${result.readBack.slice(0, 60)}" — the page may be controlling the value externally.${shadowNote}`,
      };
    }

    case "react_call_prop": {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      if (!isScriptableUrl(tab.url)) {
        return { type: "action_done", requestId: msg.requestId, success: false, message: `Cannot run on ${tab.url}` };
      }

      const selector = msg.selector as string;
      const propName = msg.prop_name as string;
      const args = (msg.args ?? []) as unknown[];
      const maxDepth = (msg.max_depth ?? 30) as number;
      const frameSelector = msg.frame as string | undefined;

      // Tag-from-content-script + read-from-main-world so closed shadow root
      // selectors work. Iframe path skips tagging since the content script
      // runs against the top frame only.
      const tagId = `chromeflow-react-target-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      if (!frameSelector) {
        try {
          await forwardToContentScript(tab, {
            type: "tag_for_react",
            requestId: msg.requestId + "-tag",
            selector,
            tagId,
          });
        } catch { /* best-effort */ }
      }

      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (sel: string, pName: string, callArgs: unknown[], depth: number, frameSel: string | undefined, tag: string) => {
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
          let el: Element | null = null;
          if (tag) {
            const findTagged = (root: ParentNode): Element | null => {
              const direct = root.querySelector(`[data-chromeflow-react-target="${tag}"]`);
              if (direct) return direct;
              const all = root.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                const sr = (all[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                if (sr) {
                  const nested = findTagged(sr);
                  if (nested) return nested;
                }
              }
              return null;
            };
            el = findTagged(doc);
            if (el) {
              try { el.removeAttribute("data-chromeflow-react-target"); } catch { /* ignore */ }
            }
          }
          if (!el) el = doc.querySelector(sel);
          if (!el) return { ok: false, reason: `selector "${sel}" not found${frameSel ? ` inside iframe "${frameSel}"` : ""}` };

          const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
          if (!fiberKey) return { ok: false, reason: `no React fiber on element matched by "${sel}" — is this a React app?` };

          let cur = (el as unknown as Record<string, unknown>)[fiberKey] as
            | { memoizedProps?: Record<string, unknown>; type?: unknown; return?: unknown }
            | null
            | undefined;

          for (let i = 0; i < depth && cur; i++) {
            const props = cur.memoizedProps;
            const fn = props?.[pName];
            if (typeof fn === "function") {
              const t = cur.type as { displayName?: string; name?: string } | string | undefined;
              const componentName =
                (typeof t === "string" ? t : null) ||
                (t && typeof t === "object" ? (t.displayName || t.name) : null) ||
                "anonymous";
              try {
                const ret = await Promise.resolve((fn as (...a: unknown[]) => unknown)(...callArgs));
                let returned: string;
                if (ret === undefined) returned = "undefined";
                else if (ret === null) returned = "null";
                else if (typeof ret === "object") {
                  try {
                    returned = JSON.stringify(ret).slice(0, 200);
                  } catch {
                    returned = "[object]";
                  }
                } else {
                  returned = String(ret).slice(0, 200);
                }
                return {
                  ok: true,
                  depth: i,
                  componentName,
                  returned,
                };
              } catch (err) {
                const e = err as Error;
                return {
                  ok: false,
                  reason: `prop "${pName}" threw: ${e?.message ?? String(err)}`,
                  depth: i,
                  componentName,
                };
              }
            }
            cur = cur.return as typeof cur;
          }
          return { ok: false, reason: `no prop "${pName}" found within ${depth} fiber levels`, walked: depth };
        },
        args: [selector, propName, args, maxDepth, frameSelector, tagId],
      });

      const result = r[0]?.result as
        | { ok: false; reason: string; depth?: number; walked?: number; componentName?: string }
        | { ok: true; depth: number; componentName: string; returned: string }
        | undefined;
      if (!result) return { type: "action_done", requestId: msg.requestId, success: false, message: "no response from page" };
      if (!result.ok) {
        const where = result.depth !== undefined
          ? ` (at fiber depth ${result.depth}${result.componentName ? ` in <${result.componentName}>` : ""})`
          : result.walked !== undefined ? ` (walked ${result.walked} levels)` : "";
        return { type: "action_done", requestId: msg.requestId, success: false, message: `${result.reason}${where}` };
      }
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: true,
        message: `Called ${propName}(...) on <${result.componentName}> at fiber depth ${result.depth}. Return: ${result.returned}`,
      };
    }

    case "inspect_request_headers": {
      const targetUrl = msg.url as string;
      const blockInspect = isBlockedUrl(targetUrl);
      if (blockInspect.blocked) {
        throw new Error(blockInspect.reason!);
      }
      const useNewTab = msg.new_tab !== false; // default true

      // Pick the tab we'll attach the debugger to. When useNewTab is true,
      // open a fresh tab in chromeflow's window (so the user's active tab keeps
      // its form/scroll state) and close it once headers are captured.
      let tabId: number;
      let cleanupTabId: number | null = null;
      if (useNewTab) {
        await getActiveTab(port); // ensure window assigned
        const wid = getWindowId(port)!;
        const newTab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: wid });
        if (!newTab.id) {
          throw new Error("Could not open a background tab for inspect_request_headers.");
        }
        tabId = newTab.id;
        cleanupTabId = newTab.id;
      } else {
        const tab = await getActiveTab(port);
        tabId = tab.id!;
      }

      try {
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
      } finally {
        // Close the side-tab we opened for inspection, regardless of success.
        if (cleanupTabId !== null) {
          try { await chrome.tabs.remove(cleanupTabId); } catch { /* tab may already be gone */ }
        }
      }
    }

    case "read_attachment": {
      const url = msg.url as string;
      const blockRead = isBlockedUrl(url);
      if (blockRead.blocked) {
        throw new Error(blockRead.reason!);
      }
      const formatHint = msg.format as string | undefined;
      const maxChars = (msg.max_chars as number | undefined) ?? 50_000;

      // Use the same privileged-fetch path as fetch_url — extension authority,
      // full cookie jar, page CSP doesn't apply.
      const resp = await fetch(url, { credentials: "include" });
      if (!resp.ok) {
        throw new Error(`fetch failed: HTTP ${resp.status} ${resp.statusText}`);
      }
      const contentType = resp.headers.get("content-type") ?? "";
      const buf = await resp.arrayBuffer();

      const format = (formatHint as SupportedFormat | undefined) ?? detectFormat(contentType, url);
      if (!format) {
        throw new Error(
          `Could not detect format for ${url} (content-type: "${contentType}"). Pass format: "txt" | "md" | "csv" | "json" | "xml" | "html" | "docx" | "pdf" explicitly.`
        );
      }

      const fullText = await parseDoc(buf, format);
      const truncated = fullText.length > maxChars;
      const text = truncated ? fullText.slice(0, maxChars) : fullText;
      return {
        type: "read_attachment_response",
        requestId: msg.requestId,
        text,
        format,
        total_chars: fullText.length,
        truncated,
        mime: contentType,
      };
    }

    case "download_file": {
      const url = msg.url as string;
      const blockDl = isBlockedUrl(url);
      if (blockDl.blocked) {
        throw new Error(blockDl.reason!);
      }
      const filename = msg.filename as string | undefined;
      const timeoutMs = (msg.timeout_ms as number | undefined) ?? 60000;

      // chrome.downloads goes through the extension's privileged network stack,
      // so it picks up the user's existing cookies for the URL's origin.
      // That's what makes authenticated downloads (Canvas docx, Stripe receipts,
      // GitHub release tarballs behind SSO) work without re-auth.
      const id = await chrome.downloads.download({
        url,
        filename,
        conflictAction: "uniquify",
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error(`download timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onChanged = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id !== id) return;
          const state = delta.state?.current;
          if (state === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            clearTimeout(timer);
            resolve();
          } else if (state === "interrupted") {
            chrome.downloads.onChanged.removeListener(onChanged);
            clearTimeout(timer);
            reject(new Error(`download interrupted: ${delta.error?.current ?? "unknown"}`));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      });

      const [item] = await chrome.downloads.search({ id });
      if (!item) throw new Error("download record vanished after completion");
      return {
        type: "download_file_response",
        requestId: msg.requestId,
        path: item.filename,
        mime: item.mime ?? "",
        size: item.fileSize ?? 0,
      };
    }

    case "fetch_url": {
      const url = msg.url as string;
      const blockFetch = isBlockedUrl(url);
      if (blockFetch.blocked) {
        throw new Error(blockFetch.reason!);
      }
      const method = (msg.method as string | undefined) ?? "GET";
      const reqHeaders = (msg.headers as Record<string, string> | undefined) ?? {};
      const body = msg.body as string | undefined;
      const binary = !!msg.binary;
      const timeoutMs = (msg.timeout_ms as number | undefined) ?? 30000;
      const maxBytes = (msg.max_bytes as number | undefined) ?? 2_000_000;

      // Privileged fetch: runs in the extension service-worker context, so:
      //  - extension's host_permissions (<all_urls>) apply; no page CSP
      //  - Chrome's cookie jar is included automatically for any origin
      //  - page's connect-src directive does not apply
      // This is what unblocks Canvas-style "page CSP says no" workflows.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: reqHeaders,
          body: body !== undefined && method !== "GET" && method !== "HEAD" ? body : undefined,
          signal: ctl.signal,
          credentials: "include",
        });
      } finally {
        clearTimeout(timer);
      }

      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      const contentType = resp.headers.get("content-type") ?? "";

      const buf = await resp.arrayBuffer();
      const totalBytes = buf.byteLength;
      const truncated = totalBytes > maxBytes;
      const clipped = truncated ? buf.slice(0, maxBytes) : buf;

      if (binary) {
        // Chunked base64 encode to avoid blowing the call stack on large bodies.
        const bytes = new Uint8Array(clipped);
        const CHUNK = 0x8000;
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += CHUNK) {
          parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
        }
        const body_base64 = btoa(parts.join(""));
        return {
          type: "fetch_url_response",
          requestId: msg.requestId,
          status: resp.status,
          status_text: resp.statusText,
          headers,
          content_type: contentType,
          body_base64,
          truncated,
          total_bytes: totalBytes,
        };
      }
      const body_text = new TextDecoder("utf-8", { fatal: false }).decode(clipped);
      // Anti-bot detection on text/html responses only (skip for json/xml/etc).
      // Useful when fetch_url lands on a Cloudflare challenge page instead of
      // the expected JSON body — surfaces the block as a structured signal so
      // the caller doesn't waste a debugging cycle on "why is my parse failing".
      const antiBotDetected = /text\/html/i.test(contentType)
        ? detectAntiBot(body_text)
        : null;
      return {
        type: "fetch_url_response",
        requestId: msg.requestId,
        status: resp.status,
        status_text: resp.statusText,
        headers,
        content_type: contentType,
        body_text,
        truncated,
        total_bytes: totalBytes,
        anti_bot_detected: antiBotDetected,
      };
    }

    default: {
      const tab = await getActiveTab(port);
      await pushInstanceInfoIfNeeded(tab, port);
      return forwardToContentScript(tab, msg);
    }
  }
}
