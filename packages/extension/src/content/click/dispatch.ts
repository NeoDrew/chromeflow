import { queryAllDeep } from "../shadow.js";
import { markerIds } from "../../markers.js";
import { findDialogByQuery, findTopmostDialog } from "./dialog.js";
import {
  describeCandidate,
  findClickableAll,
  findSectionByHeading,
  readDisabledState,
  resolveCheckableInput,
  resolveLabelledControl,
} from "./resolve.js";
import { dispatchHumanClickEvents, firePointerChain, scrollSmartIntoView } from "./pointer.js";
import { resolveFrameDocument, frameErrorHint } from "../ops/frame-util.js";

/**
 * Phase 1 of the CDP click flow. Find the clickable element, scroll it into
 * view, tag it with a data attribute so the background worker can look it up
 * later via Runtime.evaluate, and return the viewport-centered coordinates
 * (with small jitter) for CDP Input.dispatchMouseEvent. Returns the element
 * label and a state note; leaves the element tagged for post-click inspection.
 *
 * If the matched element resolves to an `<input type=radio>` that is already
 * checked, returns `skipClick: true` and does NOT tag the element — the
 * caller should short-circuit without firing the click. Re-clicking an
 * already-checked radio toggles it OFF on React forms whose onChange handler
 * interprets the click as a deselect (common on React-controlled form widgets).
 *
 * `frame`: CSS selector for a same-origin iframe to search inside instead of
 * the top-level document, mirroring fill_input/find_text's `frame` param
 * (resolved via ops/frame-util.ts's resolveFrameDocument/frameErrorHint, the
 * same helpers find.ts already uses). Motivating example: iCIMS renders its
 * whole application form inside `#icims_content_iframe`, and a required
 * `<select>` left on its placeholder option there disables the submit button
 * with zero console output or DOM mutation when clicked — indistinguishable
 * from anti-bot silent rejection from the outside (see
 * ISSUE-2026-09-11-icims-hcaptcha-silent-submit-block.md and
 * ISSUE-2026-09-14-icims-hcaptcha-still-silent.md). Any site with a
 * same-origin iframe hits the same blind spot: prepareClickTarget could never
 * reach inside one at all, so its existing disabled-target detection never
 * got a chance to run. This only changes WHERE the element is searched for —
 * the resolved element still flows through every existing check below
 * (disabled-state snapshot, checkable-input handling, labelled-control
 * redirect, marker tagging) unchanged.
 */
