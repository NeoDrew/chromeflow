// CDP dispatch + probing cluster. Extracted verbatim from background.ts.
// All functions are tab-scoped (take a tabId) and carry no module-level
// connection/window state — they depend only on chrome.* and each other.

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Inject alert/confirm/prompt interceptors into the page's MAIN world so that
 * JS dialogs don't block the page. The captured message is stored in
 * window._alertCapture and read back by execute_script / click_element.
 */
export async function injectAlertCapture(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        (window as any)._alertCapture = (window as any)._alertCapture ?? null;
        // Pre-set dialog responses: set via set_dialog_response tool, consumed once
        (window as any)._chromeflowDialogResponse = (window as any)._chromeflowDialogResponse ?? { prompt: undefined, confirm: undefined };
        window.alert = (msg?: unknown) => {
          (window as any)._alertCapture = String(msg ?? "");
        };
        window.confirm = (msg?: string) => {
          (window as any)._alertCapture = String(msg ?? "");
          const preset = (window as any)._chromeflowDialogResponse;
          if (preset.confirm !== undefined) {
            const val = preset.confirm;
            preset.confirm = undefined;
            return val;
          }
          return true;
        };
        window.prompt = (msg?: string, def?: string) => {
          (window as any)._alertCapture = String(msg ?? "");
          const preset = (window as any)._chromeflowDialogResponse;
          if (preset.prompt !== undefined) {
            const val = preset.prompt;
            preset.prompt = undefined;
            return val;
          }
          return def !== undefined ? def : null;
        };

        // Console capture — stores last 200 messages for get_console_logs
        if (!(window as any)._consoleLogs) {
          (window as any)._consoleLogs = [];
          const MAX = 200;
          (["log", "warn", "error", "info"] as const).forEach((level) => {
            const original = (console as any)[level];
            (console as any)[level] = function (...args: unknown[]) {
              (window as any)._consoleLogs.push({
                level,
                message: args
                  .map((a) => {
                    try { return typeof a === "object" ? JSON.stringify(a) : String(a); }
                    catch { return String(a); }
                  })
                  .join(" "),
                time: Date.now(),
              });
              if ((window as any)._consoleLogs.length > MAX) (window as any)._consoleLogs.shift();
              original.apply(console, args);
            };
          });
        }

        // In-flight request counter for click_element's network-aware
        // until-poll. The Resource Timing API only records entries AFTER a
        // request completes, so it can't report in-flight requests — we have
        // to count them ourselves by wrapping fetch + XHR. window.__cfInflight
        // holds the live count of pending fetch/XHR requests.
        if (!(window as any).__cfInflightPatched) {
          (window as any).__cfInflightPatched = true;
          (window as any).__cfInflight = 0;
          const dec = () => { (window as any).__cfInflight = Math.max(0, ((window as any).__cfInflight || 0) - 1); };
          const origFetch = window.fetch;
          if (typeof origFetch === "function") {
            window.fetch = function (this: unknown, ...a: unknown[]) {
              (window as any).__cfInflight = ((window as any).__cfInflight || 0) + 1;
              let p: unknown;
              try { p = (origFetch as (...x: unknown[]) => unknown).apply(this, a); }
              catch (e) { dec(); throw e; }
              return Promise.resolve(p as Promise<unknown>).finally(dec);
            } as typeof window.fetch;
          }
          const XHR = window.XMLHttpRequest;
          if (XHR && XHR.prototype && typeof XHR.prototype.send === "function") {
            const origSend = XHR.prototype.send;
            XHR.prototype.send = function (this: XMLHttpRequest, ...a: unknown[]) {
              try {
                (window as any).__cfInflight = ((window as any).__cfInflight || 0) + 1;
                this.addEventListener("loadend", dec, { once: true });
              } catch { /* ignore */ }
              return (origSend as (...x: unknown[]) => unknown).apply(this, a);
            } as typeof XHR.prototype.send;
          }
        }
      },
    });
  } catch {
    // Non-scriptable pages (chrome://, etc.) will throw — ignore.
  }
}

// ─── Debugger mutex ────────────────────────────────────────────────────────
// Chrome allows only one debugger client per tab. If execute_script (CSP
// bypass path), type_text, and set_file_input all want to attach to the same
// tab, concurrent calls would race and the second attach fails with
// "Another debugger is already attached." This serializes all debugger
// operations per tab — each call waits for the previous one to detach.
export const tabDebuggerLocks = new Map<number, Promise<void>>();
// Refcount for nested withDebugger calls on the same tab. Lets click_element
// hold a single outer attach across prep + CDP click + activity probe +
// fallback chain + until-poll so a beforeunload listener registered at the
// outer scope stays armed when nested CDP helpers (dispatchHumanMouseClick,
// dispatchTapGesture, dispatchKeyboardActivation) finish their inner blocks.
// Without this, the inner withDebugger detaches between the click and the
// probe, and a "Leave site?" dialog that fires during the probe hangs the
// tab because the listener can no longer send Page.handleJavaScriptDialog.
export const tabDebuggerRefCount = new Map<number, number>();

