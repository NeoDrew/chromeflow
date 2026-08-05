/**
 * Background service worker.
 *
 * Message flow:
 *   Offscreen (WS) → background → content script (DOM ops)
 *   Content script → background → offscreen (responses + events)
 *   Background handles tab ops directly (screenshot, navigate, navigation watch).
 *
 * This file is the THIN ENTRY: it wires the chrome.* event listeners and
 * dispatches each MCP message to a domain handler. Shared connection/window
 * state lives in ./background/state, the CDP cluster in ./background/cdp, and
 * each message handler in ./background/handlers/*.
 */

import { httpHostname, isScriptableUrl } from "./background/policy";
import { scopeBlocks } from "./connections";
import {
  connScope,
  getWindowId,
  getActiveTab,
  getPinnedTab,
  forwardToContentScript,
  pushInstanceInfoIfNeeded,
  pushConnectionsToOffscreen,
  pendingClicks,
  recentNavigations,
  portMeta,
  reconcileLiveConnections,
  runSerializedOnPort,
  DEFAULT_QUEUE_WATCHDOG_MS,
  type ClickWatchResult,
} from "./background/state";
import {
  injectAlertCapture,
  dispatchHumanMouseClick,
  runActivityProbe,
  type ActivityProbeResult,
} from "./background/cdp";
import {
  handleNavigate,
} from "./background/handlers/navigation";
import {
  handleSwitchToTab,
  handleListTabs,
  handleCloseTab,
  handleCloseWindow,
  handleCloseOtherTabs,
} from "./background/handlers/tabs";
import {
  handleInteractiveSnapshot,
} from "./background/handlers/snapshot";
import {
  handleScreenshot,
} from "./background/handlers/capture";
import {
  handleStartClickWatch,
  handleWaitForSelector,
} from "./background/handlers/watch";
import {
  handleExecuteScript,
} from "./background/handlers/script";
import {
  handleClickElement,
} from "./background/handlers/click";
import {
  handleClickAtCoordinates,
  handleReactSetInput,
  handleReactCallProp,
} from "./background/handlers/react";
import {
  handleTypeText,
} from "./background/handlers/type";
import {
  handleSetFileInput,
} from "./background/handlers/files";
import {
  handleInspectRequestHeaders,
  handleReadAttachment,
  handleDownloadFile,
  handleFetchUrl,
} from "./background/handlers/fetch";

// ─── Inbound messages ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // A web page asked (via the content-script relay) to add a connection. Open
  // the connection window PRE-FILLED with the URL so the user only has to click
  // "Add" (the consent step) - no copy-paste, but a page still cannot connect
  // the browser without that explicit confirmation.
  if (msg.type === "chromeflow-web-connect" && typeof msg.url === "string" && msg.url) {
    const params = new URLSearchParams({ url: msg.url });
    if (typeof msg.label === "string" && msg.label) params.set("label", msg.label);
    if (typeof msg.origin === "string" && msg.origin) params.set("origin", msg.origin);
    chrome.windows.create({
      url: chrome.runtime.getURL("connect.html") + "?" + params.toString(),
      type: "popup",
      width: 480,
      height: 720,
      focused: true,
    });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.source === "chromeflow-offscreen") {
    // Status broadcasts carry the list of currently-connected WS ports.
    // Persist to chrome.storage.local so the popup can render them.
    if (msg.type === "status") {
      const livePorts = (msg.livePorts as Array<{ port: number; label?: string; host?: "claude" | "codex" }>) ?? [];
      chrome.storage.local.set({ chromeflowLivePorts: livePorts }).catch(() => {});
      for (const lp of livePorts) {
        portMeta.set(lp.port, { label: lp.label, host: lp.host });
      }
      // A port that just dropped out of this list gets a grace-period close
      // timer for its owned window; a port that reappeared cancels its timer.
      reconcileLiveConnections(livePorts.map((lp) => lp.port));
      sendResponse({ ok: true });
      return true;
    }
    // Offscreen asks for the connection set on its boot. Answer asynchronously
    // (load from storage, refresh scope, push) and ack once dispatched.
    if (msg.type === "request-config") {
      pushConnectionsToOffscreen().finally(() => sendResponse({ ok: true }));
      return true;
    }
    const port: number = typeof msg.port === "number" ? msg.port : 7878;
    // Serialize per port: a single WS connection is shared by a whole Claude
    // Code session, including any subagent it spawns (Agent/Task tool calls
    // share the parent's connection, not a separate one). Without this, two
    // calls arriving close together — a parent mid-flow and a subagent acting
    // on the same shared window — would run concurrently and race on the same
    // tab. Queuing them FIFO per port means they still run one at a time even
    // when nothing else changes.
    //
    // start_click_watch (wait_for_click) and wait_for_selector (wait_for) are
    // the two message types that are SUPPOSED to run long — each already
    // enforces its own bounded settlement via a caller-supplied timeout. Size
    // their queue watchdog off that instead of the generic default, so a
    // real multi-minute wait_for_click doesn't trip the safety net meant for
    // genuinely-hung calls.
    const payload = msg.payload as { type?: string; timeout?: number };
    const isLongPoll = payload?.type === "start_click_watch" || payload?.type === "wait_for_selector";
    const watchdogMs = isLongPoll
      ? (typeof payload.timeout === "number" ? payload.timeout : 120_000) + 15_000
      : DEFAULT_QUEUE_WATCHDOG_MS;
    runSerializedOnPort(port, () => handleMcpMessage(msg.payload, port), watchdogMs)
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
              // Redispatch on the tab THIS port is pinned to, not whatever
              // Chrome currently reports active — another caller sharing the
              // port may have focused a different tab since the click fired.
              const pinnedId = getPinnedTab(entry.port);
              const tab = pinnedId ? await chrome.tabs.get(pinnedId).catch(() => null) : null;
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
    // Resolve the pending click-watch only when the navigation happened on
    // the tab THIS port is pinned to — not whatever Chrome reports active,
    // which another caller sharing the port may have changed since the
    // watch started. An unassigned/unpinned port can never match.
    if (getPinnedTab(entry.port) === tabId) {
      pendingClicks.delete(requestId);
      entry.cb({ type: "navigation_complete", url });
    }
  }

  // Re-inject alert capture on every page load so dialogs never block
  if (isScriptableUrl(url)) {
    injectAlertCapture(tabId);
  }
});

