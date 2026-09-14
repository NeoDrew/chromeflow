// Miscellaneous CDP / scripting helpers that don't fit the click / probe /
// dialog / dom-node clusters: page instrumentation injection, the phase-race
// timeout, the React control-state commit, and the file-input pierce snapshots.

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
            input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
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

export function pierceFilePoll(name: string, sel: string): { total: number; stillHasOurFile: boolean; verifyOk: boolean; filenameVisible: boolean; rejectionSignal: string | null } {
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
  // Shadow-piercing text search. A file upload widget that genuinely accepted
  // the file almost always surfaces the filename somewhere (a chip, a
  // thumbnail caption, a "1 file selected" line) even after it clears the
  // native <input> to hold the File in its own state instead (a common,
  // legitimate pattern). If the filename never shows up ANYWHERE after the
  // input was cleared, that's a much stronger "silently rejected" signal than
  // total-file-count alone — this is what closes the false-positive gap seen
  // on react-dropzone-style widgets (see
  // ISSUE-2026-08-15-antibot-tenant-walls.md, Class B: input cleared 0->0,
  // page kept showing "Upload your resume cannot be left blank", but the old
  // heuristic here reported success anyway). Deliberately just a text-presence
  // check, not a react-dropzone/Phenom-specific class-name check, so it
  // generalizes to any framework with the same read-then-discard behavior.
  function deepContainsText(root: ParentNode, needle: string): boolean {
    if ((root.textContent ?? "").includes(needle)) return true;
    for (const el of Array.from(root.querySelectorAll("*"))) {
      const sr = getShadowRoot(el);
      if (sr && deepContainsText(sr, needle)) return true;
    }
    return false;
  }
  // A file-count increase alone isn't proof the page actually accepted the
  // upload: some ATS widgets (Phenom, confirmed live 2026-09-14 on
  // careers.qbe.com) accept the file immediately (count goes up and stays
  // up) then reject it moments later via async validation, rendering a
  // visible error near the input — a structurally different failure shape
  // than the "accepted then cleared" signature filenameVisible/
  // stillHasOurFile already catches. role="alert" and aria-live are the
  // ARIA convention for exactly this kind of time-sensitive announcement,
  // so check those structurally rather than matching any vendor's specific
  // wording ("Unable to upload the resume" is Phenom's text, "The file
  // could not be uploaded" is Personio's — matching either literally
  // wouldn't generalize). Only counts a non-empty, visible one, so a
  // pre-existing empty live region (common — many frameworks render one by
  // default, ready to be filled later) doesn't false-positive.
  function findRejectionSignal(root: ParentNode): string | null {
    for (const el of deepQuery<HTMLElement>(root, '[role="alert"], [aria-live="polite"], [aria-live="assertive"]')) {
      const text = (el.textContent ?? "").trim();
      if (!text) continue;
      try {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") continue;
      } catch { /* detached or otherwise unreadable — skip */ }
      return text.slice(0, 200);
    }
    return null;
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
  const filenameVisible = name ? deepContainsText(document, name) : false;
  const rejectionSignal = findRejectionSignal(document);
  return { total, stillHasOurFile, verifyOk, filenameVisible, rejectionSignal };
}