export async function withDebugger<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  // Nested call inside an outer attach: skip both the queue and the
  // attach/detach pair. Just bump the refcount and run.
  const existing = tabDebuggerRefCount.get(tabId) ?? 0;
  if (existing > 0) {
    tabDebuggerRefCount.set(tabId, existing + 1);
    try {
      return await fn();
    } finally {
      const cur = tabDebuggerRefCount.get(tabId) ?? 1;
      if (cur <= 1) tabDebuggerRefCount.delete(tabId);
      else tabDebuggerRefCount.set(tabId, cur - 1);
    }
  }

  const prev = tabDebuggerLocks.get(tabId);
  if (prev) await prev.catch(() => {});

  let release!: () => void;
  const lock = new Promise<void>((r) => { release = r; });
  tabDebuggerLocks.set(tabId, lock);

  try {
    // Retry attach up to 5 times with 500ms..2500ms backoff. The most common
    // failure isn't a real conflict (DevTools, second chromeflow instance) —
    // it's a transient race inside chromeflow itself where one handler's
    // detach hasn't propagated yet when the next handler tries to attach.
    // Bumped from 3 → 5 attempts because the 3-attempt budget (~1.5s) was
    // tripping on these races even when no real conflict existed.
    const MAX_ATTEMPTS = 5;
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await (chrome.debugger as any).attach({ tabId }, "1.3");
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err as Error;
        const msg = String(lastErr.message ?? err);
        if (msg.includes("Another debugger is already attached") && attempt < MAX_ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        if (msg.includes("Another debugger is already attached")) {
          throw new Error(
            `Another debugger is already attached to this tab after ${MAX_ATTEMPTS} retries (waited ~7.5s). If you do not have Chrome DevTools open (Cmd+Opt+I) and no other chromeflow instance is using this tab, this is likely a transient internal race — retrying the same call should succeed. If it persists, close DevTools or move the other chromeflow instance to a separate Chrome window.`
          );
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;

    tabDebuggerRefCount.set(tabId, 1);
    try {
      return await fn();
    } finally {
      tabDebuggerRefCount.delete(tabId);
      await (chrome.debugger as any).detach({ tabId }).catch(() => {});
    }
  } finally {
    release();
    if (tabDebuggerLocks.get(tabId) === lock) tabDebuggerLocks.delete(tabId);
  }
}

/**
 * Count anti-bot-friendly "something happened" selectors on the active page.
 * Used by click_element's `expect_submit` flag: snapshot pre-click counts,
 * compare after to detect NEW alerts/toasts/modals appearing. Without the
 * snapshot, a pre-existing toast would be misread as a post-submit signal.
 *
 * Selectors chosen to cover the common UI libraries: Radix (role=alert),
 * Sonner (data-sonner-toast), shadcn / Tailwind UI (.toast, .notification),
 * accessibility-correct apps (aria-live), and any modal / dialog. Excludes
 * aria-hidden elements (offscreen carriers used for screen-reader semantics).
 */
export async function getSubmitSignalCounts(tabId: number): Promise<{ alert: number; toast: number; modal: number }> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const c = (sel: string) => {
          try { return document.querySelectorAll(sel).length; }
          catch { return 0; }
        };
        return {
          alert:
            c('[role="alert"]:not([aria-hidden="true"])') +
            c('[aria-live="polite"]:not(:empty):not([aria-hidden="true"])') +
            c('[aria-live="assertive"]:not(:empty):not([aria-hidden="true"])'),
          toast:
            c('[data-sonner-toast]') +
            c('.toast:not(.hidden):not([aria-hidden="true"])') +
            c('.notification:not(.hidden):not([aria-hidden="true"])'),
          modal:
            c('[role="dialog"]:not([aria-hidden="true"])') +
            c('[aria-modal="true"]'),
        };
      },
    });
    return (r[0]?.result as { alert: number; toast: number; modal: number } | undefined) ?? { alert: 0, toast: 0, modal: 0 };
  } catch {
    return { alert: 0, toast: 0, modal: 0 };
  }
}

/**
 * Classify the first VISIBLE dialog/modal on the page, piercing open AND closed
 * shadow roots. Distinguishes a two-step "confirmation" dialog (the click
 * worked; click the primary action to complete) from a "required-input" prompt
 * (supply a value first) and surfaces the primary action label. Returns null
 * when no visible dialog is present. Shared by the post-timeout blocker
 * diagnosis and the in-loop early-dialog detection so a two-step submit doesn't
 * burn the whole until-timeout before the dialog is recognised.
 */
