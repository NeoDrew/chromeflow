import { queryAllDeep } from "../shadow.js";
import { findDialogByQuery, findTopmostDialog } from "./dialog.js";
import { findClickableAll, findSectionByHeading } from "./resolve.js";

/**
 * Walk up the React fiber tree from `el` looking for an `onClick` prop, and
 * invoke it directly with a minimal synthetic event. Last-resort fallback for
 * the case where CDP-dispatched and synthetic clicks both produce zero
 * activity — typically a React-heavy SPA whose action button passes through
 * an isTrusted=true check OR a one-off `onPointerDown` capture handler that
 * the standard event chain skips. Returns true if a handler was found and
 * called (page may still no-op the call), false if no handler exists.
 *
 * Caveat: this depends on React's __reactProps$<hash> private fiber-key
 * convention, which has been stable across React 16/17/18 but is undocumented.
 * Production builds with mangled property names will break this — that's why
 * it's opt-in via `try_fiber=true` rather than an automatic post-rejection
 * fallback.
 */
export function reactFiberClick(el: Element): { fired: boolean; component?: string } {
  // When the element lives inside a shadow root, the React fiber tree is
  // attached to the React root INSIDE that shadow root, not to the main
  // document's React root. Walking parentElement from inside a shadow root
  // eventually crosses the shadow boundary and reaches light DOM elements
  // that have no __reactProps$ keys, causing the walk to fail. Worse, some
  // shadow root implementations expose non-Element nodes on the boundary
  // that crash on property access (the "toLowerCase" TypeError seen on some
  // shadow-DOM-heavy annotation dashboards).
  //
  // Fix: detect if el is inside a shadow root. If so, also search siblings
  // and children of the shadow root for a React root container, and walk
  // fibers from that container down to find the handler for el.
  let node: any = el; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let depth = 0; depth < 12 && node; depth++) {
    try {
      const fk = Object.keys(node).find((k) => k.startsWith("__reactProps$"));
      const onClick = fk ? node[fk]?.onClick : null;
      if (typeof onClick === "function") {
        const ev = {
          preventDefault() { /* noop */ },
          stopPropagation() { /* noop */ },
          stopImmediatePropagation() { /* noop */ },
          nativeEvent: { isTrusted: true },
          target: el,
          currentTarget: el,
          type: "click",
          bubbles: true,
          cancelable: true,
          defaultPrevented: false,
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
        };
        try {
          onClick(ev);
          const tag = node instanceof Element ? node.tagName.toLowerCase() : "(unknown)";
          return { fired: true, component: tag };
        } catch {
          return { fired: true };
        }
      }
    } catch {
      // Property access on cross-boundary nodes can throw (shadow DOM edge
      // cases where the node is a DocumentFragment or has restricted props).
      // Skip this node and continue walking up.
    }
    node = node instanceof Element ? node.parentElement : null;
  }

  // Shadow-root fallback: find the React root container inside the shadow
  // root and search its children for the fiber handler targeting el.
  let shadowRoot: ShadowRoot | null = null;
  let cur: Node | null = el;
  while (cur) {
    if (cur instanceof ShadowRoot) { shadowRoot = cur; break; }
    cur = cur.parentNode;
  }
  if (shadowRoot) {
    const containers = shadowRoot.querySelectorAll("*");
    for (const container of Array.from(containers)) {
      try {
        const rk = Object.keys(container).find((k) =>
          k.startsWith("__reactContainer$") || k.startsWith("__reactFiber$"));
        if (!rk) continue;
        let fiber: any = (container as any)[rk];
        for (let i = 0; i < 200 && fiber; i++) {
          if (fiber.stateNode === el || fiber.stateNode?.contains?.(el)) {
            const props = fiber.memoizedProps ?? fiber.pendingProps;
            if (typeof props?.onClick === "function") {
              const ev = {
                preventDefault() { /* noop */ },
                stopPropagation() { /* noop */ },
                stopImmediatePropagation() { /* noop */ },
                nativeEvent: { isTrusted: true },
                target: el,
                currentTarget: el,
                type: "click",
                bubbles: true,
                cancelable: true,
                defaultPrevented: false,
                isDefaultPrevented: () => false,
                isPropagationStopped: () => false,
              };
              try {
                props.onClick(ev);
                const tag = fiber.stateNode instanceof Element
                  ? fiber.stateNode.tagName.toLowerCase()
                  : "(shadow-fiber)";
                return { fired: true, component: tag };
              } catch {
                return { fired: true };
              }
            }
          }
          fiber = fiber.child ?? fiber.sibling ?? fiber.return?.sibling;
        }
      } catch {
        // Fiber traversal can throw on detached or mangled trees.
      }
    }
  }

  return { fired: false };
}

