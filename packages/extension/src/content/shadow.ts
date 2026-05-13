/**
 * Shadow-DOM-piercing helpers.
 *
 * Many SPAs (Outlier's chat-lite, Radix UI components, Stencil-based widgets,
 * Lit components, web-component-heavy sites) render content inside shadow
 * roots. Standard `document.querySelectorAll` and `innerText` don't traverse
 * those boundaries, so chromeflow needs its own deep-walk helpers.
 *
 * In MV3 content scripts (this file's runtime context), `chrome.dom
 * .openOrClosedShadowRoot()` pierces BOTH open AND closed shadow roots. We
 * use it when available; the bare `el.shadowRoot` fallback handles open-only
 * (page-context `execute_script` and any future caller not in a content
 * script).
 */

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/**
 * Return the shadow root attached to `el`, open OR closed. Uses the
 * content-script-only `chrome.dom.openOrClosedShadowRoot()` API when present,
 * falls back to `el.shadowRoot` (open-only). Returns null for non-hosts.
 */
function getShadowRoot(el: Element): ShadowRoot | null {
  const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
  if (chromeDom?.openOrClosedShadowRoot) {
    try {
      const sr = chromeDom.openOrClosedShadowRoot(el);
      if (sr) return sr;
    } catch { /* fall through to open-shadow probe */ }
  }
  return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
}

/**
 * Like `querySelectorAll`, but also descends into open AND closed shadow
 * roots (via chrome.dom.openOrClosedShadowRoot). Returns a flat list of
 * matches across the entire tree.
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
      const sr = getShadowRoot(el);
      if (sr) recurse(sr);
    }
  }

  recurse(root);
  return out;
}

/**
 * Walk every element in the tree, descending into shadow roots (open + closed).
 * Yields elements in document order (parent before children, host before
 * shadow content).
 */
export function* walkElementsDeep(root: Element | Document | ShadowRoot): Generator<Element> {
  const queue: Array<Element | DocumentFragment> = [root as Element];
  while (queue.length) {
    const node = queue.shift()!;
    const el = node as Element;
    if (el.nodeType === 1) {
      yield el;
      const sr = getShadowRoot(el);
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
      const sr = getShadowRoot(el);
      if (sr) walk(sr);
    }
    for (const child of Array.from(node.childNodes)) walk(child);
  }

  walk(root);
  return parts.join("");
}

/**
 * Walk every text node in the tree, descending into shadow roots (open +
 * closed). Yields text nodes in document order. Skips text inside <script>,
 * <style>, etc. so you only see user-visible text. Used by fill_input's
 * fuzzy text walk so label-near-input matching works inside shadow trees.
 */
export function* walkTextNodesDeep(root: Node): Generator<Text> {
  if (root.nodeType === Node.TEXT_NODE) {
    yield root as Text;
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
    return;
  }
  if (root.nodeType === Node.ELEMENT_NODE) {
    const el = root as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    const sr = getShadowRoot(el);
    if (sr) yield* walkTextNodesDeep(sr);
  }
  for (const child of Array.from(root.childNodes)) yield* walkTextNodesDeep(child);
}

/**
 * Get the actually-focused element, descending through any nested shadow roots.
 * `document.activeElement` returns the shadow host, not the focused element
 * inside the shadow tree — this drills down to find the real focus target.
 */
export function getDeepActiveElement(): Element | null {
  let active: Element | null = document.activeElement;
  while (active) {
    const sr = getShadowRoot(active);
    if (!sr || !sr.activeElement) break;
    active = sr.activeElement;
  }
  return active;
}
