// Shared connection / window / port state for the background service worker.
// Single source of truth for portMeta, connScope, claudeInstances, ownedWindows,
// and the messaging + tab helpers built on them. Extracted verbatim from
// background.ts; the chrome.* listeners that MAINTAIN this state live here too so
// the state and its upkeep stay in one module.
import { isBlockedUrl, isScriptableUrl, httpHostname } from "./policy";
import { setupBeforeunloadAutoDismiss } from "./cdp";
import {
  CONNECTIONS_STORAGE_KEY,
  CONFIG_MSG_SOURCE,
  SYNTHETIC_CONNID_BASE,
  scopeBlocks,
  type ConnConfig,
  type ConnScope,
} from "../connections";

export const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");

// ─── Per-instance Claude window assignments ────────────────────────────────
// Per-port instance metadata (label, host) from the WS identity handshake.
// Populated via the offscreen "status" broadcast so the background can push
// instance info to the content script for the info box overlay.
export const portMeta = new Map<number, { label?: string; host?: string }>();

// Per-connection domain scope (allow/deny host globs), keyed by connId (== the
// routing "port"). Only scoped connections get an entry; default/unscoped
// connections are absent here so scopeBlocks never restricts them. Kept in sync
// with chrome.storage.local by refreshConnScope.
export const connScope = new Map<number, ConnScope>();

// Each Claude Code instance is identified by the WebSocket port it connects on
// (7878-7888). Each instance can be assigned its own Chrome window so multiple
// CC instances can run automations in parallel without colliding.
export let claudeInstances: Record<string, number> = {};

// Windows chromeflow itself created for a connection (vs. a window the user
// hand-assigned via the popup's "Use this window"). Remote connections only ever
// drive a chromeflow-owned window, so a hosted agent can never take over the
// user's own tabs (e.g. their JobDog dashboard window). Persisted so it survives
// service-worker restarts mid-run.
export let ownedWindows = new Set<number>();

// The tab THIS connection's calls should keep targeting, independent of
// whichever tab Chrome currently reports as "active" in the assigned window.
// A single WS port is shared by a whole Claude Code session, including any
// subagent it spawns via the Agent/Task tool — those share the parent's
// connection, not a separate one. Without pinning, one caller opening or
// focusing a tab (a subagent's open_page, or the user clicking around) would
// silently redirect every other in-flight caller's next getActiveTab() call
// onto that tab. In-memory only: a service-worker restart just means the next
// getActiveTab() re-resolves from whatever's actually active and re-pins, a
// one-time re-sync rather than a failure.
const pinnedTabId = new Map<number, number>();

export function setPinnedTab(port: number, tabId: number): void {
  pinnedTabId.set(port, tabId);
}

/** Synchronous read of the pinned tab, for call sites that only need the id
 * (e.g. matching a navigation event) without paying for a chrome.tabs.get. */
export function getPinnedTab(port: number): number | undefined {
  return pinnedTabId.get(port);
}

/**
 * Final post-click read of "what tab is active now", used by click handlers
 * to compute after_url/navigated for their response. If the click opened or
 * activated a DIFFERENT tab (e.g. a target="_blank" link), this follows it —
 * repinning so subsequent calls land where the response just said the flow
 * went, instead of on the stale tab the click was fired from. Distinct from a
 * plain active-tab read: call this only for a one-shot "the click is done,
 * what happened" check, not from inside an until-clause poll loop (repeatedly
 * pinning to a transiently-active tab mid-poll could stick chromeflow onto an
 * unrelated tab, e.g. a popup, well before the click's real outcome settles).
 */
export async function resolvePostClickTab(port: number, windowId: number): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id) pinnedTabId.set(port, tab.id);
  return tab;
}

// ─── Per-port request serialization ────────────────────────────────────────
// Chains each port's requests onto a settled tail promise so they execute
// strictly one at a time, in arrival order, regardless of which caller (the
// parent session or a subagent sharing its connection) sent them. A task's
// own success/failure still resolves independently to its own caller; only
// the ORDER is serialized. Shared by the MCP message dispatcher in
// background.ts AND the disconnect auto-close below, so a grace-timer close
// can never land mid-way through an in-flight request for the same port.
const portQueueTails = new Map<number, Promise<unknown>>();

export function runSerializedOnPort<T>(port: number, task: () => Promise<T>): Promise<T> {
  const tail = portQueueTails.get(port) ?? Promise.resolve();
  const run = tail.then(task, task);
  // Store a settled-safe continuation so one task's rejection never poisons
  // the chain for the next queued task on this port.
  portQueueTails.set(port, run.then(() => {}, () => {}));
  return run;
}

export async function persistOwnedWindows(): Promise<void> {
  await chrome.storage.local.set({ chromeflowOwnedWindows: [...ownedWindows] });
}