export async function classifyTopDialog(
  tabId: number,
): Promise<{ kind: string; label: string; primary_action: string } | null> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
        function getShadowRoot(el: Element): ShadowRoot | null {
          if (chromeDom?.openOrClosedShadowRoot) {
            try { const sr = chromeDom.openOrClosedShadowRoot(el); if (sr) return sr; } catch { /* ignore */ }
          }
          return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
        }
        function deepAllWithin(root: Element, sel: string): Element[] {
          const out: Element[] = [];
          const stack: (Element | ShadowRoot)[] = [root];
          while (stack.length) {
            const r = stack.pop()!;
            for (const el of Array.from(r.querySelectorAll(sel))) out.push(el);
            const scope = r instanceof Element ? [r, ...Array.from(r.querySelectorAll("*"))] : Array.from(r.querySelectorAll("*"));
            for (const el of scope) {
              const sr = getShadowRoot(el);
              if (sr) stack.push(sr);
            }
          }
          return out;
        }
        // First VISIBLE dialog: skip stale hidden dialog nodes that SPAs
        // (Radix/headless) leave mounted but display:none, which would
        // otherwise mask the real one that just opened.
        const dialogSel = '[role="dialog"]:not([aria-hidden="true"]), [aria-modal="true"], dialog[open], faceplate-dialog:not([hidden])';
        let dialog: Element | null = null;
        for (const cand of deepAllWithin(document.documentElement, dialogSel)) {
          const cr = (cand as HTMLElement).getBoundingClientRect?.();
          if (cr && cr.width === 0 && cr.height === 0) continue;
          dialog = cand;
          break;
        }
        if (!dialog) return null;
        const heading = dialog.querySelector("h1, h2, h3, [role='heading']")?.textContent?.trim() ?? "";
        const aria = dialog.getAttribute("aria-label") ?? "";
        const label = (heading || aria || dialog.tagName.toLowerCase()).slice(0, 80);

        // Does the dialog ask for input?
        const hasField = deepAllWithin(dialog,
          'input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=reset]), textarea, select, [contenteditable="true"], [role="radio"], [role="checkbox"], [role="textbox"], [role="combobox"], [role="listbox"]'
        ).length > 0;
        const txt = (dialog.textContent ?? "").slice(0, 2000);
        const validationText = /\b(is required|required field|please (?:answer|select|choose|enter|provide|complete)|you must (?:answer|select|choose|provide|complete))\b/i.test(txt);

        // Primary action button: prefer an affirmative verb, else the last
        // button (dialogs usually order [Cancel][Confirm]).
        const btns = deepAllWithin(dialog, 'button, [role="button"], a[href]')
          .map((b) => (b.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter((t) => t.length > 0 && t.length < 40);
        const affirmative = btns.find((t) => /\b(confirm|submit|continue|proceed|yes|ok|okay|accept|save|delete|got it|next)\b/i.test(t));
        const primary = (affirmative || btns[btns.length - 1] || "").slice(0, 40);

        const kind = (hasField || validationText) ? "required-input" : (primary ? "confirmation" : "dialog");
        return { kind, label, primary_action: primary };
      },
    });
    return (r[0]?.result as { kind: string; label: string; primary_action: string } | null | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Per-click activity probe. Watches the page for a short window after a
 * click dispatch and reports whether ANY observable side-effect happened —
 * DOM mutation, focus change, URL change, value/checked change on the
 * clicked element, or alert/toast/modal appearance.
 *
 * Returns early (before the full `windowMs` elapses) as soon as activity is
 * detected, so the common case adds only ~100ms of latency. When 0 activity
 * is detected at the end of the window, the caller can fail fast with a
 * "silently rejected by anti-bot" message instead of sitting in a long
 * until_* poll waiting for a condition that will never resolve.
 *
 * Also returns the focused element after the window — used by click_element
 * to populate the `focused_after` response field so callers can chain
 * type_text/fill_input without guessing whether focus landed.
 */
export type ActivityProbeResult = {
  activity: boolean;
  reason: string;
  mutation_count: number;
  url_changed: boolean;
  after_url: string;
  focused_after: {
    tag: string;
    id: string;
    name: string;
    type: string;
    aria_label: string;
    value_preview: string;
  } | null;
};

/**
 * Race a promise against a labeled timeout. Used by click_element to convert
 * a single 30s WS-cap into per-phase timeouts so when something hangs we
 * know WHICH phase hung (CDP attach, bezier dispatch, activity probe, fiber
 * walk, post-click read), not just "timed out somewhere in 30s".
 *
 * The PHASE_BUDGET_MULT env var lets the user field-tune budgets without a
 * release. Defaults to 1.0; set CHROMEFLOW_PHASE_BUDGET_MULT in the popup or
 * via runtime config when iterating on a particular hang.
 */
export const PHASE_BUDGET_MULT = 1.0; // multiplicative knob, future runtime config
export function phaseRace<T>(label: string, ms: number, p: Promise<T>): Promise<T> {
  const budget = Math.max(50, ms * PHASE_BUDGET_MULT);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`phase=${label} exceeded ${budget}ms`) as Error & { phase?: string; phaseTimedOut?: boolean };
      err.phase = label;
      err.phaseTimedOut = true;
      reject(err);
    }, budget);
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Attach a CDP listener that auto-accepts Chrome's native "Leave site?" /
 * "Reload site?" beforeunload dialog on the given tab. Returns a `release`
 * callback that detaches the listener and reports whether a dialog was
 * dismissed during the protected window.
 *
 * Used by navigate, close_tab, and close_other_tabs so the agent doesn't
 * hang at the WS timeout when the target tab has unsaved form state. The
 * `dismissed_beforeunload` field in the tool response tells the caller
 * that the page HAD unsaved content (so they can navigate back + recover
 * if it mattered).
 *
 * Best-effort: if the debugger attach fails (already attached, no
 * permission, non-scriptable URL), the dialog will block as before and
 * dismissed stays false. Caller can detect that via the response field.
 */
