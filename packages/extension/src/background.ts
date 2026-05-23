/**
 * Background service worker.
 *
 * Message flow:
 *   Offscreen (WS) → background → content script (DOM ops)
 *   Content script → background → offscreen (responses + events)
 *   Background handles tab ops directly (screenshot, navigate, navigation watch).
 */

import { parseDoc, detectFormat, type SupportedFormat } from "./lib/parse-doc";

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
type ClickWatchResult = {
  type: string;
  url?: string;
  target?: { selector: string; text: string; tag: string; x: number; y: number } | null;
};
const pendingClicks = new Map<
  string,
  { port: number; cb: (result: ClickWatchResult) => void }
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
        entry.cb({ type: "click_detected", target: msg.target ?? null });
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

async function runActivityProbe(
  tabId: number,
  beforeUrl: string,
  windowMs: number = 1500
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
      func: (windowMs: number, beforeUrl: string) => {
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
          const focusedBefore = getFocused();
          const focusedKeyBefore = focusedBefore ? JSON.stringify(focusedBefore) : "";
          const signalsBefore = getSignalCounts();
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
          function check(): { activity: boolean; reason: string; url_changed: boolean } {
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
            const c = getSignalCounts();
            if (c.alert > signalsBefore.alert) return { activity: true, reason: "alert/aria-live element appeared", url_changed: false };
            if (c.toast > signalsBefore.toast) return { activity: true, reason: "toast / notification appeared", url_changed: false };
            if (c.modal > signalsBefore.modal) return { activity: true, reason: "modal / [role=dialog] appeared", url_changed: false };
            return { activity: false, reason: "", url_changed: false };
          }
          const start = Date.now();
          function tick() {
            const r = check();
            if (r.activity || Date.now() - start >= windowMs) {
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
      args: [windowMs, beforeUrl],
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
      const blockNav = isBlockedUrl(targetUrl);
      if (blockNav.blocked) {
        throw new Error(blockNav.reason!);
      }
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

      if (stuckSpinner || (expectSelector && expectSelectorAppeared === false)) {
        // Caller decides whether to navigate elsewhere — we don't auto-reload
        // because the same page might just need a few more seconds.
        return {
          type: "action_done",
          stuck_spinner: stuckSpinner,
          spinner_selector: spinnerSelector,
          expect_selector_appeared: expectSelectorAppeared,
          current_url: currentUrl,
        };
      }
      return { type: "action_done", current_url: currentUrl };
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
      await chrome.tabs.remove(target.id);
      return { type: "action_done", closed: [snapshot] };
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
      if (closeIds.length > 0) await chrome.tabs.remove(closeIds);
      return { type: "action_done", closed: closedSnapshot, kept: keptSnapshot };
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

      // captureVisibleTab + bitmap readback both flake intermittently on
      // heavy SPAs (the user reports "Request timed out" and "image readback
      // failed" mid-session, sometimes recovering after minutes). Retry with
      // exponential backoff before giving up; on terminal failure, attempt a
      // CDP Page.captureScreenshot fallback if the debugger is already
      // attached (no extra attach permission prompt).
      async function captureOnce(): Promise<{ dataUrl: string; via: "visibleTab" | "cdp" }> {
        return new Promise(async (resolve, reject) => {
          const wsTimer = setTimeout(() => reject(new Error("captureVisibleTab timed out after 10000ms")), 10_000);
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

      let capture: { dataUrl: string; via: "visibleTab" | "cdp" } | null = null;
      let lastErr: Error | null = null;
      const backoffMs = [0, 500, 1500];
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

      const runInjection = () => chrome.scripting.executeScript({
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

      // CSP blocked eval — fall back to CDP Runtime.evaluate which bypasses CSP
      if (cspBlocked) {
        try {
          await raceWithNavigation(withDebugger(tabId, async () => {
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
      };
      let prep: PrepResult | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        prep = await forwardToContentScript(tab, {
          type: "prepare_click_target",
          requestId: msg.requestId,
          textHint: msg.textHint,
          nth: msg.nth,
          within_selector: msg.within_selector,
          near_text: msg.near_text,
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
            // Skip the hidden first match by asking for nth=2 — findClickableAll
            // ranks visible candidates before hidden ones, so nth=2 lands on
            // the first visible peer (or a later visible candidate if there
            // are multiple hidden ones in front).
            nth: 2,
            within_selector: msg.within_selector,
            near_text: msg.near_text,
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

      // Fast-fail probe: watch the page for ANY observable activity in the
      // 1500ms after dispatch (DOM mutations, focus change, value/check
      // change, URL change, alert/toast/modal). When 0 activity is detected,
      // the click was almost certainly silently rejected by anti-bot
      // detection (isTrusted-strict React UIs, Reddit submit, X submit,
      // and similar handlers) and any until_* clause is guaranteed to time
      // out. Failing fast here saves up to 25s per failed click and tells
      // the agent to switch to highlight_region + wait_for_click for a
      // human gesture.
      //
      // Returns early as soon as activity is detected, so most clicks (which
      // do produce activity) add only ~100ms before continuing to the
      // existing until-poll / expect_submit / SPA-nav-wait flow.
      const probe = isScriptableUrl(tab.url) && tab.id
        ? await runActivityProbe(tab.id, before_url, 1500)
        : ({ activity: true, reason: "(non-scriptable; probe skipped)", mutation_count: 0, url_changed: false, after_url: before_url, focused_after: null } as ActivityProbeResult);

      if (!probe.activity) {
        // Opt-in last resort: walk the React fiber tree from the matched
        // element and invoke __reactProps$.onClick directly. Helps on React-
        // heavy SPAs whose action buttons pass through isTrusted=true checks
        // even on CDP-dispatched events. Auto-disabled (caller opts in via
        // try_fiber=true) because the fiber-prop path is undocumented and
        // could no-op or misbehave on non-React or mangled-prod builds.
        if (msg.try_fiber === true) {
          const fiberResult = await forwardToContentScript(tab, {
            type: "react_fiber_click",
            requestId: msg.requestId + "-fiber",
            textHint: msg.textHint,
            nth: msg.nth,
            within_selector: msg.within_selector,
            near_text: msg.near_text,
          }).catch((e) => ({ success: false, message: String(e), fired: false })) as {
            success: boolean; message: string; fired: boolean; component?: string; label?: string;
          };

          // Re-probe activity after the fiber invocation. If the onClick
          // handler actually did something (state change, navigation, mutation),
          // the second probe sees it and we fall through to the rest of the
          // click flow (until_*, expect_submit, etc).
          const probe2 = isScriptableUrl(tab.url) && tab.id
            ? await runActivityProbe(tab.id, before_url, 1500)
            : ({ activity: true, reason: "(non-scriptable; probe skipped)", mutation_count: 0, url_changed: false, after_url: before_url, focused_after: null } as ActivityProbeResult);

          if (probe2.activity) {
            // Fiber click succeeded. Continue with the existing flow (until_*
            // poll lower down). Stash a note so the success message records
            // that the fiber path was used.
            postNote += ` (fired via React fiber after CDP silently_rejected)`;
          } else {
            return {
              type: "click_element_response",
              success: false,
              message: `Clicked "${prep.label ?? msg.textHint}" but the page showed no sign of activity within 1500ms even after try_fiber=true (${fiberResult.fired ? "fiber onClick invoked, no DOM/URL/focus/alert change" : `no React fiber __reactProps$.onClick found: ${fiberResult.message}`}). Switch to highlight_region + wait_for_click so the user's real gesture fires the action.`,
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
            message: `Clicked "${prep.label ?? msg.textHint}" but the page showed no sign of activity within 1500ms (0 DOM mutations, no focus change, no URL change, no value/checked change, no alert/toast/modal). The click was likely silently rejected by anti-bot detection — isTrusted-strict React UIs, Reddit submit, X submit, and similar handlers all do this even though the synthetic click reports success. Switch to highlight_region + wait_for_click so the user's real gesture fires the action, or retry with try_fiber=true to walk __reactProps$.onClick directly on React-heavy SPAs. Until_* clauses are skipped here since the click never registered.`,
            before_url,
            after_url: probe.after_url,
            navigated: false,
            focused_after: probe.focused_after,
            silently_rejected: true,
          };
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
      const untilUrlChanges = msg.until_url_changes === true;
      const untilTimeoutMs = (msg.until_timeout_ms as number | undefined) ?? 5000;
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

      let untilResult: { ok: boolean; reason: string } | null = null;
      let navigationResult: string | null = null;

      if (hasUntil) {
        const start = Date.now();
        while (Date.now() - start < untilTimeoutMs) {
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

          await new Promise((r) => setTimeout(r, 250));
        }
        if (!untilResult) {
          const conditions = [
            untilSelector && `selector "${untilSelector}"`,
            untilUrlContains && `URL containing "${untilUrlContains}"`,
            untilTextContains && `text "${untilTextContains}"`,
            untilUrlChanges && `URL change`,
          ].filter(Boolean).join(" or ");
          untilResult = { ok: false, reason: `Click fired but ${conditions} did not appear within ${untilTimeoutMs}ms — the click may not have registered. Try execute_script with a direct .click() on the matched element, or pass a different until_* value.` };
        }
      } else if (expectSubmit) {
        // expect_submit: poll for any anti-bot-friendly submit signal within
        // 4s. Catches the "synthetic click silently rejected" case on Reddit /
        // X / and similar handlers without needing a specific until_* destination.
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
            reason: `submit silently rejected (likely anti-bot): no URL change, toast, alert, or modal appeared within 4s. Synthetic clicks fail on Reddit / X / and similar handlers / mcp.so even though isTrusted passes — pre-fill the form, then highlight + wait_for_click so a real human gesture fires the submit.`,
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
        return { type: "click_element_response", success: untilResult.ok, message, before_url, after_url, navigated, focused_after: probe.focused_after };
      }

      message = navigationResult
        ? `Clicked and navigated to ${navigationResult}`
        : result.message;

      if (alertMessage) {
        message += `\n\nPAGE ALERT: "${alertMessage}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
      }

      return { type: "click_element_response", success: true, message, before_url, after_url, navigated, focused_after: probe.focused_after };
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
              if (clearFirst) {
                try { document.execCommand("selectAll"); } catch { /* ignore */ }
                try { document.execCommand("delete"); } catch { /* ignore */ }
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

      // Ask content script to find and tag the file input. The content script
      // uses queryAllDeep, which pierces open AND closed shadow roots — file
      // inputs hidden behind Stencil/Lit/Radix drag-zones are reachable.
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

      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (sel: string, pName: string, callArgs: unknown[], depth: number, frameSel: string | undefined) => {
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
        args: [selector, propName, args, maxDepth, frameSelector],
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
      };
    }

    default: {
      const tab = await getActiveTab(port);
      return forwardToContentScript(tab, msg);
    }
  }
}
