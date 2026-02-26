/**
 * Read a value from the page by finding text near a hint string.
 * Strategy:
 *   1. Find the element containing the hint text
 *   2. Look for associated input/code/pre/span elements nearby (sibling, parent, child)
 *   3. Return the text content or value
 */
export function readElementValue(textHint: string): string | null {
  const lower = textHint.toLowerCase().trim();

  // Find element whose text contains the hint
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.toLowerCase().includes(lower)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden")
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const node = walker.nextNode();
  if (!node) return null;

  const anchor = node.parentElement!;

  // If the hint element itself is an input/textarea, return its value
  if (anchor instanceof HTMLInputElement || anchor instanceof HTMLTextAreaElement) {
    return anchor.value || null;
  }

  // Look for a nearby value element
  const candidates: Element[] = [
    ...Array.from(anchor.querySelectorAll("input, textarea, code, [data-value]")),
    ...Array.from(anchor.parentElement?.querySelectorAll("input, textarea, code, [data-value]") ?? []),
    ...Array.from(anchor.closest("tr, li, [class*='row'], [class*='item']")?.querySelectorAll("input, textarea, code, span") ?? []),
  ];

  for (const el of candidates) {
    if (el === anchor) continue;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const val = el.value.trim();
      if (val && val !== anchor.textContent?.trim()) return val;
    }
    const text = el.textContent?.trim();
    // Heuristic: value-like strings (API keys, IDs) are usually alphanumeric with underscores/dashes
    if (text && text.length > 4 && /^[\w\-_.]+$/.test(text)) {
      return text;
    }
  }

  // Fall back: look for sibling text nodes that look like a value
  const parent = anchor.parentElement;
  if (parent) {
    for (const child of Array.from(parent.children)) {
      if (child === anchor) continue;
      const text = child.textContent?.trim();
      if (text && text.length > 4) return text;
    }
  }

  return null;
}
