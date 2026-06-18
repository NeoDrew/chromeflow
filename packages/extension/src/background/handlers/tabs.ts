// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, getWindowId, clearWindowId, ownedWindows, persistOwnedWindows } from "../state";
import { setupBeforeunloadAutoDismiss } from "../cdp";
import { isScriptableUrl } from "../policy";

export async function handleSwitchToTab(msg: McpMsg, port: number): Promise<unknown> {
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

export async function handleListTabs(msg: McpMsg, port: number): Promise<unknown> {
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

export async function handleCloseTab(msg: McpMsg, port: number): Promise<unknown> {
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

export async function handleCloseWindow(msg: McpMsg, port: number): Promise<unknown> {
      const wid = getWindowId(port);
      let closed = false;
      if (wid && ownedWindows.has(wid)) {
        // Dismiss any beforeunload guard on the active tab first, so a posting
        // with unsaved form state can't block window removal.
        try {
          const [active] = await chrome.tabs.query({ active: true, windowId: wid });
          const ctx = active?.id && isScriptableUrl(active.url)
            ? await setupBeforeunloadAutoDismiss(active.id)
            : null;
          await chrome.windows.remove(wid);
          if (ctx) await ctx.release();
          closed = true;
        } catch { /* window may already be gone */ }
        ownedWindows.delete(wid);
        await persistOwnedWindows();
      }
      await clearWindowId(port);
      return { type: "action_done", closed_window: closed ? wid : null };
}

export async function handleCloseOtherTabs(msg: McpMsg, port: number): Promise<unknown> {
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
