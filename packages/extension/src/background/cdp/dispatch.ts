// CDP input-dispatch cluster: human-like mouse click, tap-gesture fallback,
// keyboard-activation fallback, and the fresh-coordinate re-read used right
// before a dispatch.

import { withDebugger } from "./debugger";

/**
 * Last known synthesized cursor position per tab, seeded by the trailing
 * jitter move at the end of dispatchHumanMouseClick. Coordinates are viewport
 * CSS pixels, which are only meaningful per-tab (there's no cross-tab
 * physical cursor to model), hence keyed by tabId rather than a single
 * module-level point. Read back at the top of the next call so consecutive
 * clicks on the same tab produce one continuous traversal instead of the
 * cursor "teleporting" between targets with zero intervening samples — a
 * page recording the full mousemove/pointermove stream over a session can
 * otherwise tell every click was independently synthesized.
 */
const lastPointerPos = new Map<number, { x: number; y: number }>();

/**
 * Run the full human-like CDP mouse-click sequence at (x, y): bezier
 * approach path, settle-hover micro-tremor, press, release, post-click
 * micro-move. Reused by click_element (where coordinates come from the
 * matched element) and click_at_coordinates (where coordinates come from
 * the caller — typically for cross-origin iframes whose targets can't be
 * found by find_text). Coordinates are viewport CSS pixels.
 *
 * Anti-bot bypass: stricter Web Components (Reddit's faceplate-*,
 * Twitter's composer, etc.) check `event instanceof PointerEvent &&
 * event.isPrimary` in addition to isTrusted. We pass pointerType="mouse"
 * which makes Chrome fire PointerEvent alongside MouseEvent (isPrimary=true,
 * pointerId=1) with a realistic pressure via `force`. Combined with the
 * bezier path and settle hover, this passes every behavioral check we've
 * seen short of OS-level input.
 */
/**
 * Fallback click using CDP's high-level synthesizeTapGesture. Unlike
 * Input.dispatchMouseEvent (where the auto-generated `click` event has
 * isPrimary=false even when the source pointerdown/pointerup were
 * isPrimary=true), synthesizeTapGesture produces a fuller pointer chain
 * where the click event carries isPrimary=true.
 *
 * This is the fallback that handles Reddit's faceplate-* Lit web
 * components: their click handlers gate on
 * `event.isTrusted && event.isPrimary` on the click event itself, which
 * dispatchHumanMouseClick passes for isTrusted but fails for isPrimary.
 * The most visible casualty is the new-post flair button — pre-0.10.3
 * synthetic clicks silently_rejected even though the pointer events were
 * landing correctly. Used only when the primary CDP click probe shows
 * zero activity, so well-behaved targets aren't double-clicked.
 */
export async function dispatchTapGesture(
  tabId: number,
  cx: number,
  cy: number,
): Promise<void> {
  await withDebugger(tabId, async () => {
    const dbg = chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
    };
    await dbg.sendCommand({ tabId }, "Input.synthesizeTapGesture", {
      x: cx,
      y: cy,
      duration: 50,
      tapCount: 1,
      gestureSourceType: "mouse",
    });
  });
}

/**
 * Keyboard activation fallback. When a button's click handler is
 * gated on something beyond isTrusted=true (Reddit's web components
 * check user-activation provenance — CDP mouse events count as trusted
 * but apparently not "trusted enough" for some custom-element handlers),
 * a CDP keyboard Enter press still activates the button. Buttons handle
 * Enter and Space natively via the browser's built-in keyboard activation
 * path, which bypasses any mouse-event source checks the page added.
 *
 * The element must be focused first (handled by the caller via
 * scripting.executeScript + el.focus()).
 */
export async function dispatchKeyboardActivation(tabId: number): Promise<void> {
  await withDebugger(tabId, async () => {
    const dbg = chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
    };
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 40));
    // Full keystroke: rawKeyDown (creates DOM keydown event), char (creates
    // keypress / fires button activation), keyUp (releases). The char step is
    // critical: without it, Web Components that listen for `click` derived
    // from keyboard activation never see the activation fire. Chromium's
    // input system processes \r as the "default action" for Enter on focused
    // buttons (analogous to Space activating buttons).
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 20));
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "char",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 20));
    await dbg.sendCommand({ tabId }, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
  });
}