export async function prepareClickTarget(
  textHint: string | undefined,
  nth?: number,
  within_selector?: string,
  near_text?: string,
  selector?: string,
  in_dialog?: boolean,
  dialog_query?: string,
  frame?: string,
): Promise<{
  success: boolean;
  message: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  skipClick?: boolean;
  nextCandidate?: string;
  scope_missed?: boolean;
  role?: string | null;
  ambiguous_match?: boolean;
  match_count?: number;
  other_matches?: string[];
  target_disabled?: boolean;
  disabled_state?: {
    disabled: boolean;
    aria_disabled: string | null;
    pointer_events: string;
    opacity: string;
    visible: boolean;
  };
  frame_error?: string;
}> {
  // Resolve the search root first. Returns the top-level `document` unchanged
  // when frame is omitted, so every branch below is byte-for-byte identical
  // to pre-frame behavior in that case.
  const rootDoc = resolveFrameDocument(frame);
  if (rootDoc === null) {
    const hint = frameErrorHint(frame);
    return { success: false, message: hint, frame_error: hint };
  }

  // Clear any stale tags from a previous click. Shadow-piercing because the
  // previous click may have tagged an element inside a shadow root. ONE walk
  // over the union of all three marker attributes instead of three separate
  // shadow-tree walks (each ~50-150ms on a 1000+ shadow-host page); we then
  // strip whichever marker(s) the element actually carries. Always clears the
  // top-level document (unchanged pre-frame behavior) and, when frame points
  // at a different document, also clears there — a prior call may have tagged
  // either one.
  const ct = markerIds.clickTargetAttr();
  const pc = markerIds.preCheckedAttr();
  const pd = markerIds.preDimensionsAttr();
  const clearMarkersIn = (root: Document) => {
    for (const el of queryAllDeep(root, `[${ct}], [${pc}], [${pd}]`)) {
      el.removeAttribute(ct);
      el.removeAttribute(pc);
      el.removeAttribute(pd);
    }
  };
  clearMarkersIn(document);
  if (rootDoc !== document) clearMarkersIn(rootDoc);

  let scope: Document | Element = rootDoc;
  if (dialog_query) {
    const d = findDialogByQuery(dialog_query);
    if (!d) {
      return { success: false, message: `dialog_query "${dialog_query}" did not match any open dialog`, scope_missed: true };
    }
    scope = d;
  } else if (in_dialog) {
    const d = findTopmostDialog();
    if (!d) {
      return { success: false, message: `in_dialog=true but no open [role=dialog]/[role=alertdialog]/<dialog open> on the page`, scope_missed: true };
    }
    scope = d;
  } else if (within_selector) {
    // Pierce shadow roots so a selector returned by find_text (which walks
    // closed shadow trees via chrome.dom.openOrClosedShadowRoot) is usable as
    // a click scope. Plain document.querySelector misses elements inside
    // Radix portals / Stencil components / Lit web components. Scoped to
    // rootDoc (not the bare top-level document) so within_selector composes
    // with frame — the subtree is searched for inside the iframe when one
    // was given.
    const scoped = queryAllDeep(rootDoc, within_selector)[0] ?? null;
    if (!scoped) {
      return { success: false, message: `within_selector "${within_selector}" did not match any element`, scope_missed: true };
    }
    scope = scoped;
  } else if (near_text) {
    const sectionScope = findSectionByHeading(near_text);
    if (!sectionScope) {
      return { success: false, message: `near_text "${near_text}" did not match any section heading`, scope_missed: true };
    }
    scope = sectionScope;
  }

  // Selector mode: skip textHint matcher, target by CSS selector directly via
  // queryAllDeep so open AND closed shadow roots are pierced. Use when the
  // target has no usable visible text (Reddit collapsed composer placeholder,
  // icon-only buttons, drop-zone overlays).
  let el: Element | undefined;
  let nextCandidate: string | undefined;
  let descriptor: string;
  let ambiguousMatch: boolean | undefined;
  let matchCount: number | undefined;
  let otherMatches: string[] | undefined;
  if (selector) {
    const matches = queryAllDeep(scope, selector);
    const idx = (nth && nth >= 1 ? nth : 1) - 1;
    el = matches[idx];
    descriptor = `selector "${selector}"`;
    if (!el) {
      return { success: false, message: `No element matched ${descriptor}${matches.length > 0 ? ` at nth=${nth ?? 1} (found ${matches.length} total)` : ""}` };
    }
    // A selector that resolves to 2+ elements is a real correctness risk, not
    // just noise: two DUPLICATE forms sharing element ids (Workday's Create
    // Account step rendering two full copies of the same fields, see
    // ISSUE-2026-09-10-workday-duplicate-id-colliding-create-account-form.md)
    // silently click into whichever copy happens to be first in document
    // order, which can be a stale/inert clone. Surfacing the count (and a
    // peek at the other candidates) costs nothing on the common, harmless
    // case of N interchangeable list-row buttons, but is the one signal that
    // would have made the duplicate-form problem visible on the FIRST call
    // instead of after ~15 blind attempts.
    if (matches.length > 1) {
      ambiguousMatch = true;
      matchCount = matches.length;
      otherMatches = matches
        .filter((_, i) => i !== idx)
        .slice(0, 4)
        .map((m) => describeCandidate(m, selector));
    }
  } else {
    const lower = (textHint ?? "").toLowerCase().trim();
    const matches = findClickableAll(lower, scope);
    // Merged list: visible first, hidden last. nth=N picks the Nth across the
    // merged list — so if a flair-dropdown's hidden "Post this video as a GIF"
    // was previously match #1, the visible "Post" button now wins #1 instead.
    const merged = [...matches.visible, ...matches.hidden];
    const idx = (nth && nth >= 1 ? nth : 1) - 1;
    el = merged[idx];
    descriptor = `"${textHint ?? ""}"`;

    if (!el) {
      return { success: false, message: `No clickable element found for ${descriptor}` };
    }

    // If the resolved target is in the hidden bucket BUT there's a visible
    // alternative, surface it in nextCandidate so the caller can suggest a
    // retry. The 0×0/hidden refusal at the background-script level uses this
    // to give an actionable error message.
    const isHidden = !matches.visible.includes(el);
    nextCandidate = isHidden && matches.visible[0]
      ? describeCandidate(matches.visible[0], textHint ?? "")
      : undefined;
  }

  // Disabled-state snapshot. When the resolved target is disabled-but-otherwise-
  // visible (the common "Submit" mid-async-recheck case), surface the full
  // signal set so the caller doesn't have to execute_script-spelunk to read
  // disabled / aria-disabled / pointer-events / opacity separately. The
  // background handler uses `target_disabled` + `wait_until_enabled_ms` to
  // poll-then-click without manual retry logic.
  const disabledState = readDisabledState(el);
  const targetDisabled = disabledState.disabled || disabledState.aria_disabled === "true";

  const checkable = resolveCheckableInput(el);

  // Pre-flight: an already-checked radio should never be re-clicked.
  if (checkable && checkable.type === "radio" && checkable.checked) {
    await scrollSmartIntoView(el);
    const label =
      (el as HTMLElement).innerText?.trim() ||
      el.getAttribute("aria-label") ||
      textHint ||
      descriptor;
    return { success: true, skipClick: true, message: `"${label}" — radio already checked, click skipped`, label };
  }

  // A bare <label> resolved as the winning candidate risks computing the
  // click coordinate from ITS bounding box below, which can span more than
  // just its own control (see resolveLabelledControl's comment). Redirect
  // to the actual text-like control now, before scrolling/tagging/coordinate
  // computation, so all of those operate on the real target instead.
  const labelledControl = resolveLabelledControl(el);
  if (labelledControl) el = labelledControl;

  await scrollSmartIntoView(el);
  el.setAttribute(markerIds.clickTargetAttr(), "true");
  // Record pre-click dimensions. If post-click the element is 0×0, it might
  // mean the click succeeded and the element was removed (modal close
  // dismissing its trigger button) rather than the click hitting nothing.
  const preRect = el.getBoundingClientRect();
  if (preRect.width > 0 && preRect.height > 0) {
    el.setAttribute(markerIds.preDimensionsAttr(), "1");
  }

  // Record pre-click state on the resolved input so postClickInspect can
  // verify the click landed and fall back to a full pointer-event chain
  // if the input's checked state didn't flip.
  if (checkable) {
    checkable.setAttribute(markerIds.preCheckedAttr(), checkable.checked ? "true" : "false");
  } else {
    // Custom-element radio/checkbox/switch (faceplate-radio-input, sl-radio):
    // record pre-click aria-checked so postClickInspect can detect toggles.
    const role = el.getAttribute("role");
    if (role === "radio" || role === "checkbox" || role === "switch") {
      el.setAttribute(markerIds.preCheckedAttr(), el.getAttribute("aria-checked") === "true" ? "true" : "false");
    }
  }

  // getBoundingClientRect() on an element resolved inside a same-origin
  // iframe is relative to the IFRAME's own viewport, not the top-level page
  // — but the CDP click dispatched by background/handlers/click.ts fires at
  // top-level viewport coordinates. Add the iframe's own offset so the click
  // actually lands on the resolved element instead of whatever sits at the
  // same (x, y) in the outer page.
  let frameOffsetX = 0;
  let frameOffsetY = 0;
  if (rootDoc !== document) {
    const iframeEl = frame ? document.querySelector<HTMLIFrameElement>(frame) : null;
    if (iframeEl) {
      const iframeRect = iframeEl.getBoundingClientRect();
      frameOffsetX = iframeRect.left;
      frameOffsetY = iframeRect.top;
    }
  }

  const rect = el.getBoundingClientRect();
  // Random point in central 60% of the element (avoid edges — humans aim
  // roughly at the middle, not perfect-center).
  const x = frameOffsetX + rect.left + rect.width * (0.2 + Math.random() * 0.6);
  const y = frameOffsetY + rect.top + rect.height * (0.2 + Math.random() * 0.6);

  const label =
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("aria-label") ||
    textHint ||
    descriptor;

  return {
    success: true,
    message: `Target prepared: "${label}"`,
    x,
    y,
    width: rect.width,
    height: rect.height,
    label,
    nextCandidate,
    role: el.getAttribute("role"),
    ambiguous_match: ambiguousMatch,
    match_count: matchCount,
    other_matches: otherMatches,
    target_disabled: targetDisabled || undefined,
    disabled_state: targetDisabled ? disabledState : undefined,
  };
}

