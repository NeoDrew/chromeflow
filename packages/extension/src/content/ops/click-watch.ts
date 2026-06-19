import { clearAllOverlays } from "../highlight.js";

// ─── Pre-armed click buffer ─────────────────────────────────────────────────
// Arms a click listener as soon as a highlight is shown, so that if the user
// clicks before wait_for_click is called, the click is not missed.

type CapturedClickTarget = {
  selector: string;
  text: string;
  tag: string;
  x: number;
  y: number;
};

// Module-level pre-click buffer state. Shared between armClickBuffer (armed by
// the highlight ops) and the start_click_watch handler in ops/click.ts.
export let pendingPreClick: CapturedClickTarget | false = false;
export let preClickCleanup: (() => void) | null = null;

export function setPendingPreClick(v: CapturedClickTarget | false): void {
  pendingPreClick = v;
}
export function setPreClickCleanup(v: (() => void) | null): void {
  preClickCleanup = v;
}

/**
 * Build a best-effort CSS selector for an element. Walks up to 5 ancestors,
 * preferring id > class chain > tag:nth-of-type at each level. Cheap and
 * generally unique enough for one-shot lookups; not guaranteed unique across
 * the whole document.
 */
function cssPath(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let d = 0; d < 5 && cur; d++) {
    if (cur.id) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const tag = cur.tagName.toLowerCase();
    const parent = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const sameTag = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
    if (sameTag.length === 1) {
      parts.unshift(tag);
    } else {
      const idx = sameTag.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
    }
    cur = parent;
  }
  return parts.join(" > ");
}

function captureClickTarget(target: EventTarget | null, x: number, y: number): CapturedClickTarget | null {
  if (!(target instanceof Element)) return null;
  return {
    selector: cssPath(target).slice(0, 200),
    text: (target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
    tag: target.tagName.toLowerCase(),
    x: Math.round(x),
    y: Math.round(y),
  };
}

export function armClickBuffer() {
  // Reset any previous buffer
  preClickCleanup?.();
  pendingPreClick = false;

  const onPointerDown = (e: PointerEvent) => {
    const { clientX, clientY } = e;
    // Capture the underlying element BEFORE clearAllOverlays — the overlay is
    // the topmost element at this point, so we want the real click target.
    const underlying = document.elementFromPoint(clientX, clientY);
    pendingPreClick = captureClickTarget(underlying ?? e.target, clientX, clientY) ?? false;
    clearAllOverlays(); // remove the highlight as soon as the user clicks
    // Forward focus to the underlying element (the overlay intercepted the click,
    // so the input was never focused — fix that before fill_input is called).
    requestAnimationFrame(() => {
      if (underlying instanceof HTMLElement) underlying.focus();
    });
    cleanup();
  };

  const cleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown as EventListener, true);
    preClickCleanup = null;
  };

  preClickCleanup = cleanup;
  document.addEventListener("pointerdown", onPointerDown as EventListener, { capture: true, once: true });
}

// ─── Click watching ────────────────────────────────────────────────────────

export function startClickWatch(requestId: string) {
  let done = false;

  const notify = (clientX?: number, clientY?: number, target?: EventTarget | null) => {
    if (done) return;
    done = true;
    cleanup();
    clearAllOverlays();
    let captured: CapturedClickTarget | null = null;
    if (clientX !== undefined && clientY !== undefined) {
      const underlying = document.elementFromPoint(clientX, clientY);
      captured = captureClickTarget(underlying ?? target ?? null, clientX, clientY);
      requestAnimationFrame(() => {
        if (underlying instanceof HTMLElement) underlying.focus();
      });
    } else if (target) {
      captured = captureClickTarget(target, 0, 0);
    }
    chrome.runtime.sendMessage({
      source: "chromeflow-content",
      type: "click_detected",
      requestId,
      target: captured,
    });
  };

  const onPointerDown = (e: PointerEvent) => notify(e.clientX, e.clientY, e.target);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "Tab") notify(undefined, undefined, e.target);
  };

  // Shadow DOM fallback: MutationObserver on document catches main-document
  // mutations, but misses state changes inside shadow roots (annotation-dashboard
  // panels, Lit components flipping visibility). Poll a shadow-pierce visible-element
  // count as a backup signal: if the count changes by >= 5 after the watch
  // starts, the user likely clicked and something happened.
  const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
  function getShadowRoot(el: Element): ShadowRoot | null {
    if (chromeDom?.openOrClosedShadowRoot) {
      try { const sr = chromeDom.openOrClosedShadowRoot(el); if (sr) return sr; } catch { /* fall through */ }
    }
    return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
  }
  function deepVisibleCount(): number {
    let count = 0;
    const seen = new WeakSet<ShadowRoot>();
    function walk(root: Document | ShadowRoot) {
      const all = root.querySelectorAll("*");
      for (const el of Array.from(all)) {
        if ((el as HTMLElement).offsetParent !== null) count++;
        const sr = getShadowRoot(el);
        if (sr && !seen.has(sr)) { seen.add(sr); walk(sr); }
      }
    }
    walk(document);
    return count;
  }
  const baselineVisible = deepVisibleCount();
  let mutCount = 0;
  const observer = new MutationObserver((records) => { mutCount += records.length; });
  observer.observe(document, { subtree: true, childList: true, attributes: true });

  const shadowPoll = setInterval(() => {
    if (done) return;
    const urlChanged = location.href !== startUrl;
    const visibleDelta = deepVisibleCount() - baselineVisible;
    if (urlChanged || mutCount > 3 || Math.abs(visibleDelta) >= 5) {
      notify();
    }
  }, 500);
  const startUrl = location.href;

  const cleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    observer.disconnect();
    clearInterval(shadowPoll);
  };

  document.addEventListener("pointerdown", onPointerDown, { capture: true });
  document.addEventListener("keydown", onKeyDown, { capture: true });
}