export async function dispatchHumanMouseClick(
  tabId: number,
  cx: number,
  cy: number,
  options: {
    button?: "left" | "right" | "middle";
    double?: boolean;
    /**
     * Fires right after the real mousePressed/mouseReleased land (before the
     * trailing settle jitter). A caller racing this against a timeout
     * (phaseRace) can use it to detect "the click actually fired, just the
     * tail was slow" versus "truly dead" — without it, a caller that falls
     * back to a synthetic click on timeout has no way to know the real click
     * might still land a moment later, risking a double-click / double-submit.
     */
    onPressReleaseComplete?: () => void;
  } = {},
): Promise<void> {
  await withDebugger(tabId, async () => {
    const dbg = chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
    };
    // Beforeunload auto-dismiss is owned by the outer click_element handler
    // (see armBeforeunloadDismissOnAttachedTab) so the listener stays armed
    // across the activity probe and fallback chain — a late-firing dialog
    // (Reddit submit can fire it 1-2s after the click, as the API response
    // resolves and the redirect begins) would otherwise hang the tab because
    // the listener registered here was already removed.

    // (Previously: Page.bringToFront here to seed user activation. Removed in
    // 0.10.14 because the stealth shim in stealth.ts now patches
    // document.hasFocus and navigator.userActivation at document_start, which
    // covers the same gates without stealing OS focus from the user's
    // terminal/IDE.)
    const button = options.button ?? "left";
    const ptr = { pointerType: "mouse" as const, force: 0.5 };
    const prev = lastPointerPos.get(tabId);
    const dist = prev ? Math.hypot(prev.x - cx, prev.y - cy) : 0;
    // Only bother resuming from the previous cursor position when the two
    // targets are far enough apart to matter; nearby clicks keep the
    // existing tight random-offset start so the common single-click case is
    // unaffected.
    const useTravel = !!prev && dist > 120;
    // Random start offset kept well under the height of a typical tightly-
    // packed list row (e.g. Google Places Autocomplete's .pac-item rows,
    // ~31px apart) -- a wider offset here let the bezier approach's early
    // samples land inside an ADJACENT row before the path ever reaches the
    // real target, and some suggestion-list widgets track a mouseover-driven
    // "highlighted index" separately from click coordinates, committing
    // whichever row was last hovered rather than the literal click target.
    // 60px (±30) reproduced this live; 24px (±12) stays comfortably inside
    // a same-sized neighbor for any row taller than ~24px while still
    // giving genuine start-position variance for anti-detection purposes.
    const sx = useTravel ? prev!.x : cx + Math.round((Math.random() - 0.5) * 24);
    const sy = useTravel ? prev!.y : cy + Math.round((Math.random() - 0.5) * 24);
    const midX = (sx + cx) / 2;
    const midY = (sy + cy) / 2;
    const perpDx = -(cy - sy);
    const perpDy = cx - sx;
    const perpLen = Math.sqrt(perpDx * perpDx + perpDy * perpDy) || 1;
    const bowPx = (Math.random() * 0.4 - 0.2) * Math.min(80, perpLen);
    const ctlX = midX + (perpDx / perpLen) * bowPx;
    const ctlY = midY + (perpDy / perpLen) * bowPx;
    // A long real traversal needs enough intermediate samples to look
    // continuous; a short/no-previous-position hop keeps the original fixed
    // low step count.
    const steps = useTravel
      ? Math.min(40, Math.max(10, Math.round(dist / 30)))
      : 6 + Math.floor(Math.random() * 4);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const bx = Math.round((1 - t) * (1 - t) * sx + 2 * (1 - t) * t * ctlX + t * t * cx);
      const by = Math.round((1 - t) * (1 - t) * sy + 2 * (1 - t) * t * ctlY + t * t * cy);
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: bx, y: by, button: "none", clickCount: 0, ...ptr,
      });
      await new Promise((r) => setTimeout(r, 8 + Math.random() * 14));
    }
    for (let j = 0; j < 3; j++) {
      const jx = cx + Math.round((Math.random() - 0.5) * 4);
      const jy = cy + Math.round((Math.random() - 0.5) * 4);
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: jx, y: jy, button: "none", clickCount: 0, ...ptr,
      });
      await new Promise((r) => setTimeout(r, 20 + Math.random() * 30));
    }
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 40));
    const clickCount = options.double ? 2 : 1;
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: cx, y: cy, button, clickCount, buttons: 1, ...ptr,
    });
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: cx, y: cy, button, clickCount, buttons: 0, ...ptr,
    });
    if (options.double) {
      // Second click of a double-click within the OS double-click window.
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 50));
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mousePressed", x: cx, y: cy, button, clickCount: 2, buttons: 1, ...ptr,
      });
      await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
      await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseReleased", x: cx, y: cy, button, clickCount: 2, buttons: 0, ...ptr,
      });
    }
    options.onPressReleaseComplete?.();
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
    const px = cx + Math.round((Math.random() - 0.5) * 6);
    const py = cy + Math.round((Math.random() - 0.5) * 6);
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0, ...ptr,
    });
    lastPointerPos.set(tabId, { x: px, y: py });
    // Short tail so an immediately-firing beforeunload dialog is dismissed by
    // the outer click_element handler's listener before this function returns.
    await new Promise((r) => setTimeout(r, 200));
  });
}

