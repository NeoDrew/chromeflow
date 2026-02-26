/**
 * Find a clickable element by text/aria-label and programmatically click it.
 * Handles elements that are off-screen inside nested scroll containers (e.g.
 * Stripe's drawer panels).
 */
export function clickElement(
  textHint: string
): { success: boolean; message: string } {
  const lower = textHint.toLowerCase().trim();
  const el = findClickable(lower);

  if (!el) {
    return { success: false, message: `No clickable element found for "${textHint}"` };
  }

  // Scroll the element into view, including nested scroll containers
  scrollSmartIntoView(el);

  // Use the native DOM .click() — most compatible with React/Stripe
  if (typeof (el as HTMLElement).click === "function") {
    (el as HTMLElement).click();
  } else {
    const opts = { bubbles: true, cancelable: true };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
  }

  const label =
    (el as HTMLElement).innerText?.trim().slice(0, 40) ||
    el.getAttribute("aria-label") ||
    textHint;

  return { success: true, message: `Clicked "${label}"` };
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

function findClickable(lower: string): Element | null {
  const interactiveSelectors =
    'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], label';

  const candidates = Array.from(document.querySelectorAll(interactiveSelectors));

  // Exact text match first (trimmed)
  const exact = candidates.find(
    (el) => isUsable(el) && el.textContent?.toLowerCase().trim() === lower
  );
  if (exact) return exact;

  // Partial text match — prefer the most specific (shortest text) match
  const partials = candidates
    .filter((el) => isUsable(el) && el.textContent?.toLowerCase().includes(lower))
    .sort((a, b) => (a.textContent?.length ?? 0) - (b.textContent?.length ?? 0));
  if (partials[0]) return partials[0];

  // aria-label
  const ariaMatch = Array.from(document.querySelectorAll<Element>("[aria-label]")).find(
    (el) => isUsable(el) && el.getAttribute("aria-label")?.toLowerCase().includes(lower)
  );
  if (ariaMatch) return ariaMatch;

  // title / data-testid
  const attrMatch = Array.from(
    document.querySelectorAll<Element>("[title], [data-testid]")
  ).find((el) => {
    const v =
      el.getAttribute("title") ?? el.getAttribute("data-testid") ?? "";
    return isUsable(el) && v.toLowerCase().includes(lower);
  });
  if (attrMatch) return attrMatch;

  return null;
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
