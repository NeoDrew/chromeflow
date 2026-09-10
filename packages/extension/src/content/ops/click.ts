import {
  clickElement,
  prepareClickTarget,
  postClickInspect,
  reactFiberClick,
  reactFiberClickByHint,
  pointerChainOnTagged,
} from "../click.js";
import { queryAllDeep } from "../shadow.js";
import {
  startClickWatch,
  pendingPreClick,
  preClickCleanup,
  setPendingPreClick,
  setPreClickCleanup,
} from "./click-watch.js";
import type { IncomingMessage } from "./frame-util.js";

export function opStartClickWatch(msg: IncomingMessage): unknown {
  // Disarm the pre-buffer listener since we're taking over with a real watch.
  preClickCleanup?.();
  setPreClickCleanup(null);

  if (pendingPreClick) {
    // User already clicked while the highlight was showing — fire immediately.
    const captured = pendingPreClick;
    setPendingPreClick(false);
    chrome.runtime.sendMessage({
      source: "chromeflow-content",
      type: "click_detected",
      requestId: msg.requestId as string,
      target: captured,
    });
  } else {
    startClickWatch(msg.requestId as string);
  }
  return { type: "action_done", requestId: msg.requestId };
}

export async function opClickElement(msg: IncomingMessage): Promise<unknown> {
  // clickElement() takes no target args — it clicks whatever prepareClickTarget
  // already resolved and tagged in the DOM (see clickElement's own jsdoc for
  // why: this used to re-resolve by msg.textHint, which crashed outright on
  // selector-mode calls since textHint is undefined then, and was never
  // awaited here either, so the response was ALWAYS missing success/message
  // regardless of mode. Fixed 2026-08-15, see
  // ISSUE-2026-08-15-antibot-tenant-walls.md.
  const result = await clickElement();
  return { type: "click_element_response", requestId: msg.requestId, ...result };
}

export async function opPrepareClickTarget(msg: IncomingMessage): Promise<unknown> {
  const result = await prepareClickTarget(
    msg.textHint as string | undefined,
    msg.nth as number | undefined,
    msg.within_selector as string | undefined,
    msg.near_text as string | undefined,
    msg.selector as string | undefined,
    msg.in_dialog as boolean | undefined,
    msg.dialog_query as string | undefined,
  );
  return { type: "action_done", requestId: msg.requestId, ...result };
}

export function opPointerChainClick(msg: IncomingMessage): unknown {
  const result = pointerChainOnTagged();
  return { type: "action_done", requestId: msg.requestId, ...result };
}

export function opPostClickInspect(msg: IncomingMessage): unknown {
  const result = postClickInspect();
  return { type: "action_done", requestId: msg.requestId, ...result };
}

export function opTagForReact(msg: IncomingMessage): unknown {
  // Used by background.react_set_input and background.react_call_prop to
  // bridge MAIN-world prototype access with content-script shadow piercing.
  // queryAllDeep walks open AND closed shadow roots (via
  // chrome.dom.openOrClosedShadowRoot), so selectors that target inputs
  // inside Radix/Stencil/Lit web components resolve here even when plain
  // doc.querySelector from MAIN world wouldn't find them.
  const sel = msg.selector as string;
  const tagId = msg.tagId as string;
  const nth = typeof msg.nth === "number" && msg.nth >= 1 ? msg.nth : 1;
  try {
    const matches = queryAllDeep<Element>(document, sel);
    const el = matches[nth - 1];
    if (!el) {
      return { type: "action_done", requestId: msg.requestId, tagged: false, in_shadow: false };
    }
    // Walk parent chain to detect if the element lives inside a shadow root.
    let cur: Node | null = el;
    let inShadow = false;
    while (cur) {
      if (cur instanceof ShadowRoot) { inShadow = true; break; }
      cur = cur.parentNode;
    }
    el.setAttribute("data-chromeflow-react-target", tagId);
    // A selector resolving to 2+ elements here means react_set_input picked
    // WHICHEVER one happens to be first in document order — the same
    // duplicate-form risk documented for click_element's selector mode (see
    // dispatch.ts's prepareClickTarget and
    // ISSUE-2026-09-10-workday-duplicate-id-colliding-create-account-form.md,
    // where two full copies of a form shared element ids). Surface the count
    // so a silent fill into a stale/wrong duplicate is at least visible.
    const ambiguous = matches.length > 1
      ? { ambiguous_match: true, match_count: matches.length }
      : {};
    return { type: "action_done", requestId: msg.requestId, tagged: true, in_shadow: inShadow, ...ambiguous };
  } catch {
    return { type: "action_done", requestId: msg.requestId, tagged: false, in_shadow: false };
  }
}

export function opReactFiberClick(msg: IncomingMessage): unknown {
  // Opt-in fallback used by background.click_element when the activity
  // probe reports silently_rejected. SELECTOR-mode clicks resolve the
  // element directly via the CSS selector and invoke __reactProps$.onClick
  // on it — they have no textHint, so the by-hint matcher would crash on
  // `undefined.toLowerCase()` (this is the bug that left LinkedIn's Easy
  // Apply "Submit application" un-fired). textHint-mode re-resolves with the
  // same match logic the original click used.
  const fiberSelector = msg.selector as string | undefined;
  let result: { success: boolean; message: string; fired: boolean; component?: string; label?: string };
  if (fiberSelector) {
    const all = queryAllDeep<Element>(document, fiberSelector);
    const nth = msg.nth as number | undefined;
    const el = all[(nth && nth >= 1 ? nth : 1) - 1];
    if (!el) {
      result = { success: false, message: `react_fiber_click: selector "${fiberSelector}" matched no element`, fired: false };
    } else {
      const fiber = reactFiberClick(el);
      const label = (el as HTMLElement).innerText?.trim() || el.getAttribute("aria-label") || fiberSelector;
      result = fiber.fired
        ? { success: true, message: `Invoked React fiber onClick on "${label}"${fiber.component ? ` (component: ${fiber.component})` : ""}`, fired: true, component: fiber.component, label }
        : { success: false, message: `Found "${label}" but no React fiber __reactProps$.onClick exists on it or its ancestors. Bound via addEventListener, or React's prop key was mangled. This element can't be driven via fiber; try the CDP click path instead (via: "auto" or "cdp").`, fired: false, label };
    }
  } else {
    result = reactFiberClickByHint(
      msg.textHint as string,
      msg.nth as number | undefined,
      msg.within_selector as string | undefined,
      msg.near_text as string | undefined,
      msg.in_dialog as boolean | undefined,
      msg.dialog_query as string | undefined,
    );
  }
  return { type: "action_done", requestId: msg.requestId, ...result };
}