/**
 * Deliver a real on-disk file to a drop-zone element via CDP's native drag
 * simulation, for widgets with zero <input type=file> anywhere (built on
 * window.showOpenFilePicker(), the File System Access API, which has no
 * scriptable DOM surface — see content/ops/files.ts's findDropZoneCandidate).
 * Input.dispatchDragEvent is the same CDP Input domain dispatchHumanMouseClick
 * and dispatchKeyboardActivation already use for isTrusted=true events, so a
 * drop delivered this way is a real, trusted DragEvent carrying a real File
 * backed by `filePath` — not a synthetic in-page DataTransfer construction,
 * which only works when a DOM element exists to assign .files on in the first
 * place. dragOperationsMask: 1 is "copy" (the Blink DragOperation bitmask —
 * Copy=1, Link=2, Move=16), the operation a file-drop expects. No
 * setInterceptDrags call needed: that CDP method is for observing/replaying a
 * REAL user-initiated drag, a separate workflow from synthesizing one outright
 * (see chromedevtools.github.io/devtools-protocol/tot/Input/#method-dispatchDragEvent).
 */
export async function dispatchDragDropFile(
  tabId: number,
  cx: number,
  cy: number,
  filePath: string,
): Promise<void> {
  await withDebugger(tabId, async () => {
    const dbg = chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
    };
    const data = { items: [], files: [filePath], dragOperationsMask: 1 };
    await dbg.sendCommand({ tabId }, "Input.dispatchDragEvent", { type: "dragEnter", x: cx, y: cy, data });
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 40));
    // A real held pointer is never perfectly still: emit several jittered
    // dragOver samples (a held drag produces a stream of coordinates, not
    // one) before the precise drop, so the event sequence looks like a
    // continuous hover rather than a single synthesized sample.
    const overSamples = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < overSamples; i++) {
      const jx = cx + Math.round((Math.random() - 0.5) * 2 * (3 + Math.random() * 5));
      const jy = cy + Math.round((Math.random() - 0.5) * 2 * (3 + Math.random() * 5));
      await dbg.sendCommand({ tabId }, "Input.dispatchDragEvent", { type: "dragOver", x: jx, y: jy, data });
      await new Promise((r) => setTimeout(r, 50 + Math.random() * 80));
    }
    await dbg.sendCommand({ tabId }, "Input.dispatchDragEvent", { type: "drop", x: cx, y: cy, data });
    // Short tail, matching dispatchHumanMouseClick's convention, so an
    // immediately-firing beforeunload dialog is still caught by the outer
    // handler's listener before this function returns.
    await new Promise((r) => setTimeout(r, 200));
  });
}

/**
 * Re-read the tagged click target's CURRENT viewport center, scrolling it into
 * view first if it sits outside the viewport. The coordinate captured by
 * prepareClickTarget can go stale before the CDP click dispatches: a tall modal
 * (the Easy Apply Review step) puts its primary button BELOW THE FOLD, and a
 * smooth scroll-into-view may not have settled when prep read x/y, so the
 * coordinate click lands on the wrong element (or misses entirely) and the
 * action never fires. Reading fresh here, after a settle, makes the humanlike
 * bezier click land on the button it actually resolved. Shadow-piercing so it
 * works on web-component modals. Returns null if the element is gone or 0x0
 * (unless visibleAncestorFallback climbs to a visible container, see below).
 */
