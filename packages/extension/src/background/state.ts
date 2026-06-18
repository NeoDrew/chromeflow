// Shared connection / window / port state for the background service worker.
// Single source of truth for portMeta, connScope, claudeInstances, ownedWindows,
// and the messaging + tab helpers built on them. Extracted verbatim from
// background.ts; the chrome.* listeners that MAINTAIN this state live here too so
// the state and its upkeep stay in one module.
import { isBlockedUrl, isScriptableUrl, httpHostname } from "./policy";
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

export async function persistOwnedWindows(): Promise<void> {
  await chrome.storage.local.set({ chromeflowOwnedWindows: [...ownedWindows] });
}

/** Drop a connection's window assignment (frees the window for nothing). */
export async function clearWindowId(port: number): Promise<void> {
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
      const [tab] = await chrome.tabs.query({ active: true, windowId: wid });
      if (tab?.id) return tab;
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
    if (newTab?.id) return newTab;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Created new Chrome window but its active tab never appeared.");
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
