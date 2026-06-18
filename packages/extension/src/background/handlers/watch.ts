// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, getWindowId, pendingClicks, recentNavigations, forwardToContentScript, type ClickWatchResult } from "../state";
import { isScriptableUrl } from "../policy";

export async function handleStartClickWatch(msg: McpMsg, port: number): Promise<unknown> {
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

export async function handleWaitForSelector(msg: McpMsg, port: number): Promise<unknown> {
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