export async function freshTargetPoint(
  tabId: number,
  markerAttr: string,
  opts: {
    /**
     * When the tagged element itself is a real but 0x0/display:none element,
     * climb to the nearest ancestor (crossing out of shadow roots via .host)
     * that has a non-zero rect and use ITS center instead of bailing out.
     * Off by default, since click_element's target genuinely IS the marked
     * element; a 0x0 click target is a real failure signal there, not
     * something to paper over by clicking a random ancestor. Needed for the
     * file-upload drag-drop escalation: dropzone widgets (Personio,
     * SmartRecruiters, and most react-dropzone/Uppy/FilePond-style
     * uploaders) commonly keep the real <input type=file> visually hidden
     * (display:none or a 0-size clip rect) and render a styled wrapper on
     * top as the actual drop surface, see
     * ISSUE-2026-09-14-personio-cv-upload-still-rejected.md, where the
     * escalation added for ISSUE-2026-09-12-personio-cv-upload-rejection.md
     * never fired at all because this function returned null for the hidden
     * input and the caller had no coordinate to drop onto.
     */
    visibleAncestorFallback?: boolean;
    /**
     * Same-origin iframe CSS selector the tagged element lives inside, if any
     * (mirrors set_file_input's `frame` param). getBoundingClientRect() on an
     * element resolved from an iframe's own document is relative to THAT
     * iframe's viewport, not the top page — the returned point gets the
     * iframe's own on-screen offset added so it lands correctly when CDP
     * dispatches the drag-drop at top-level viewport coordinates. See
     * ISSUE-2026-09-14-icims-hcaptcha-still-silent.md for the motivating case.
     */
    frame?: string;
  } = {},
): Promise<{ x: number; y: number; in_view: boolean } | null> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (attr: string, climbToVisibleAncestor: boolean, frame: string) => {
        const cd = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
        const getSR = (el: Element): ShadowRoot | null => {
          try { if (cd?.openOrClosedShadowRoot) { const sr = cd.openOrClosedShadowRoot(el); if (sr) return sr; } } catch { /* ignore */ }
          return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
        };
        // Same-origin iframes are reachable via plain contentDocument from this
        // function's own (top-frame) execution context — see pierceFileCount's
        // matching comment in cdp/misc.ts.
        const searchDoc: Document = frame
          ? ((document.querySelector(frame) as HTMLIFrameElement | null)?.contentDocument ?? document)
          : document;
        const view = searchDoc.defaultView ?? window;
        const stack: (Document | ShadowRoot)[] = [searchDoc];
        let el: Element | null = null;
        while (stack.length) {
          const root = stack.pop()!;
          const f = root.querySelector(`[${attr}]`);
          if (f) { el = f; break; }
          for (const e of Array.from(root.querySelectorAll("*"))) { const sr = getSR(e); if (sr) stack.push(sr); }
        }
        if (!el) return null;
        let target = el as HTMLElement;
        let rect = target.getBoundingClientRect();
        if (climbToVisibleAncestor && rect.width === 0 && rect.height === 0) {
          let climb: Element | null = target;
          for (let i = 0; i < 20 && climb; i++) {
            const root = climb.getRootNode();
            const parent: Element | null = climb.parentElement
              ?? (root instanceof ShadowRoot ? root.host : null);
            if (!parent) break;
            climb = parent;
            const crect = (climb as HTMLElement).getBoundingClientRect();
            if (crect.width > 0 || crect.height > 0) { target = climb as HTMLElement; rect = crect; break; }
          }
        }
        const outside = rect.bottom < 0 || rect.top > view.innerHeight || rect.right < 0 || rect.left > view.innerWidth
          || rect.top < 0 || rect.bottom > view.innerHeight;
        if (outside) {
          // behavior:"instant" forces a synchronous scroll, but prepareClickTarget
          // already started a SMOOTH scroll that keeps animating; if we read the
          // rect while either is still moving, the click lands at a stale interim
          // position and misses (the Easy Apply below-fold "Submit" bug). So
          // scroll, then POLL until the element's position stops changing (two
          // consecutive reads match) before returning the coordinate, capped so a
          // perpetually-animating page can't hang the click. Cast because some
          // lib.dom versions still type ScrollBehavior as only "auto" | "smooth".
          try { target.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" } as ScrollIntoViewOptions); } catch { /* ignore */ }
          let prevTop = NaN;
          for (let i = 0; i < 12; i++) {
            await new Promise((r) => setTimeout(r, 50));
            const t = target.getBoundingClientRect().top;
            if (t === prevTop) break;
            prevTop = t;
          }
          rect = target.getBoundingClientRect();
        }
        if (rect.width === 0 && rect.height === 0) return null;
        // rect is relative to searchDoc's own viewport — add the iframe's own
        // on-screen position (re-read fresh, after any scrolling above) to
        // convert to top-level viewport coordinates. Zero offset when frame
        // wasn't given, since searchDoc === document in that case.
        let offsetX = 0, offsetY = 0;
        if (frame) {
          const iframeEl = document.querySelector(frame);
          if (iframeEl) {
            const ir = iframeEl.getBoundingClientRect();
            offsetX = ir.left;
            offsetY = ir.top;
          }
        }
        return {
          x: offsetX + rect.left + rect.width / 2,
          y: offsetY + rect.top + rect.height / 2,
          in_view: rect.top >= 0 && rect.bottom <= view.innerHeight,
        };
      },
      args: [markerAttr, opts.visibleAncestorFallback ?? false, opts.frame ?? ""],
    });
    const v = r[0]?.result as { x: number; y: number; in_view: boolean } | null | undefined;
    return v ?? null;
  } catch {
    return null;
  }
}