/**
 * Resolve the click target using the same matching logic as prepareClickTarget
 * (text + nth + within_selector + near_text), but skip tagging, scrolling, and
 * pre-flight checks. Used by the `react_fiber_click` content-script handler
 * after silently_rejected has fired — at that point the target was already
 * found and clicked once, we just need to re-find it to invoke the fiber prop.
 */
export function reactFiberClickByHint(
  textHint: string,
  nth?: number,
  within_selector?: string,
  near_text?: string,
  in_dialog?: boolean,
  dialog_query?: string,
): { success: boolean; message: string; fired: boolean; component?: string; label?: string } {
  let scope: Document | Element = document;
  if (dialog_query) {
    const d = findDialogByQuery(dialog_query);
    if (!d) return { success: false, message: `dialog_query "${dialog_query}" did not match`, fired: false };
    scope = d;
  } else if (in_dialog) {
    const d = findTopmostDialog();
    if (!d) return { success: false, message: `in_dialog=true but no open dialog`, fired: false };
    scope = d;
  } else if (within_selector) {
    const scoped = queryAllDeep(document, within_selector)[0] ?? null;
    if (!scoped) {
      return { success: false, message: `within_selector "${within_selector}" did not match`, fired: false };
    }
    scope = scoped;
  } else if (near_text) {
    const sectionScope = findSectionByHeading(near_text);
    if (!sectionScope) {
      return { success: false, message: `near_text "${near_text}" did not match`, fired: false };
    }
    scope = sectionScope;
  }
  // Defensive: selector-mode clicks reach the fiber fallback with no textHint.
  // They should be routed to reactFiberClick on the resolved element (see the
  // react_fiber_click handler), but guard here too so a stray undefined can
  // never throw `undefined.toLowerCase()` and mask the real result.
  const lower = (textHint ?? "").toLowerCase().trim();
  if (!lower) {
    return { success: false, message: "react_fiber_click by-hint: no textHint provided (selector-mode should resolve the element directly)", fired: false };
  }
  const matches = findClickableAll(lower, scope);
  const merged = [...matches.visible, ...matches.hidden];
  const idx = (nth && nth >= 1 ? nth : 1) - 1;
  const el = merged[idx];
  if (!el) {
    return { success: false, message: `No clickable element found for "${textHint}"`, fired: false };
  }
  const label =
    (el as HTMLElement).innerText?.trim() ||
    el.getAttribute("aria-label") ||
    textHint;
  const fiber = reactFiberClick(el);
  if (!fiber.fired) {
    return {
      success: false,
      message: `Found "${label}" but no React fiber __reactProps$.onClick exists on the element or its ancestors (up to 12 levels). The button is probably bound via addEventListener (not React), or React's prop key has been mangled by a production minifier. Fall back to highlight_region + wait_for_click for a real human gesture.`,
      fired: false,
      label,
    };
  }
  return {
    success: true,
    message: `Invoked React fiber onClick on "${label}"${fiber.component ? ` (component: ${fiber.component})` : ""}`,
    fired: true,
    component: fiber.component,
    label,
  };
}
