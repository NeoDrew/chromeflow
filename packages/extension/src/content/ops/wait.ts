import { scrollSmartIntoView } from "../click.js";
import { extractTextDeep, queryAllDeep } from "../shadow.js";
import { redactSecrets } from "../redact.js";
import type { IncomingMessage } from "./frame-util.js";

export function opWaitForChange(msg: IncomingMessage): Promise<unknown> | unknown {
  const selector = msg.selector as string;
  const timeoutMs = (msg.timeout as number) ?? 30_000;
  const settleMs = (msg.settle as number) ?? 150;

  // queryAllDeep so selectors inside open shadow roots work
  const target = queryAllDeep<Element>(document, selector)[0];
  if (!target) {
    return {
      type: "action_done",
      requestId: msg.requestId,
      ok: false,
      reason: "not-found",
      message: `Selector "${selector}" not found. Call wait_for_selector first if the element may still be loading.`,
    };
  }

  return new Promise<unknown>((resolve) => {
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new MutationObserver(() => {
      // Debounce: on each mutation, (re)start the settle window. Resolve
      // when the window elapses without further mutations — this lets
      // batched updates (multiple appended nodes, style changes, text
      // flips) settle before we read.
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(finish, settleMs);
    });

    const timeoutTimer = setTimeout(() => {
      observer.disconnect();
      if (settleTimer !== null) clearTimeout(settleTimer);
      // Return current text even on timeout — often useful to see what
      // state the element is actually in.
      const fallbackText = extractTextDeep(target)
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n")
        .trim();
      resolve({
        type: "action_done",
        requestId: msg.requestId,
        ok: false,
        reason: "timeout",
        message: `No mutation in "${selector}" after ${timeoutMs / 1000}s. Current text (may still be useful):`,
        text: redactSecrets(fallbackText).text,
      });
    }, timeoutMs);

    function finish() {
      observer.disconnect();
      clearTimeout(timeoutTimer);
      const raw = extractTextDeep(target)
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n")
        .trim();
      resolve({
        type: "action_done",
        requestId: msg.requestId,
        ok: true,
        reason: "mutation",
        text: redactSecrets(raw).text,
      });
    }

    observer.observe(target, {
      childList: true,
      characterData: true,
      attributes: true,
      subtree: true,
    });
  });
}

export function opScrollPage(msg: IncomingMessage): unknown {
  const dir = msg.direction as "down" | "up";
  const amount = (msg.amount as number) || 400;
  // Scroll both window and any focused scroll container
  const delta = dir === "down" ? amount : -amount;
  window.scrollBy({ top: delta, behavior: "smooth" });
  // Also try scrolling the deepest overflow:scroll container in the center of the page
  const midEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  let node: Element | null = midEl;
  while (node && node !== document.documentElement) {
    const s = getComputedStyle(node);
    if ((s.overflowY === "auto" || s.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
      node.scrollTop += delta;
      break;
    }
    node = node.parentElement;
  }
  return { type: "action_done", requestId: msg.requestId };
}

export function opScrollToElement(msg: IncomingMessage): unknown {
  const query = (msg.query as string).toLowerCase();
  let target: Element | null = null;
  let matchedText = "";

  // Try as CSS selector first — pierce shadow roots so selectors returned
  // by find_text (which walks closed shadow trees) resolve correctly.
  try {
    target = queryAllDeep(document, msg.query as string)[0] ?? null;
    if (target) matchedText = msg.query as string;
  } catch { /* invalid selector */ }

  // Otherwise search by label/text. Pierce shadow roots so labels and
  // headings inside Radix portals are reachable.
  if (!target) {
    for (const el of queryAllDeep<HTMLElement>(document, "input, textarea, select, button, [role=button], label, h1, h2, h3, h4, h5, h6")) {
      const text = (el.textContent ?? el.getAttribute("aria-label") ?? el.getAttribute("placeholder") ?? "").toLowerCase();
      if (text.includes(query)) {
        target = el;
        matchedText = (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 60);
        break;
      }
    }
  }

  if (!target) return { type: "action_done", requestId: msg.requestId, message: `No element found matching "${msg.query}"` };
  // Capture stable document y BEFORE scrolling — getBoundingClientRect after smooth scroll
  // returns a mid-animation value which is inconsistent and confusing.
  const docY = Math.round(target.getBoundingClientRect().top + window.scrollY);
  // scrollSmartIntoView walks overflow:auto/scroll ancestors so inner
  // scroll panes (SPAs where the outer document is tiny but the inner
  // pane scrolls 15000+px) actually move. Plain scrollIntoView only
  // moves whichever scroll container the browser happens to pick,
  // which is often the outer document.
  scrollSmartIntoView(target);
  return {
    type: "action_done",
    requestId: msg.requestId,
    message: `Scrolled to "${matchedText}" (document y: ${docY})`,
  };
}