export async function setupBeforeunloadAutoDismiss(tabId: number): Promise<{
  release: () => Promise<{ dismissed: boolean }>;
}> {
  let dismissed = false;
  let attached = false;
  let handler:
    | ((source: chrome.debugger.Debuggee, method: string, params?: object) => void)
    | null = null;
  try {
    await (chrome.debugger as unknown as { attach: (t: { tabId: number }, v: string) => Promise<void> })
      .attach({ tabId }, "1.3");
    attached = true;
    await (chrome.debugger as unknown as { sendCommand: (t: { tabId: number }, m: string) => Promise<unknown> })
      .sendCommand({ tabId }, "Page.enable");
    handler = (source, method, params) => {
      if (source.tabId !== tabId) return;
      const p = params as { type?: string } | undefined;
      if (method === "Page.javascriptDialogOpening" && p?.type === "beforeunload") {
        (chrome.debugger as unknown as { sendCommand: (t: { tabId: number }, m: string, args?: object) => Promise<unknown> })
          .sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true })
          .catch(() => {});
        dismissed = true;
      }
    };
    chrome.debugger.onEvent.addListener(handler);
  } catch {
    // Debugger attach failed. Navigation/close proceeds without protection.
  }
  return {
    release: async () => {
      if (handler) {
        chrome.debugger.onEvent.removeListener(handler);
        handler = null;
      }
      if (attached) {
        try {
          await (chrome.debugger as unknown as { detach: (t: { tabId: number }) => Promise<void> })
            .detach({ tabId });
        } catch { /* may already be detached after tab close / navigation */ }
      }
      return { dismissed };
    },
  };
}

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
 * Register a Page.javascriptDialogOpening listener that auto-dismisses the
 * native "Leave site?" / "Reload site?" beforeunload dialog on the given tab.
 * Assumes the caller is already inside an active withDebugger attach. Returns
 * a `release` callback that detaches the listener and reports whether a
 * dialog was dismissed during the protected window.
 *
 * Owned by click_element so the listener spans the entire flow: prep, CDP
 * click, activity probe, fallback chain, until-poll. Reddit's submit flow
 * fires the beforeunload 1-2s AFTER the click (post-API navigation), well
 * after dispatchHumanMouseClick's own withDebugger would have detached.
 */
export async function armBeforeunloadDismissOnAttachedTab(tabId: number): Promise<{
  release: () => { dismissed: boolean };
}> {
  let dismissed = false;
  let handler:
    | ((source: chrome.debugger.Debuggee, method: string, params?: object) => void)
    | null = null;
  try {
    await (chrome.debugger as unknown as {
      sendCommand: (t: { tabId: number }, m: string) => Promise<unknown>;
    }).sendCommand({ tabId }, "Page.enable");
    handler = (source, method, params) => {
      if (source.tabId !== tabId) return;
      const p = params as { type?: string } | undefined;
      if (method === "Page.javascriptDialogOpening" && p?.type === "beforeunload") {
        (chrome.debugger as unknown as {
          sendCommand: (t: { tabId: number }, m: string, args?: object) => Promise<unknown>;
        }).sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
        dismissed = true;
      }
    };
    chrome.debugger.onEvent.addListener(handler);
  } catch { /* Page.enable failed; flow proceeds without protection */ }
  return {
    release: () => {
      if (handler) {
        try { chrome.debugger.onEvent.removeListener(handler); } catch { /* ignore */ }
        handler = null;
      }
      return { dismissed };
    },
  };
}

/**
 * Snapshot the shadow-pierce visible-element count for `tabId` BEFORE
 * a click is dispatched. The activity probe needs a baseline that pre-
 * dates any state change the click might trigger; if we baseline inside
 * the probe (post-click), Lit / Stencil renders that complete synchronously
 * during click dispatch end up already-counted and the delta reads 0
 * (Reddit's flair picker is the canonical case — open synchronously,
 * adds ~78 visible elements, post-click baseline matches post-render
 * state and the probe falsely reports silently_rejected).
 */
export async function snapshotVisibleCount(tabId: number): Promise<number | null> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        function getShadowRoot(el: Element): ShadowRoot | null {
          const cdom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
          if (cdom?.openOrClosedShadowRoot) {
            try {
              const sr = cdom.openOrClosedShadowRoot(el);
              if (sr) return sr;
            } catch { /* fall through */ }
          }
          return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
        }
        let count = 0;
        const seenRoots = new WeakSet<ShadowRoot>();
        function walk(root: Document | ShadowRoot) {
          const all = root.querySelectorAll("*");
          for (const el of Array.from(all)) {
            if ((el as HTMLElement).offsetParent !== null) count++;
            const sr = getShadowRoot(el);
            if (sr && !seenRoots.has(sr)) {
              seenRoots.add(sr);
              walk(sr);
            }
          }
        }
        walk(document);
        return count;
      },
    });
    const val = r[0]?.result;
    return typeof val === "number" ? val : null;
  } catch {
    return null;
  }
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