/**
 * Phase 3 of the CDP click flow. After the CDP mouse event has fired, read
 * the tagged element's post-click state (radio/checkbox check state, 0×0
 * warning) and untag it. If the underlying radio/checkbox didn't change
 * state as expected (radio still unchecked, or checkbox didn't toggle),
 * automatically dispatch a full pointer-event chain on the input as a
 * fallback for React-controlled inputs whose handlers are bound to pointer
 * events rather than mouse events.
 */
export function postClickInspect(): { message: string; stateChanged: boolean } {
  // Shadow-piercing find: the click target may live inside a closed shadow
  // root (Reddit's <r-post-flairs-modal>, Radix portals, Stencil/Lit shells).
  // prepareClickTarget used queryAllDeep to tag it; we have to use the same
  // to find it again, or document.querySelector returns null.
  const el = queryAllDeep<HTMLElement>(document, `[${markerIds.clickTargetAttr()}]`)[0] ?? null;
  if (!el) return { message: "", stateChanged: false };

  let stateNote = "";
  let stateChanged = false;

  // Native HTMLInputElement radio/checkbox — resolve via label-wrapping etc.
  const checkable = resolveCheckableInput(el);
  if (checkable) {
    const preAttr = checkable.getAttribute(markerIds.preCheckedAttr());
    const preChecked = preAttr === "true";
    const radioFailed = checkable.type === "radio" && !checkable.checked;
    const checkboxFailed =
      checkable.type === "checkbox" && preAttr !== null && checkable.checked === preChecked;

    let fallbackUsed = false;
    if (radioFailed || checkboxFailed) {
      firePointerChain(checkable);
      fallbackUsed = true;
    }

    if (checkable.type === "radio") {
      stateChanged = checkable.checked;
    } else if (checkable.type === "checkbox" && preAttr !== null) {
      stateChanged = checkable.checked !== preChecked;
    }

    checkable.removeAttribute(markerIds.preCheckedAttr());
    stateNote = ` — now ${checkable.checked ? "checked" : "unchecked"}${fallbackUsed ? " (after pointer-chain fallback)" : ""}`;
  } else {
    // Custom-element radio/checkbox (faceplate-radio-input, sl-radio, etc.).
    // Check role and aria-checked. If role=radio and aria-checked=true (and the
    // pre-click attr said false/missing), that's a state change.
    const role = el.getAttribute("role");
    if (role === "radio" || role === "checkbox" || role === "switch") {
      const preAttr = el.getAttribute(markerIds.preCheckedAttr());
      const ariaChecked = el.getAttribute("aria-checked");
      const nowChecked = ariaChecked === "true";
      if (preAttr !== null) {
        const preChecked = preAttr === "true";
        stateChanged = nowChecked !== preChecked;
        // Per-element-type semantics: a radio counts as "state changed" iff it
        // ended in the checked state (radios can only be set, not unset by
        // direct click), while checkboxes/switches toggle.
        if (role === "radio") stateChanged = nowChecked;
        stateNote = ` — now ${nowChecked ? "checked" : "unchecked"}`;
        el.removeAttribute(markerIds.preCheckedAttr());
      } else if (nowChecked) {
        // No baseline recorded but element is now checked: treat as success.
        stateChanged = true;
        stateNote = ` — now checked`;
      }
    }
  }

  const rect = el.getBoundingClientRect();
  const nowZero = rect.width === 0 && rect.height === 0 &&
    !el.offsetWidth && !el.offsetHeight &&
    el.getClientRects().length === 0;
  if (nowZero) {
    // If pre-click dims were non-zero (we recorded that), this is a likely
    // success signal — the click closed/removed the target (modal close
    // button vanishes after Apply, popover closes after picking an option).
    // Don't warn; just note the disappearance.
    if (el.hasAttribute(markerIds.preDimensionsAttr())) {
      stateChanged = true;
      stateNote += " — element removed/hidden post-click (modal close, popover dismiss, or similar)";
    } else {
      stateNote += " — WARNING: element has 0×0 dimensions (likely inside a collapsed or hidden panel). The click may not have had any effect.";
    }
  }
  el.removeAttribute(markerIds.preDimensionsAttr());

  // NOTE: marker attribute is NOT removed here. The activity probe needs it
  // to find the target element for its post-click state snapshot. Removal
  // happens after the probe completes (background.ts untags via execute_script).
  return { message: stateNote, stateChanged };
}

