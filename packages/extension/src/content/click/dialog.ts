import { queryAllDeep } from "../shadow.js";

/**
 * Resolve the topmost open dialog on the page. "Topmost" picks the dialog
 * with the highest CSS z-index, falling back to document-order last. Pierces
 * shadow roots so Radix portals (which mount their dialogs at document.body
 * inside a closed shadow root) are reachable. Returns null when no dialog
 * is currently open.
 */
export function findTopmostDialog(): Element | null {
  const candidates = queryAllDeep(document, '[role="dialog"], [role="alertdialog"], dialog[open]');
  if (candidates.length === 0) return null;
  let best: Element | null = null;
  let bestZ = -Infinity;
  for (const el of candidates) {
    // Skip dialogs that aren't actually visible. The closest [aria-hidden=true]
    // or [hidden] ancestor disqualifies the candidate.
    if (el.getAttribute("aria-hidden") === "true") continue;
    if (el.hasAttribute("hidden")) continue;
    let z = 0;
    try {
      const view = el.ownerDocument.defaultView;
      if (view) {
        const cs = view.getComputedStyle(el as Element);
        const parsed = parseInt(cs.zIndex || "0", 10);
        if (Number.isFinite(parsed)) z = parsed;
      }
    } catch { /* cross-window — ignore */ }
    // Last-write-wins among equal z-index, biases toward the most-recently
    // appended dialog (document order).
    if (z >= bestZ) {
      bestZ = z;
      best = el;
    }
  }
  return best;
}

/**
 * Resolve a dialog by heading or aria-label substring. Used by
 * click_element(dialog_query="Select a snapshot") to scope candidates to a
 * specific named dialog when multiple dialogs are open (rare but happens on
 * confirm-inside-confirm flows).
 */
export function findDialogByQuery(query: string): Element | null {
  const lower = query.toLowerCase().trim();
  if (!lower) return null;
  const dialogs = queryAllDeep(document, '[role="dialog"], [role="alertdialog"], dialog[open]');
  for (const d of dialogs) {
    const aria = (d.getAttribute("aria-label") ?? "").toLowerCase();
    if (aria.includes(lower)) return d;
    // Check headings inside
    const heading = d.querySelector("h1, h2, h3, h4, h5, h6, [role='heading']");
    const text = (heading?.textContent ?? "").toLowerCase().trim();
    if (text.includes(lower)) return d;
  }
  return null;
}