export async function runActivityProbe(
  tabId: number,
  beforeUrl: string,
  windowMs: number = 1500,
  externalBaseline: number | null = null,
  targetMarkerAttr: string | null = null,
): Promise<ActivityProbeResult> {
  const empty: ActivityProbeResult = {
    activity: true,
    reason: "(probe skipped or failed; assuming activity)",
    mutation_count: 0,
    url_changed: false,
    after_url: beforeUrl,
    focused_after: null,
  };
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: (windowMs: number, beforeUrl: string, externalBaseline: number | null, targetMarkerAttr: string | null) => {
        return new Promise<ActivityProbeResult>((resolve) => {
          function getShadowRoot(el: Element): ShadowRoot | null {
            const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
            if (chromeDom?.openOrClosedShadowRoot) {
              try {
                const sr = chromeDom.openOrClosedShadowRoot(el);
                if (sr) return sr;
              } catch { /* fall through */ }
            }
            return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
          }
          function getFocused(): ActivityProbeResult["focused_after"] {
            let el: Element | null = document.activeElement;
            while (el) {
              const sr = getShadowRoot(el);
              if (!sr || !sr.activeElement) break;
              el = sr.activeElement;
            }
            if (!el || el === document.body) return null;
            const anyEl = el as Element & { name?: string; type?: string; value?: string };
            const innerText = (el as HTMLElement).innerText ?? "";
            return {
              tag: el.tagName.toLowerCase(),
              id: el.id || "",
              name: anyEl.name ?? "",
              type: anyEl.type ?? "",
              aria_label: el.getAttribute("aria-label") || "",
              value_preview: (anyEl.value ?? innerText ?? "").slice(0, 60),
            };
          }
          function getSignalCounts() {
            const c = (sel: string) => {
              try { return document.querySelectorAll(sel).length; }
              catch { return 0; }
            };
            return {
              alert:
                c('[role="alert"]:not([aria-hidden="true"])') +
                c('[aria-live="polite"]:not(:empty):not([aria-hidden="true"])') +
                c('[aria-live="assertive"]:not(:empty):not([aria-hidden="true"])'),
              toast:
                c('[data-sonner-toast]') +
                c('.toast:not(.hidden):not([aria-hidden="true"])') +
                c('.notification:not(.hidden):not([aria-hidden="true"])'),
              modal:
                c('[role="dialog"]:not([aria-hidden="true"])') +
                c('[aria-modal="true"]'),
            };
          }
          // Shadow-piercing VISIBLE element count. The plain MutationObserver
          // does NOT pierce shadow DOM, so when a Lit / Stencil / Radix
          // component swaps visibility on pre-rendered content (e.g.
          // Reddit's r-post-flairs-modal flair picker — the whole
          // FACEPLATE-FORM tree is rendered up-front and shown/hidden via
          // CSS classes on shadow children when the trigger is clicked),
          // the observer reports zero mutations and the click looks
          // silently_rejected even though it worked.
          //
          // We snapshot the count of visible elements (offsetParent !==
          // null filters out display:none and detached subtrees) walking
          // through every shadow root via chrome.dom.openOrClosedShadowRoot,
          // and re-check during the probe window as a fallback signal.
          function deepVisibleCount(): number {
            let count = 0;
            const seenRoots = new WeakSet<ShadowRoot>();
            function walk(root: Document | ShadowRoot) {
              const all = root.querySelectorAll("*");
              for (const el of Array.from(all)) {
                const htmlEl = el as HTMLElement;
                if (htmlEl.offsetParent !== null) count++;
                const sr = getShadowRoot(el);
                if (sr && !seenRoots.has(sr)) {
                  seenRoots.add(sr);
                  walk(sr);
                }
              }
            }
            walk(document);
            return count;
          }
          const focusedBefore = getFocused();
          const focusedKeyBefore = focusedBefore ? JSON.stringify(focusedBefore) : "";
          const signalsBefore = getSignalCounts();
          // Snapshot the tagged click target's state-bearing attributes so
          // we can detect state changes that don't produce general DOM
          // mutations (a faceplate-radio-input toggling aria-checked, a
          // Lit dropdown flipping aria-expanded, a contenteditable changing
          // its value). Without this, the probe reports "no activity" on
          // every Reddit radio click even though the radio IS now selected.
          const STATE_ATTRS = [
            "aria-checked", "aria-selected", "aria-expanded",
            "aria-pressed", "aria-current", "data-state",
            "checked", "value", "disabled",
          ];
          function snapshotTargetState(): string | null {
            if (!targetMarkerAttr) return null;
            const stack: (Document | ShadowRoot)[] = [document];
            while (stack.length) {
              const root = stack.pop()!;
              const found = root.querySelector(`[${targetMarkerAttr}]`);
              if (found) {
                const parts: string[] = [];
                for (const a of STATE_ATTRS) parts.push(`${a}=${found.getAttribute(a) ?? ""}`);
                if (found instanceof HTMLInputElement) parts.push(`prop_checked=${found.checked}`);
                return parts.join("|");
              }
              for (const el of Array.from(root.querySelectorAll("*"))) {
                const sr = getShadowRoot(el);
                if (sr) stack.push(sr);
              }
            }
            return null;
          }
          const targetStateBefore = snapshotTargetState();
          // Prefer caller-supplied pre-click baseline. If absent, fall
          // back to taking it now (sufficient for most callers; only
          // synchronous-render Lit components require the pre-click path).
          const deepCountBefore = typeof externalBaseline === "number"
            ? externalBaseline
            : deepVisibleCount();
          let mutationCount = 0;
          const observer = new MutationObserver((records) => {
            mutationCount += records.length;
          });
          observer.observe(document, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          // Last time deepVisibleCount() was sampled. The deep walk is the
          // single most expensive check in the probe (50-150ms on a heavy
          // page with many shadow hosts). Cheap signals (URL, mutations,
          // focus, target attr, role-based count) fire every 100ms tick;
          // the deep walk only runs every 500ms AND on the final tick.
          // Catches Lit/Stencil/Radix visibility flips with ~half the CPU.
          let lastDeepCheckAt = 0;
          function check(isFinalTick: boolean): { activity: boolean; reason: string; url_changed: boolean } {
            const after_url = location.href;
            if (after_url !== beforeUrl) {
              return { activity: true, reason: `URL changed to ${after_url}`, url_changed: true };
            }
            if (mutationCount > 0) {
              return { activity: true, reason: `${mutationCount} DOM mutation${mutationCount === 1 ? "" : "s"}`, url_changed: false };
            }
            const focusedNow = getFocused();
            const focusedKeyNow = focusedNow ? JSON.stringify(focusedNow) : "";
            if (focusedKeyNow !== focusedKeyBefore) {
              return { activity: true, reason: "focused element changed", url_changed: false };
            }
            // Target element attribute change — catches form-input state
            // changes (aria-checked, checked) and Lit/Radix dropdown state
            // changes (aria-expanded, data-state) on the SPECIFIC element
            // that was clicked. MutationObserver detects these at the
            // document level too, but radios in shadow DOM with custom
            // attribute names sometimes evade general subtree observation.
            const targetStateNow = snapshotTargetState();
            if (targetStateBefore !== null && targetStateNow !== null && targetStateNow !== targetStateBefore) {
              return { activity: true, reason: "target element state attribute changed", url_changed: false };
            }
            const c = getSignalCounts();
            if (c.alert > signalsBefore.alert) return { activity: true, reason: "alert/aria-live element appeared", url_changed: false };
            if (c.toast > signalsBefore.toast) return { activity: true, reason: "toast / notification appeared", url_changed: false };
            if (c.modal > signalsBefore.modal) return { activity: true, reason: "modal / [role=dialog] appeared", url_changed: false };
            // Throttled shadow-pierce VISIBLE-element count check (catches
            // Lit / Stencil / Radix shows that flip visibility on pre-
            // rendered shadow-DOM content, which MutationObserver misses
            // entirely because no nodes are added — only CSS visibility
            // changes). Threshold >= 5 to filter background tickers / single-
            // node spinners. Reddit's flair picker exposes ~78 newly-visible
            // elements when opened. Sampled every 500ms + on the final tick
            // to keep cost ~3x lower than the previous every-100ms sampling.
            const now = Date.now();
            if (isFinalTick || now - lastDeepCheckAt >= 500) {
              lastDeepCheckAt = now;
              const deepCountNow = deepVisibleCount();
              const delta = deepCountNow - deepCountBefore;
              if (delta >= 5) {
                return { activity: true, reason: `shadow-pierce visible-element count grew by ${delta}`, url_changed: false };
              }
            }
            return { activity: false, reason: "", url_changed: false };
          }
          const start = Date.now();
          function tick() {
            const elapsed = Date.now() - start;
            const isFinalTick = elapsed + 100 >= windowMs;
            const r = check(isFinalTick);
            if (r.activity || elapsed >= windowMs) {
              observer.disconnect();
              resolve({
                activity: r.activity,
                reason: r.reason,
                mutation_count: mutationCount,
                url_changed: r.url_changed,
                after_url: location.href,
                focused_after: getFocused(),
              });
              return;
            }
            setTimeout(tick, 100);
          }
          tick();
        });
      },
      args: [windowMs, beforeUrl, externalBaseline, targetMarkerAttr],
      // Default ISOLATED world — chrome.dom.openOrClosedShadowRoot is only
      // available in extension content-script contexts, not in the page's
      // MAIN world. ISOLATED still shares the live DOM so MutationObserver
      // / activeElement / location.href all reflect the page accurately.
    });
    const result = r[0]?.result as ActivityProbeResult | undefined;
    return result ?? empty;
  } catch {
    return empty;
  }
}