/** Drop a connection's window assignment (frees the window for nothing). */
export async function clearWindowId(port: number): Promise<void> {
  pinnedTabId.delete(port);
  if (claudeInstances[String(port)] === undefined) return;
  delete claudeInstances[String(port)];
  await chrome.storage.local.set({ claudeInstances });
}

chrome.storage.local.get(["claudeInstances", "claudeWindowId", "chromeflowOwnedWindows"]).then(async ({ claudeInstances: stored, claudeWindowId: legacy, chromeflowOwnedWindows: owned }) => {
  claudeInstances = (stored as Record<string, number>) ?? {};
  ownedWindows = new Set(Array.isArray(owned) ? (owned as number[]) : []);
  // Migrate legacy single-window storage → port 7878 instance
  if (typeof legacy === "number" && claudeInstances["7878"] === undefined) {
    claudeInstances["7878"] = legacy;
    await chrome.storage.local.set({ claudeInstances });
    await chrome.storage.local.remove("claudeWindowId");
  }
  // Seed the scope map and hand offscreen its connection set on boot. (Offscreen
  // also asks for it via request-config, but pushing here covers the case where
  // offscreen is already up when the service worker restarts.)
  await pushConnectionsToOffscreen();
});
chrome.storage.onChanged.addListener((changes) => {
  if ("claudeInstances" in changes) {
    claudeInstances = (changes.claudeInstances.newValue as Record<string, number>) ?? {};
  }
  // Popup edits write CONNECTIONS_STORAGE_KEY; re-derive scope and re-push so
  // offscreen reconciles sockets and enforcement updates in one place.
  if (CONNECTIONS_STORAGE_KEY in changes) {
    pushConnectionsToOffscreen();
  }
});

// When a window closes (the user, or a run's close_window), forget it: drop any
// connection assignment pointing at it and remove it from the owned set, so a
// freed window is never reused stale and assignments do not leak.
chrome.windows.onRemoved.addListener((windowId) => {
  let changed = false;
  for (const [portStr, wid] of Object.entries(claudeInstances)) {
    if (wid === windowId) {
      delete claudeInstances[portStr];
      pinnedTabId.delete(Number(portStr));
      changed = true;
    }
  }
  if (changed) chrome.storage.local.set({ claudeInstances }).catch(() => {});
  if (ownedWindows.delete(windowId)) persistOwnedWindows().catch(() => {});
});

export function getWindowId(port: number): number | null {
  return claudeInstances[String(port)] ?? null;
}

export async function setWindowId(port: number, windowId: number): Promise<void> {
  claudeInstances[String(port)] = windowId;
  await chrome.storage.local.set({ claudeInstances });
}

// ─── Configured connections (scope + offscreen push) ───────────────────────

export async function loadConnections(): Promise<ConnConfig[]> {
  const { [CONNECTIONS_STORAGE_KEY]: stored } = await chrome.storage.local.get(CONNECTIONS_STORAGE_KEY);
  return Array.isArray(stored) ? (stored as ConnConfig[]) : [];
}

// Rebuild the connScope map from the stored configs. Only configs that carry a
// non-empty allow OR deny become entries — a config with neither stays
// unrestricted (absent from the map), preserving the "absent = unrestricted"
// contract scopeBlocks relies on.
export function refreshConnScope(configs: ConnConfig[]): void {
  connScope.clear();
  for (const cfg of configs) {
    const hasAllow = Array.isArray(cfg.allow) && cfg.allow.length > 0;
    const hasDeny = Array.isArray(cfg.deny) && cfg.deny.length > 0;
    if (hasAllow || hasDeny) {
      connScope.set(cfg.connId, { allow: cfg.allow, deny: cfg.deny });
    }
  }
}

// Background owns the connection config: it loads from storage, refreshes the
// local scope map, and forwards the full set to offscreen (which owns socket
// lifecycle). Offscreen requests this on boot and we re-push on any storage
// change, so the two stay reconciled without offscreen ever touching storage.
export async function pushConnectionsToOffscreen(): Promise<void> {
  const configs = await loadConnections();
  refreshConnScope(configs);
  chrome.runtime
    .sendMessage({ source: CONFIG_MSG_SOURCE, type: "connections", connections: configs })
    .catch(() => {});
}

// Pending click-watch callbacks keyed by requestId. Each entry tracks the
// source port so we know which Claude window's tabs to watch.
export type ClickWatchResult = {
  type: string;
  url?: string;
  target?: { selector: string; text: string; tag: string; x: number; y: number } | null;
  redispatched?: boolean;
  redispatch_activity?: boolean;
};
export const pendingClicks = new Map<
  string,
  { port: number; redispatch?: boolean; cb: (result: ClickWatchResult) => void }
