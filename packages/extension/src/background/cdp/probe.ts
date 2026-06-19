// Post-click activity probe + the visible-element baseline and in-flight
// request count that feed it.

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
export type ActivityProbeResult = {
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
 * Snapshot the shadow-pierce visible-element count for `tabId` BEFORE
 * a click is dispatched. The activity probe needs a baseline that pre-
 * dates any state change the click might trigger; if we baseline inside
 * the probe (post-click), Lit / Stencil renders that complete synchronously
 * during click dispatch end up already-counted and the delta reads 0
 * (Reddit's flair picker is the canonical case — open synchronously,
 * adds ~78 visible elements, post-click baseline matches post-render
 * state and the probe falsely reports silently_rejected).
 */
export async function snapshotVisibleCount(tabId: number): Promise<number | null> {
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

export async function runActivityProbe(
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
export async function countInFlightRequests(tabId: number): Promise<number> {
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