/**
 * Count in-flight fetch/XHR requests on the page. Lets click_element's
 * until-poll tell a slow-but-real submit (API request still resolving, so the
 * URL change is merely pending) apart from a click that never registered.
 * `responseEnd === 0` means started-but-not-finished. We ignore entries older
 * than 30s so a long-lived SSE / websocket opened at page load isn't mistaken
 * for a pending submit, and only count fetch/XHR (not images, scripts, css).
 */
export async function countInFlightRequests(tabId: number): Promise<number> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      // MAIN world: window.__cfInflight is the live pending-request count
      // maintained by the fetch/XHR wrappers installed in injectAlertCapture.
      // (Resource Timing can't see in-flight requests — it records on
      // completion — so we count them ourselves.)
      world: "MAIN",
      func: () => {
        try {
          const n = (window as unknown as { __cfInflight?: number }).__cfInflight;
          return typeof n === "number" && n > 0 ? n : 0;
        } catch {
          return 0;
        }
      },
    });
    return (r[0]?.result as number | undefined) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Sync a React-controlled radio/checkbox's store after a click that flipped the
 * DOM .checked but didn't reach React's onChange (shadow-boundary retargeting).
 * Runs in MAIN world because React's __reactProps$<hash> expando is only
 * visible there. SAFE / idempotent: fires onChange ONLY when the element's
 * controlled `checked` prop (what React last rendered) disagrees with the
 * current DOM .checked — so an already-committed change is left alone and a
 * functional-toggle handler is never double-fired.
 */
