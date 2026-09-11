import {
  clickElement,
  prepareClickTarget,
  postClickInspect,
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
