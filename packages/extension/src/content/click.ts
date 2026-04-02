/**
 * Find a clickable element by text/aria-label and programmatically click it.
 * Handles elements that are off-screen inside nested scroll containers (e.g.
 * Stripe's drawer panels).
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
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("aria-label") ||
    textHint;

  // For radio buttons and checkboxes, confirm the new checked state
  let stateNote = "";
  if (el instanceof HTMLInputElement && (el.type === "radio" || el.type === "checkbox")) {
    stateNote = ` — now ${el.checked ? "checked" : "unchecked"}`;
  }

  // Warn if element has zero dimensions (likely inside a collapsed panel)
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    stateNote += " — WARNING: element has 0×0 dimensions (likely inside a collapsed or hidden panel). The click may not have had any effect. Try expanding the parent panel first.";
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

  const candidates = Array.from(document.querySelectorAll(interactiveSelectors));

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
  Array.from(document.querySelectorAll<Element>("[aria-label]")).forEach((el) => {
    if (isUsable(el) && !allMatches.includes(el) && el.getAttribute("aria-label")?.toLowerCase().includes(lower))
      allMatches.push(el);
  });

  // value attribute (input[type=submit], input[type=button])
  Array.from(document.querySelectorAll<HTMLInputElement>("input[type=submit], input[type=button]")).forEach((el) => {
    if (isUsable(el) && !allMatches.includes(el) && el.value.toLowerCase().includes(lower))
      allMatches.push(el);
  });

  // title / data-testid
  Array.from(document.querySelectorAll<Element>("[title], [data-testid]")).forEach((el) => {
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