export async function commitReactControlState(
  tabId: number,
  markerAttr: string,
): Promise<{ committed: boolean; kind?: string }> {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (attr: string) => {
        try {
          // Find the tagged element, piercing OPEN shadow roots (MAIN world has
          // no chrome.dom, so closed roots aren't reachable here — but React
          // state that MAIN-world code can touch lives in light/open DOM).
          function deepFind(sel: string): Element | null {
            const stack: (Document | ShadowRoot)[] = [document];
            while (stack.length) {
              const root = stack.pop()!;
              const hit = root.querySelector(sel);
              if (hit) return hit;
              for (const el of Array.from(root.querySelectorAll("*"))) {
                const sr = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                if (sr) stack.push(sr);
              }
            }
            return null;
          }
          const target = deepFind(`[${attr}]`);
          if (!target) return { committed: false };

          // Resolve to the actual radio/checkbox input (the target may be a
          // wrapping label or a custom control).
          let input: HTMLInputElement | null = null;
          if (target instanceof HTMLInputElement && (target.type === "radio" || target.type === "checkbox")) {
            input = target;
          } else {
            const forId = target.getAttribute?.("for");
            if (forId) {
              const t = document.getElementById(forId);
              if (t instanceof HTMLInputElement && (t.type === "radio" || t.type === "checkbox")) input = t;
            }
            if (!input) {
              const inner = target.querySelector?.('input[type="radio"], input[type="checkbox"]');
              if (inner instanceof HTMLInputElement) input = inner;
            }
          }
          if (!input) return { committed: false };

          // Walk up from the input looking for __reactProps$ with an onChange,
          // piercing shadow boundaries (parentElement is null at a shadow root,
          // so hop to the host). Use the INPUT's controlled `checked` prop for
          // the desync test, and note whether the subtree is React-managed at
          // all so the native fallback below can run even when no onChange prop
          // is directly reachable.
          let node: Element | null = input;
          let onChange: ((e: unknown) => void) | null = null;
          let controlledChecked: boolean | undefined;
          let reactManaged = false;
          for (let depth = 0; depth < 8 && node; depth++) {
            const keys = Object.keys(node);
            if (keys.some((k) => k.startsWith("__reactProps$") || k.startsWith("__reactFiber$"))) {
              reactManaged = true;
            }
            const key = keys.find((k) => k.startsWith("__reactProps$"));
            const props = key ? (node as unknown as Record<string, { onChange?: unknown; checked?: unknown }>)[key] : undefined;
            if (props) {
              if (controlledChecked === undefined && typeof props.checked === "boolean") {
                controlledChecked = props.checked;
              }
              if (!onChange && typeof props.onChange === "function") {
                onChange = props.onChange as (e: unknown) => void;
              }
            }
            if (onChange && controlledChecked !== undefined) break;
            node = node.parentElement
              ?? (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
          }

          // Path 1: standard React controlled input with a directly callable
          // onChange — fire it on a genuine prop/DOM desync.
          if (onChange && controlledChecked !== undefined) {
            if (controlledChecked === input.checked) return { committed: false, kind: input.type };
            const ev = {
              target: input,
              currentTarget: input,
              type: "change",
              bubbles: true,
              cancelable: true,
              defaultPrevented: false,
              nativeEvent: { isTrusted: true },
              preventDefault() { /* noop */ },
              stopPropagation() { /* noop */ },
              stopImmediatePropagation() { /* noop */ },
              persist() { /* noop */ },
              isDefaultPrevented: () => false,
              isPropagationStopped: () => false,
            };
            onChange(ev);
            return { committed: true, kind: input.type };
          }

          // Path 2: the subtree is React-managed but onChange wasn't directly
          // reachable (event delegated to the React root, or the prop lives
          // beyond our walk). Re-assert `checked` through the NATIVE setter, then
          // dispatch input+change. The native setter matters: `input.checked = x`
          // goes through React's OWN setter, which records the value in React's
          // value-tracker, so the subsequent change reads as a no-op and the
          // store never updates (this is exactly why a plain synthetic click
          // doesn't commit these radios). Going through the prototype's native
          // setter leaves the tracker stale, so the dispatched change is detected
          // and the controlled state commits. Same trick react_set_input uses for
          // text values. Gated on reactManaged so plain radios — whose click
          // already fired a real change — don't get a duplicate event.
          if (reactManaged) {
            const proto = Object.getPrototypeOf(input);
            const setter = Object.getOwnPropertyDescriptor(proto, "checked")?.set;
            try { input.focus(); } catch { /* focus may be denied */ }
            if (setter) setter.call(input, input.checked);
            input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            return { committed: true, kind: input.type + " (native)" };
          }

          return { committed: false };
        } catch {
          return { committed: false };
        }
      },
      args: [markerAttr],
    });
    return (r[0]?.result as { committed: boolean; kind?: string } | undefined) ?? { committed: false };
  } catch {
    return { committed: false };
  }
}

