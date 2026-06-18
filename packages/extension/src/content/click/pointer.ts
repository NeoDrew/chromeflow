import { queryAllDeep } from "../shadow.js";
import { markerIds } from "../../markers.js";

/**
 * Fire the full pointer-event chain on an input that didn't flip its
 * checked state via the standard click. This is the user-validated reliable
 * pattern for React-controlled radios/checkboxes whose handlers are bound
 * to pointer events. Does NOT call .click() — that's already been tried.
 *
 * Radix and similar dropdown libraries gate `onPointerDown` on
 * `event.isPrimary && event.pointerId != null`. Plain `new PointerEvent(...)`
 * with bubbles/cancelable alone leaves isPrimary=false and pointerId=0, which
 * those handlers ignore. Pass pointerId=1, isPrimary=true, plus the buttons
 * bitfield (1 while pressed, 0 on release) so the chain matches a real mouse.
 */
export function firePointerChain(el: Element) {
  const rect = el.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const baseOpts = {
    bubbles: true,
    cancelable: true,
    // composed:true lets the event cross shadow boundaries in its propagation
    // path, so a handler bound OUTSIDE the shadow root (the React root in a
    // web-component modal's host light DOM) still receives it. Real user events
    // are composed; without this the chain can no-op on shadow-DOM action
    // buttons (the LinkedIn Easy Apply "Submit application" case).
    composed: true,
    view: window,
    clientX: cx,
    clientY: cy,
    button: 0,
  };
  const ptrDown = {
    ...baseOpts,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    buttons: 1,
    pressure: 0.5,
  };
  const ptrUp = { ...ptrDown, buttons: 0, pressure: 0 };
  try {
    el.dispatchEvent(new PointerEvent("pointerdown", ptrDown));
  } catch { /* PointerEvent may be unavailable in old browsers */ }
  el.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, buttons: 1 }));
  try {
    el.dispatchEvent(new PointerEvent("pointerup", ptrUp));
  } catch { /* ignore */ }
  el.dispatchEvent(new MouseEvent("mouseup", baseOpts));
  el.dispatchEvent(new MouseEvent("click", baseOpts));
}

/**
 * Scroll the element into view in both the window AND any nested scrollable
 * ancestor containers (e.g. Stripe's slide-over drawer panels, or any
 * inner-pane SPA where document.body.scrollHeight is dwarfed by the
 * inner scroll container's scrollHeight).
 *
 * Returns a Promise that resolves once the element is confirmed visible in
 * the viewport via IntersectionObserver (or after a 500ms fallback timeout).
 * Shadow DOM radio buttons and Lit components need the scroll to fully
 * settle before a click will register; the old sync approach fired the click
 * in the same tick as the scroll, which was too fast.
 */
export async function scrollSmartIntoView(el: Element): Promise<void> {
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });

  let parent = el.parentElement;
  while (parent && parent !== document.documentElement) {
    const style = getComputedStyle(parent);
    const oy = style.overflowY;
    if (
      (oy === "auto" || oy === "scroll") &&
      parent.scrollHeight > parent.clientHeight
    ) {
      const elRect = el.getBoundingClientRect();
      const pRect = parent.getBoundingClientRect();
      if (elRect.bottom > pRect.bottom) {
        parent.scrollTop += elRect.bottom - pRect.bottom + 16;
      } else if (elRect.top < pRect.top) {
        parent.scrollTop -= pRect.top - elRect.top + 16;
      }
    }
    parent = parent.parentElement;
  }

  await new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => { if (!resolved) { resolved = true; resolve(); } };
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        setTimeout(done, 50);
      }
    }, { threshold: 0.1 });
    observer.observe(el);
    setTimeout(() => { observer.disconnect(); done(); }, 500);
  });
}

/**
 * Fire the full pointer chain on the currently tagged click target element.
 * Used as a fallback when CDP coordinate-based clicks are silently rejected
 * inside shadow DOM: CDP dispatch at coordinates works, but when the event
 * bubbles out of the shadow root, event.target is retargeted to the shadow
 * host, so React event delegation (which checks event.target) discards it.
 * Dispatching directly ON the element inside the shadow root avoids the
 * retargeting problem.
 */
export function pointerChainOnTagged(): { fired: boolean; label?: string } {
  // Shadow-piercing: same reason as postClickInspect — tagged element may
  // live inside a shadow root (Reddit's flair modal, Radix portals).
  const el = queryAllDeep<HTMLElement>(document, `[${markerIds.clickTargetAttr()}]`)[0] ?? null;
  if (!el) return { fired: false };
  firePointerChain(el);
  const label =
    el.innerText?.trim().slice(0, 60) ||
    el.getAttribute("aria-label") ||
    el.tagName.toLowerCase();
  return { fired: true, label };
}

/**
 * Dispatch a sequence of mouse events (mousemove → mouseover → mousedown → mouseup)
 * with humanlike coordinate jitter, before the actual .click() call. Anti-bot
 * systems flag elements that receive isolated click events with no preceding
 * pointer movement.
 *
 * NOTE: these events are still isTrusted=false. Sites that check isTrusted
 * (which is the strongest signal) won't be fooled — only behavioral-pattern
 * detectors. For full bypass we'd need CDP Input.dispatchMouseEvent.
 */
export function dispatchHumanClickEvents(el: Element) {
  try {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Random point within central 60% of the element (avoid edges)
    const cx = rect.left + rect.width * (0.2 + Math.random() * 0.6);
    const cy = rect.top + rect.height * (0.2 + Math.random() * 0.6);
    // Start point: a few px away to simulate approach
    const sx = cx + (Math.random() - 0.5) * 40;
    const sy = cy + (Math.random() - 0.5) * 40;

    const mkEvent = (type: string, x: number, y: number) => new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(x),
      clientY: Math.round(y),
      button: 0,
      buttons: type === "mousedown" || type === "mouseup" ? 1 : 0,
    });

    el.dispatchEvent(mkEvent("mousemove", sx, sy));
    el.dispatchEvent(mkEvent("mouseover", cx, cy));
    el.dispatchEvent(mkEvent("mousemove", cx, cy));
    el.dispatchEvent(mkEvent("mousedown", cx, cy));
    el.dispatchEvent(mkEvent("mouseup", cx, cy));
  } catch {
    // Behavioral humanization is best-effort; never block the click.
  }
}