/**
 * Click the element `prepareClickTarget` already resolved and tagged (Phase 1
 * of every click_element call, regardless of textHint vs selector mode).
 * Handles elements that are off-screen inside nested scroll containers (e.g.
 * Stripe's drawer panels) and elements inside open shadow roots (Radix UI
 * components, Stencil/Lit web components, etc.).
 *
 * This is the fallback path when CDP Input.dispatchMouseEvent isn't available
 * OR when the cdp_click phase times out (chrome:// pages, debugger attach
 * fails, or a hung CDP dispatch on an anti-bot-walled tenant). The CDP path
 * produces isTrusted=true clicks; this path produces isTrusted=false
 * synthetic clicks.
 *
 * Operates on the ALREADY-TAGGED element (markerIds.clickTargetAttr(), set by
 * prepareClickTarget) rather than re-resolving by textHint — matching the
 * pattern every other fallback (postClickInspect, pointerChainOnTagged,
 * dispatchKeyboardActivation's focus step) already uses. Re-resolving here
 * used to (a) crash outright on selector-mode calls, since it only ever
 * accepted a textHint and called textHint.toLowerCase() unconditionally, and
 * (b) risk picking a DIFFERENT element than CDP originally targeted even in
 * textHint mode, if the page changed between the prepare step and this
 * fallback. See ISSUE-2026-08-15-antibot-tenant-walls.md.
 */
