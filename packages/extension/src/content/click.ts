import { queryAllDeep } from "./shadow.js";

/**
 * Find a clickable element by text/aria-label and programmatically click it.
 * Handles elements that are off-screen inside nested scroll containers (e.g.
 * Stripe's drawer panels) and elements inside open shadow roots (Outlier chat,
 * Radix UI components, etc.).
 */
export function clickElement(
  textHint: string,
  nth?: number
): { success: boolean; message: string } {
  const lower = textHint.toLowerCase().trim();
  const el = findClickable(lower, nth);

  if (!el) {
    return { success: false, message: `No clickable element found for "${textHint}"` };
  }

  // Scroll the element into view, including nested scroll containers
  scrollSmartIntoView(el);

  // Humanize the click: dispatch mousemove → mousedown → small delay → mouseup → click,
  // with coord jitter, before falling back to native .click(). Sites doing
  // behavioral fingerprinting (LinkedIn, Akamai) flag teleport-clicks as bots.
  // We also still call .click() at the end so React/Stripe-style handlers fire reliably.
  dispatchHumanClickEvents(el);
  if (typeof (el as HTMLElement).click === "function") {
    (el as HTMLElement).click();
  } else {
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  const label =
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("aria-label") ||
    textHint;

  // For radio buttons and checkboxes, confirm the new checked state
  let stateNote = "";
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    stateNote = ` — now ${el.checked ? "checked" : "unchecked"}`;
  }

  // Warn if element is truly invisible (0x0 bounding rect AND no offset dimensions
  // AND no client rects). This avoids false warnings on elements that are clipped
  // but still receive click events fine (e.g. hidden checkboxes with label proxies).
  const rect = el.getBoundingClientRect();
  const htmlEl = el as HTMLElement;
  if (
    rect.width === 0 && rect.height === 0 &&
    !htmlEl.offsetWidth && !htmlEl.offsetHeight &&
    el.getClientRects().length === 0
  ) {
    stateNote += " — WARNING: element has 0×0 dimensions (likely inside a collapsed or hidden panel). The click may not have had any effect. Try expanding the parent panel first, or use execute_script to click directly.";
  }

  return { success: true, message: `Clicked "${label}"${stateNote}` };
}

/**
 * Scroll the element into view in both the window AND any nested scrollable
 * ancestor containers (e.g. Stripe's slide-over drawer panels).
 */
function scrollSmartIntoView(el: Element) {
  // Standard scroll for the main window
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Also walk up and scroll any overflow:auto/scroll ancestor
  let parent = el.parentElement;
  while (parent && parent !== document.documentElement) {
    const style = getComputedStyle(parent);
    const oy = style.overflowY;
    if (
      (oy === "auto" || oy === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    ) {
      const elRect = el.getBoundingClientRect();
      const pRect = parent.getBoundingClientRect();
      if (elRect.bottom > pRect.bottom) {
        parent.scrollTop += elRect.bottom - pRect.bottom + 16;
      } else if (elRect.top < pRect.top) {
        parent.scrollTop -= pRect.top - elRect.top + 16;
      }
    }
    parent = parent.parentElement;
  }
}

function findClickable(lower: string, nth: number = 1): Element | null {
  const interactiveSelectors =
    'button, a, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], input[type="submit"], input[type="button"], label, [onclick], [tabindex]';

  const candidates = queryAllDeep(document, interactiveSelectors);

  // Collect all usable matches in priority order, then pick the nth
  const allMatches: Element[] = [];

  // Exact text matches
  candidates.forEach((el) => {
    if (isUsable(el) && el.textContent?.toLowerCase().trim() === lower) allMatches.push(el);
  });

  // Partial text matches (sorted shortest first for specificity), deduplicated
  const partials = candidates
    .filter((el) => isUsable(el) && !allMatches.includes(el) && el.textContent?.toLowerCase().includes(lower))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
  allMatches.push(...partials);

  // aria-label matches
  queryAllDeep(document, "[aria-label]").forEach((el) => {
    if (isUsable(el) && !allMatches.includes(el) && el.getAttribute("aria-label")?.toLowerCase().includes(lower))
      allMatches.push(el);
  });

  // value attribute (input[type=submit], input[type=button])
  queryAllDeep<HTMLInputElement>(document, "input[type=submit], input[type=button]").forEach((el) => {
    if (isUsable(el) && !allMatches.includes(el) && el.value.toLowerCase().includes(lower))
      allMatches.push(el);
  });

  // title / data-testid
  queryAllDeep(document, "[title], [data-testid]").forEach((el) => {
    const v = el.getAttribute("title") ?? el.getAttribute("data-testid") ?? "";
    if (isUsable(el) && !allMatches.includes(el) && v.toLowerCase().includes(lower))
      allMatches.push(el);
  });

  if (allMatches.length === 0) return null;

  const target = allMatches[nth - 1] ?? allMatches[allMatches.length - 1];
  return target;
}

/**
 * Returns true if the element is rendered (not display:none / visibility:hidden).
 * Deliberately does NOT require the element to be inside the viewport — elements
 * below the fold (e.g. Save buttons in a drawer) are still usable.
 */
function isUsable(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none") return false;
  if (style.visibility === "hidden") return false;
  if (style.opacity === "0") return false;
  if ((el as HTMLButtonElement).disabled) return false;
  return true;
}

/**
 * Dispatch a sequence of mouse events (mousemove → mouseover → mousedown → mouseup)
 * with humanlike coordinate jitter, before the actual .click() call. Anti-bot
 * systems flag elements that receive isolated click events with no preceding
 * pointer movement.
 *
 * NOTE: these events are still isTrusted=false. Sites that check isTrusted
 * (which is the strongest signal) won't be fooled — only behavioral-pattern
 * detectors. For full bypass we'd need CDP Input.dispatchMouseEvent.
 */
function dispatchHumanClickEvents(el: Element) {
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Random point within central 60% of the element (avoid edges)
    const cx = rect.left + rect.width * (0.2 + Math.random() * 0.6);
    const cy = rect.top + rect.height * (0.2 + Math.random() * 0.6);
    // Start point: a few px away to simulate approach
    const sx = cx + (Math.random() - 0.5) * 40;
    const sy = cy + (Math.random() - 0.5) * 40;

    const mkEvent = (type: string, x: number, y: number) => new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(x),
      clientY: Math.round(y),
      button: 0,
      buttons: type === "mousedown" || type === "mouseup" ? 1 : 0,
    });

    el.dispatchEvent(mkEvent("mousemove", sx, sy));
    el.dispatchEvent(mkEvent("mouseover", cx, cy));
    el.dispatchEvent(mkEvent("mousemove", cx, cy));
    el.dispatchEvent(mkEvent("mousedown", cx, cy));
    el.dispatchEvent(mkEvent("mouseup", cx, cy));
  } catch {
    // Behavioral humanization is best-effort; never block the click.
  }
}
