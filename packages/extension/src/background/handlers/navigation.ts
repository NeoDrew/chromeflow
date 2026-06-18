// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, getWindowId, connScope, pushInstanceInfoIfNeeded, tabsWithInfoBox } from "../state";
import { setupBeforeunloadAutoDismiss } from "../cdp";
import { isBlockedUrl, isScriptableUrl, detectAntiBot, httpHostname } from "../policy";
import { scopeBlocks } from "../../connections";

export async function handleNavigate(msg: McpMsg, port: number): Promise<unknown> {
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
      // Scope guard on the DESTINATION, not just the current tab: without this a
      // scoped connection could navigate out of its allowed domains.
      if (connScope.has(port)) {
        const navHost = httpHostname(targetUrl);
        if (navHost) {
          const v = scopeBlocks(connScope.get(port), navHost);
          if (v.blocked) throw new Error("chromeflow: " + v.reason);
        }
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

      // Post-navigation scope re-check: the approved target URL may have
      // redirected (3xx / JS) onto an out-of-scope host. Refuse here, BEFORE we
      // read any page content below, so a redirect can't be used to escape scope
      // or leak the landed page. Read the tab's authoritative committed URL
      // (chrome.tabs.get) rather than the in-page settle probe's location.href,
      // which is skipped on non-scriptable pages or if the probe threw.
      if (connScope.has(port)) {
        let landedUrl = currentUrl;
        try {
          if (targetTab.id) {
            const fresh = await chrome.tabs.get(targetTab.id);
            if (fresh.url) landedUrl = fresh.url;
          }
        } catch { /* tab closed mid-nav — fall back to the probed url */ }
        const landedHost = httpHostname(landedUrl);
        if (landedHost) {
          const v = scopeBlocks(connScope.get(port), landedHost);
          if (v.blocked) {
            throw new Error("chromeflow: navigation redirected out of scope — " + v.reason);
          }
        }
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
