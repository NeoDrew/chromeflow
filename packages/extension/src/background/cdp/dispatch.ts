// CDP input-dispatch cluster: human-like mouse click, tap-gesture fallback,
// keyboard-activation fallback, and the fresh-coordinate re-read used right
// before a dispatch.

import { withDebugger } from "./debugger";

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
  options: { button?: "left" | "right" | "middle"; double?: boolean } = {},
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
    const sx = cx + Math.round((Math.random() - 0.5) * 60);
    const sy = cy + Math.round((Math.random() - 0.5) * 60);
    const midX = (sx + cx) / 2;
    const midY = (sy + cy) / 2;
    const perpDx = -(cy - sy);
    const perpDy = cx - sx;
    const perpLen = Math.sqrt(perpDx * perpDx + perpDy * perpDy) || 1;
    const bowPx = (Math.random() * 0.4 - 0.2) * Math.min(80, perpLen);
    const ctlX = midX + (perpDx / perpLen) * bowPx;
    const ctlY = midY + (perpDy / perpLen) * bowPx;
    const steps = 6 + Math.floor(Math.random() * 4);
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
    await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
    const px = cx + Math.round((Math.random() - 0.5) * 6);
    const py = cy + Math.round((Math.random() - 0.5) * 6);
    await dbg.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none", clickCount: 0, ...ptr,
    });
    // Short tail so an immediately-firing beforeunload dialog is dismissed by
    // the outer click_element handler's listener before this function returns.
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
 * works on web-component modals. Returns null if the element is gone or 0x0.
 */
export async function freshTargetPoint(
  tabId: number,
  markerAttr: string,
): Promise<{ x: number; y: number; in_view: boolean } | null> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: async (attr: string) => {
        const cd = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
        const getSR = (el: Element): ShadowRoot | null => {
          try { if (cd?.openOrClosedShadowRoot) { const sr = cd.openOrClosedShadowRoot(el); if (sr) return sr; } } catch { /* ignore */ }
          return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
        };
        const stack: (Document | ShadowRoot)[] = [document];
        let el: Element | null = null;
        while (stack.length) {
          const root = stack.pop()!;
          const f = root.querySelector(`[${attr}]`);
          if (f) { el = f; break; }
          for (const e of Array.from(root.querySelectorAll("*"))) { const sr = getSR(e); if (sr) stack.push(sr); }
        }
        if (!el) return null;
        const target = el as HTMLElement;
        let rect = target.getBoundingClientRect();
        const outside = rect.bottom < 0 || rect.top > innerHeight || rect.right < 0 || rect.left > innerWidth
          || rect.top < 0 || rect.bottom > innerHeight;
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
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, in_view: rect.top >= 0 && rect.bottom <= innerHeight };
      },
      args: [markerAttr],
    });
    const v = r[0]?.result as { x: number; y: number; in_view: boolean } | null | undefined;
    return v ?? null;
  } catch {
    return null;
  }
}