export async function clickElement(): Promise<{ success: boolean; message: string }> {
  const el = queryAllDeep<HTMLElement>(document, `[${markerIds.clickTargetAttr()}]`)[0] ?? null;

  if (!el) {
    return { success: false, message: `No tagged click target found — prepareClickTarget may not have run, or the element was removed from the DOM before this fallback ran.` };
  }

  // Scroll the element into view, including nested scroll containers
  await scrollSmartIntoView(el);

  const label =
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("aria-label") ||
    el.tagName.toLowerCase();

  // Pre-flight: skip already-checked radios — re-clicking can toggle them OFF
  // on React forms whose onChange handler interprets the click as a deselect.
  const checkable = resolveCheckableInput(el);
  if (checkable && checkable.type === "radio" && checkable.checked) {
    return { success: true, message: `"${label}" — radio already checked, click skipped` };
  }
  const preChecked = checkable ? checkable.checked : null;

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

  // For radio buttons and checkboxes, confirm the new checked state and fall
  // back to a full pointer-event chain on the input if the standard click
  // didn't change state (React-controlled inputs bound to pointer events).
  let stateNote = "";
  if (checkable && preChecked !== null) {
    const radioFailed = checkable.type === "radio" && !checkable.checked;
    const checkboxFailed = checkable.type === "checkbox" && checkable.checked === preChecked;
    let fallbackUsed = false;
    if (radioFailed || checkboxFailed) {
      firePointerChain(checkable);
      fallbackUsed = true;
    }
    stateNote = ` — now ${checkable.checked ? "checked" : "unchecked"}${fallbackUsed ? " (after pointer-chain fallback)" : ""}`;
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
