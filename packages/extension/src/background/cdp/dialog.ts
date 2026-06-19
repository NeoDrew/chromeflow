// Dialog / submit-signal classification helpers used by click_element.

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