// ─── MCP message handler ───────────────────────────────────────────────────

async function handleMcpMessage(msg: {
  type: string;
  requestId: string;
  [key: string]: unknown;
}, port: number): Promise<unknown> {
  // Domain-scope choke point: if this connection is scoped, refuse any action
  // whose active tab is on a host the scope blocks. This runs before every
  // handler so a single check covers click/type/read/etc. without touching each
  // case. navigate/fetch_url additionally guard their TARGET url below so the
  // agent can't escape scope by navigating out. The thrown error flows to the
  // dispatch .catch and becomes an ok:false response.
  if (connScope.has(port)) {
    const wid = getWindowId(port);
    if (wid) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: wid });
      const host = httpHostname(tab?.url);
      if (host) {
        const v = scopeBlocks(connScope.get(port), host);
        if (v.blocked) throw new Error("chromeflow: " + v.reason);
      }
    }
  }

  switch (msg.type) {
    case "navigate":
      return handleNavigate(msg, port);
    case "switch_to_tab":
      return handleSwitchToTab(msg, port);
    case "list_tabs":
      return handleListTabs(msg, port);
    case "interactive_snapshot":
      return handleInteractiveSnapshot(msg, port);
    case "close_tab":
      return handleCloseTab(msg, port);
    case "close_window":
      return handleCloseWindow(msg, port);
    case "close_other_tabs":
      return handleCloseOtherTabs(msg, port);
    case "screenshot":
      return handleScreenshot(msg, port);
    case "start_click_watch":
      return handleStartClickWatch(msg, port);
    case "wait_for_selector":
      return handleWaitForSelector(msg, port);
    case "execute_script":
      return handleExecuteScript(msg, port);
    case "click_element":
      return handleClickElement(msg, port);
    case "click_at_coordinates":
      return handleClickAtCoordinates(msg, port);
    case "type_text":
      return handleTypeText(msg, port);
    case "set_file_input":
      return handleSetFileInput(msg, port);
    case "react_set_input":
      return handleReactSetInput(msg, port);
    case "react_call_prop":
      return handleReactCallProp(msg, port);
    case "inspect_request_headers":
      return handleInspectRequestHeaders(msg, port);
    case "read_attachment":
      return handleReadAttachment(msg, port);
    case "download_file":
      return handleDownloadFile(msg, port);
    case "fetch_url":
      return handleFetchUrl(msg, port);
    default: {
      const tab = await getActiveTab(port);
      await pushInstanceInfoIfNeeded(tab, port);
      return forwardToContentScript(tab, msg);
    }
  }
}
