const CONTAINER_ID = "__chromeflow_overlays__";
const CALLOUT_HEIGHT = 52;
const CALLOUT_OFFSET = 8;

// Tracked highlights — repositioned on scroll
type TrackedHighlight = {
  /** Element to track (for find_and_highlight). */
  element?: Element;
  /** Document-absolute coordinates (for highlight_region). */
  docX?: number;
  docY?: number;
  width: number;
  height: number;
  message: string;
  boxEl: HTMLDivElement;
  calloutEl: HTMLDivElement;
};

let tracked: TrackedHighlight[] = [];
let scrollListenerAttached = false;

function ensureStyles() {
  if (document.getElementById("__chromeflow_styles__")) return;
  const style = document.createElement("style");
  style.id = "__chromeflow_styles__";
  style.textContent = `
    @keyframes chromeflow-pulse {
      0%, 100% { box-shadow: 0 0 0 4px rgba(124,58,237,0.25), 0 0 12px rgba(124,58,237,0.4); }
      50%       { box-shadow: 0 0 0 6px rgba(124,58,237,0.4), 0 0 20px rgba(124,58,237,0.6); }
    }
    @keyframes chromeflow-fadein {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}

function getOrCreateContainer(): HTMLDivElement {
  let c = document.getElementById(CONTAINER_ID) as HTMLDivElement | null;
  if (!c) {
    c = document.createElement("div");
    c.id = CONTAINER_ID;
    // Fixed container covering the viewport — children use position:fixed too
    c.style.cssText = `
      position: fixed; top: 0; left: 0;
      width: 100%; height: 100%;
      pointer-events: none;
      z-index: 2147483647;
    `;
    document.documentElement.appendChild(c);
  }
  return c;
}

export function clearAllOverlays() {
  tracked = [];
  document.getElementById(CONTAINER_ID)?.remove();
}

/**
 * Returns the current highlighted element's viewport rect, or null if nothing
 * is highlighted. Used by click-watch to decide if a click is on target.
 */
export function getHighlightedViewportRect(): {
  left: number;
  top: number;
  width: number;
  height: number;
} | null {
  if (tracked.length === 0) return null;
  const h = tracked[0];
  if (h.element) {
    const r = h.element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return {
    left: h.docX! - window.scrollX,
    top: h.docY! - window.scrollY,
    width: h.width,
    height: h.height,
  };
}

/** Find an element whose visible text contains the given string. */
export function findElementByText(text: string): Element | null {
  const lower = text.toLowerCase().trim();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.toLowerCase().includes(lower)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let best: Element | null = null;
  let bestLen = Infinity;
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const el = node.parentElement!;
    const len = (el.textContent ?? "").length;
    if (len < bestLen) {
      best = el;
      bestLen = len;
    }
  }

  if (!best) return null;

  // Walk up the DOM until we find an ancestor with actual rendered dimensions.
  // Text nodes and inline spans often have zero rects — their parent button/link/div
  // is the element that's actually visible.
  let candidate: Element | null = best;
  while (candidate) {
    const r = candidate.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return candidate;
    candidate = candidate.parentElement;
  }

  return best; // fallback — at least return something
}

function positionElements(h: TrackedHighlight) {
  let vpLeft: number, vpTop: number, w: number, ht: number;

  if (h.element) {
    const rect = h.element.getBoundingClientRect();
    vpLeft = rect.left;
    vpTop = rect.top;
    w = rect.width;
    ht = rect.height;
  } else {
    // Document-absolute → viewport-relative
    vpLeft = h.docX! - window.scrollX;
    vpTop = h.docY! - window.scrollY;
    w = h.width;
    ht = h.height;
  }

  h.boxEl.style.left = `${vpLeft}px`;
  h.boxEl.style.top = `${vpTop}px`;
  h.boxEl.style.width = `${w}px`;
  h.boxEl.style.height = `${ht}px`;

  const calloutTop =
    vpTop > CALLOUT_HEIGHT + CALLOUT_OFFSET
      ? vpTop - CALLOUT_OFFSET - CALLOUT_HEIGHT
      : vpTop + ht + CALLOUT_OFFSET;
  h.calloutEl.style.top = `${calloutTop}px`;
  h.calloutEl.style.left = `${Math.max(8, Math.min(vpLeft, window.innerWidth - 330))}px`;
}

function ensureScrollListener() {
  if (scrollListenerAttached) return;
  scrollListenerAttached = true;
  // Use document + capture:true so nested scroll containers (e.g. Stripe drawers) are caught too
  document.addEventListener(
    "scroll",
    () => { for (const h of tracked) positionElements(h); },
    { passive: true, capture: true }
  );
  window.addEventListener(
    "resize",
    () => { for (const h of tracked) positionElements(h); },
    { passive: true }
  );
}

function createHighlightElements(message: string, color: string): [HTMLDivElement, HTMLDivElement] {
  ensureStyles();
  const container = getOrCreateContainer();

  const box = document.createElement("div");
  box.style.cssText = `
    position: fixed;
    border: 2px solid ${color};
    border-radius: 4px;
    pointer-events: none;
    animation: chromeflow-pulse 1.5s ease-in-out infinite;
    background: transparent;
  `;

  const callout = document.createElement("div");
  callout.style.cssText = `
    position: fixed;
    background: ${color};
    color: #fff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 13px;
    font-weight: 500;
    line-height: 1.4;
    padding: 8px 12px;
    border-radius: 6px;
    max-width: 320px;
    width: max-content;
    pointer-events: none;
    white-space: pre-wrap;
    box-shadow: 0 4px 12px rgba(0,0,0,0.4);
    animation: chromeflow-fadein 0.2s ease;
    z-index: 1;
  `;
  callout.textContent = message;

  container.appendChild(box);
  container.appendChild(callout);
  return [box, callout];
}

export function renderHighlight(opts: {
  /** Viewport coordinates in CSS pixels (screenshot is pre-downscaled to CSS resolution). */
  x: number;
  y: number;
  width: number;
  height: number;
  message: string;
  color?: string;
}) {
  const { message, color = "#7c3aed" } = opts;

  // Coordinates are already CSS viewport pixels — convert to document-absolute for scroll tracking
  const docX = opts.x + window.scrollX;
  const docY = opts.y + window.scrollY;
  const cssW = opts.width;
  const cssH = opts.height;

  clearAllOverlays(); // one highlight at a time

  const [box, callout] = createHighlightElements(message, color);
  const h: TrackedHighlight = { docX, docY, width: cssW, height: cssH, message, boxEl: box, calloutEl: callout };
  tracked.push(h);
  positionElements(h);
  ensureScrollListener();
}

export function highlightElement(el: Element, message: string, color = "#7c3aed") {
  el.scrollIntoView({ behavior: "smooth", block: "center" });

  clearAllOverlays(); // one highlight at a time

  const [box, callout] = createHighlightElements(message, color);
  const h: TrackedHighlight = { element: el, width: 0, height: 0, message, boxEl: box, calloutEl: callout };
  tracked.push(h);

  // Let scroll settle before first position
  setTimeout(() => {
    positionElements(h);
    ensureScrollListener();
  }, 350);
}
