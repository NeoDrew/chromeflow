/**
 * Shadow-DOM-piercing helpers.
 *
 * Many SPAs (Outlier's chat-lite, Radix UI components, Stencil-based widgets,
 * Lit components, web-component-heavy sites) render content inside open shadow
 * roots. Standard `document.querySelectorAll` and `innerText` don't traverse
 * those boundaries, so chromeflow needs its own deep-walk helpers.
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/**
 * Like `querySelectorAll`, but also descends into open shadow roots. Returns
 * a flat list of matches across the entire tree.
 *
 * Closed shadow roots are NOT accessible via `el.shadowRoot` and will be
 * silently skipped — matches inside them cannot be reached from page script.
 */
export function queryAllDeep<E extends Element = Element>(
  root: Document | Element | ShadowRoot,
  selector: string
): E[] {
  const out: E[] = [];
  const seen = new WeakSet<Element>();

  function recurse(r: ParentNode) {
    for (const m of Array.from(r.querySelectorAll<E>(selector))) {
      if (!seen.has(m)) { seen.add(m); out.push(m); }
    }
    for (const el of Array.from(r.querySelectorAll<Element>("*"))) {
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) recurse(sr);
    }
  }

  recurse(root);
  return out;
}

/**
 * Walk every element in the tree, descending into open shadow roots. Yields
 * elements in document order (parent before children, host before shadow content).
 */
export function* walkElementsDeep(root: Element | Document | ShadowRoot): Generator<Element> {
  const queue: Array<Element | DocumentFragment> = [root as Element];
  while (queue.length) {
    const node = queue.shift()!;
    const el = node as Element;
    if (el.nodeType === 1) {
      yield el;
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) queue.push(sr as unknown as Element);
    }
    if ("children" in node) {
      for (const c of Array.from(node.children)) queue.push(c);
    }
  }
}

/**
 * Extract text content from `root` including shadow descendants. Skips
 * <script>, <style>, <noscript>, <template> by default; pass `extraSkipTags`
 * (uppercase tag names) to skip more (e.g. NAV/HEADER/FOOTER).
 */
export function extractTextDeep(root: Node, extraSkipTags?: Set<string>): string {
  const parts: string[] = [];
  const skip = extraSkipTags
    ? new Set([...SKIP_TAGS, ...extraSkipTags])
    : SKIP_TAGS;

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = node.textContent;
      if (t) parts.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (skip.has(el.tagName)) return;
      const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) walk(sr);
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  }

  walk(root);
  return parts.join("");
}

/**
 * Get the actually-focused element, descending through any nested shadow roots.
 * `document.activeElement` returns the shadow host, not the focused element
 * inside the shadow tree — this drills down to find the real focus target.
 */
export function getDeepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active && (active as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot) {
    const sr = (active as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot!;
    if (!sr.activeElement) break;
    active = sr.activeElement;
  }
  return active;
}