>();

// Recent navigation completions per tab — used to resolve click-watches that
// register AFTER the navigation already fired (race condition when the user
// clicks a link and the page loads before wait_for_click is processed).
export const recentNavigations = new Map<number, { url: string; time: number }>();

export async function ensureOffscreen() {
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
export async function ensureMarkerPrefix() {
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

export async function getActiveTab(port: number): Promise<chrome.tabs.Tab> {
  // Remote (hosted) connections must ONLY ever drive a window chromeflow created
  // for them - never the user's own window. A user-assigned window (e.g. the one
  // their JobDog dashboard is in, set via "Use this window") is ignored for
  // remotes, so the agent can't take over their tabs. Local Claude Code
  // connections keep the existing behaviour (they may hand-assign a window).
  const isRemote = port >= SYNTHETIC_CONNID_BASE;
  let wid = getWindowId(port);

  if (wid) {
    const trusted = !isRemote || ownedWindows.has(wid);
    if (trusted) {
      // Prefer the tab THIS connection last pinned over "whatever Chrome
      // currently reports active" — another caller sharing this port (a
      // subagent, or the user) may have focused a different tab in the
      // meantime, and silently following that would hijack an in-progress
      // flow (see pinnedTabId above).
      const pinned = pinnedTabId.get(port);
      if (pinned !== undefined) {
        try {
          const tab = await chrome.tabs.get(pinned);
          if (tab.windowId === wid) return tab;
        } catch {
          // Pinned tab was closed — fall through to re-resolve below.
        }
      }
      const [tab] = await chrome.tabs.query({ active: true, windowId: wid });
      if (tab?.id) {
        pinnedTabId.set(port, tab.id);
        return tab;
      }
    }
    // Stale (window gone) or untrusted (remote pointed at a user window): drop
    // the assignment and create a dedicated window below.
    wid = null;
    await clearWindowId(port);
  }

  // Create a brand-new window so chromeflow only ever operates on tabs it opened
  // itself. Remote runs open it UNFOCUSED so a background agent never yanks the
  // user's view to it; local connections stay focused as before.
  const win = await chrome.windows.create({ focused: !isRemote, url: "about:blank" });
  if (!win?.id) throw new Error("Failed to create a new Chrome window for this connection.");
  await setWindowId(port, win.id);
  ownedWindows.add(win.id);
  await persistOwnedWindows();

  // Poll briefly for the new window's active tab to be ready.
  for (let i = 0; i < 20; i++) {
    const [newTab] = await chrome.tabs.query({ active: true, windowId: win.id });
    if (newTab?.id) {
      pinnedTabId.set(port, newTab.id);
      return newTab;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Created new Chrome window but its active tab never appeared.");
}

/**
 * Close the window chromeflow created for `port`, if any — shared core for
 * the explicit `close_window` tool and the disconnect auto-close below.
 * Never touches a window the user hand-assigned via "Use this window" (only
 * ownedWindows members are ever closed here). Dismisses any beforeunload
 * guard first so a page with unsaved form state (a half-typed Reddit post)
 * can't hang chrome.windows.remove waiting for a confirmation nobody will
 * answer. Returns the closed window id, or null if there was nothing to close
 * or the removal itself failed.
 */
export async function closeOwnedWindowForPort(port: number): Promise<number | null> {
  const wid = getWindowId(port);
  if (!wid || !ownedWindows.has(wid)) return null;
  let closed = false;
  try {
    // Guard the pinned tab, not Chrome's raw "active" tab — the whole point
    // of pinning is that they can diverge, and it's the pinned tab that's
    // most likely to be mid-flow with unsaved state.
    const pinned = pinnedTabId.get(port);
    const active = pinned !== undefined
      ? await chrome.tabs.get(pinned).catch(() => undefined)
      : (await chrome.tabs.query({ active: true, windowId: wid }))[0];
    const ctx = active?.id && isScriptableUrl(active.url)
      ? await setupBeforeunloadAutoDismiss(active.id)
      : null;
    await chrome.windows.remove(wid);
    if (ctx) await ctx.release();
    closed = true;
  } catch { /* window may already be gone */ }
  ownedWindows.delete(wid);
  await persistOwnedWindows();
  await clearWindowId(port);
  return closed ? wid : null;
}

// Grace period between a port's connection dropping and chromeflow auto-
// closing the window it owns. Covers transient disconnects — an extension
// reload, a brief network blip, the sticky MCP-server process restarting —
// so a live session's window is never yanked out from under it just because
// the WS hiccuped. Only fires for windows chromeflow itself created; a
// window the user hand-assigned is never auto-closed.
const WINDOW_AUTOCLOSE_GRACE_MS = 60_000;
// Bound on top of the grace period: if a same-port task is still ahead of the
// close in the queue this long after the port was confirmed gone, stop
// waiting behind it and close directly. A port that's been dark for
// grace+this-long can never deliver that task's result to anyone anyway, so
// there's nothing left to protect by continuing to wait — this only trades
// "possibly interrupt an orphaned task" for "definitely don't leak the
// window forever behind a caller-supplied wait_for_click(timeout: huge)".
const WINDOW_FORCECLOSE_AFTER_MS = 30_000;
const disconnectCloseTimers = new Map<number, ReturnType<typeof setTimeout>>();
let lastLivePorts = new Set<number>();

/**
 * Called on every offscreen "status" broadcast (the live set of connected WS
 * ports). Diffs against the previous broadcast: a port that just disappeared
 * gets a grace-period close timer for its owned window (if any); a port that
 * reappears before its timer fires has the timer cancelled. This is what
 * turns "an agent session ended" into "its window closes" without needing a
 * daemon — the offscreen document already tracks connect/disconnect, this
 * just reacts to it.
 */
export function reconcileLiveConnections(livePorts: number[]): void {
  const nowLive = new Set(livePorts);
  for (const port of nowLive) {
    const timer = disconnectCloseTimers.get(port);
    if (timer) {
      clearTimeout(timer);
      disconnectCloseTimers.delete(port);
    }
  }
  for (const port of lastLivePorts) {
    if (nowLive.has(port) || disconnectCloseTimers.has(port)) continue;
    const wid = getWindowId(port);
    if (!wid || !ownedWindows.has(wid)) continue;
    const timer = setTimeout(() => {
      disconnectCloseTimers.delete(port);
      // Route through the same per-port queue as every MCP request so this
      // can never land mid-way through an in-flight task for the port (e.g.
      // a click that's already resolved its tab and is mid-interaction) —
      // UNLESS the queue is still stuck behind that task WINDOW_FORCECLOSE_
      // AFTER_MS later, in which case close directly rather than wait forever.
      let queueCleared = false;
      runSerializedOnPort(port, () => closeOwnedWindowForPort(port))
        .then(() => { queueCleared = true; }, () => { queueCleared = true; });
      setTimeout(() => {
        if (!queueCleared) closeOwnedWindowForPort(port).catch(() => {});
      }, WINDOW_FORCECLOSE_AFTER_MS);
    }, WINDOW_AUTOCLOSE_GRACE_MS);
    disconnectCloseTimers.set(port, timer);
  }
  lastLivePorts = nowLive;
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
export async function forwardToContentScript(
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
export function waitForNavigation(tabId: number, timeoutMs: number): Promise<string | null> {
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

export function sendToContentScript(tabId: number, msg: object): Promise<unknown> {
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

export const tabsWithInfoBox = new Set<number>();

export async function pushInstanceInfoIfNeeded(portOrTab: number | chrome.tabs.Tab, port: number) {
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

// Extract the hostname of an http(s) URL, or null for anything else. Non-http(s)
// schemes (about:blank, chrome://, file://, data:) are treated as unscoped, so a
// scoped connection can still operate on internal pages.
// Gate the privileged-fetch tools (read_attachment, download_file, fetch_url,
// inspect_request_headers). These act with the EXTENSION's authority and the
// user's full cookie jar, and never open a tab, so the owned-window sandbox does
// not constrain them. A REMOTE connection must therefore be confined to its
// configured scope; an UNSCOPED remote is denied outright (fail closed) so a
// hosted agent can't read arbitrary authenticated origins (Gmail, Stripe,
// internal admin, etc.). Local connections keep full access, scoped only if the
// user explicitly set a scope. Throws (→ ok:false) when the fetch is not allowed.
export function guardPrivilegedFetch(port: number, url: string): void {
  const blocked = isBlockedUrl(url);
  if (blocked.blocked) throw new Error(blocked.reason!);

  const isRemote = port >= SYNTHETIC_CONNID_BASE;
  if (isRemote && !connScope.has(port)) {
    throw new Error(
      "chromeflow: this remote connection has no domain scope, so privileged fetch " +
        "(read_attachment / download_file / fetch_url / inspect_request_headers) is " +
        "denied. Configure an allow-scope on the connection to enable it.",
    );
  }
  if (connScope.has(port)) {
    const host = httpHostname(url);
    if (isRemote && !host) {
      // file:/data:/blob:/chrome: — unscopable and off-limits for a remote.
      throw new Error("chromeflow: remote privileged fetch is limited to in-scope http(s) URLs.");
    }
    if (host) {
      const v = scopeBlocks(connScope.get(port), host);
      if (v.blocked) throw new Error("chromeflow: " + v.reason);
    }
  }
}