/**
 * Inlined helpers for `set_file_input`'s pre/post snapshots. Each function is
 * shipped via chrome.scripting.executeScript and runs in the page's ISOLATED
 * world, where chrome.dom.openOrClosedShadowRoot is available. Inlining the
 * shadow-piercing query here means file inputs nested inside Stencil/Lit/
 * Radix web components are counted, not invisible.
 */
export function pierceFileCount(): { totalFiles: number; inputCount: number } {
  function getShadowRoot(el: Element): ShadowRoot | null {
    const cdom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
    if (cdom?.openOrClosedShadowRoot) {
      try {
        const sr = cdom.openOrClosedShadowRoot(el);
        if (sr) return sr;
      } catch { /* fall through */ }
    }
    return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
  }
  function deepInputs(root: Document | ShadowRoot): HTMLInputElement[] {
    const out: HTMLInputElement[] = [];
    const seen = new WeakSet<Element>();
    function recurse(r: ParentNode) {
      for (const m of Array.from(r.querySelectorAll<HTMLInputElement>("input[type=file]"))) {
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
  const inputs = deepInputs(document);
  let total = 0;
  for (const el of inputs) total += el.files?.length ?? 0;
  return { totalFiles: total, inputCount: inputs.length };
}

export function pierceFilePoll(name: string, sel: string): { total: number; stillHasOurFile: boolean; verifyOk: boolean } {
  function getShadowRoot(el: Element): ShadowRoot | null {
    const cdom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
    if (cdom?.openOrClosedShadowRoot) {
      try {
        const sr = cdom.openOrClosedShadowRoot(el);
        if (sr) return sr;
      } catch { /* fall through */ }
    }
    return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
  }
  function deepQuery<E extends Element = Element>(root: ParentNode, selector: string): E[] {
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
  const inputs = deepQuery<HTMLInputElement>(document, "input[type=file]");
  let total = 0;
  let stillHasOurFile = false;
  for (const el of inputs) {
    const files = el.files;
    if (!files) continue;
    total += files.length;
    for (let i = 0; i < files.length; i++) {
      if (files[i].name === name) stillHasOurFile = true;
    }
  }
  const verifyOk = sel ? deepQuery(document, sel).length > 0 : false;
  return { total, stillHasOurFile, verifyOk };
}

/**
 * Walk a CDP DOM tree (from DOM.getDocument({pierce: true})) and return the
 * backendNodeId of the first node carrying `attrName="true"`. Pierces shadow
 * roots and same-origin iframes via the CDP-side `shadowRoots` and
 * `contentDocument` fields.
 *
 * Used by set_file_input to locate the content-script-tagged file input from
 * the background worker. The legacy path used Runtime.evaluate + document
 * .querySelector, which is MAIN-world and can't see shadow-rooted elements.
 */
export interface CDPNode {
  backendNodeId: number;
  attributes?: string[];
  children?: CDPNode[];
  shadowRoots?: CDPNode[];
  contentDocument?: CDPNode;
}

export async function findShadowMarkedBackendNodeId(tabId: number, attrName: string): Promise<number | null> {
  const dbg = chrome.debugger as unknown as {
    sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
  };
  const docResult = await dbg.sendCommand({ tabId }, "DOM.getDocument", { pierce: true, depth: -1 }) as { root: CDPNode };
  return walkForMarker(docResult.root, attrName);
}

export function walkForMarker(node: CDPNode, attrName: string): number | null {
  if (node.attributes) {
    for (let i = 0; i < node.attributes.length - 1; i += 2) {
      if (node.attributes[i] === attrName && node.attributes[i + 1] === "true") {
        return node.backendNodeId;
      }
    }
  }
  for (const child of node.children ?? []) {
    const found = walkForMarker(child, attrName);
    if (found) return found;
  }
  for (const sr of node.shadowRoots ?? []) {
    const found = walkForMarker(sr, attrName);
    if (found) return found;
  }
  if (node.contentDocument) {
    const found = walkForMarker(node.contentDocument, attrName);
    if (found) return found;
  }
  return null;
}
