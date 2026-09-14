// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, forwardToContentScript } from "../state";
import { withDebugger } from "../cdp";

// US-QWERTY physical-key lookup for printable characters. Chromium only
// derives KeyboardEvent.code/keyCode from what the CDP caller supplies
// ("code"/"windowsVirtualKeyCode"/"nativeVirtualKeyCode" in
// content/browser/devtools/protocol/input_handler.cc); a keydown that omits
// them is a combination no physical keystroke can ever produce (correct
// ".key", empty ".code", zero ".keyCode"/".which"). This table is
// deliberately US-layout-only, not layout-exhaustive for every locale -
// that's an accepted, documented trade-off: it's strictly better than never
// sending code/keyCode at all, which was a 100%-reproducible mismatch on
// literally every character.
const PUNCT_KEY_MAP: Record<string, { code: string; keyCode: number; shift: boolean }> = {
  " ": { code: "Space", keyCode: 32, shift: false },
  "`": { code: "Backquote", keyCode: 192, shift: false },
  "~": { code: "Backquote", keyCode: 192, shift: true },
  "-": { code: "Minus", keyCode: 189, shift: false },
  "_": { code: "Minus", keyCode: 189, shift: true },
  "=": { code: "Equal", keyCode: 187, shift: false },
  "+": { code: "Equal", keyCode: 187, shift: true },
  "[": { code: "BracketLeft", keyCode: 219, shift: false },
  "{": { code: "BracketLeft", keyCode: 219, shift: true },
  "]": { code: "BracketRight", keyCode: 221, shift: false },
  "}": { code: "BracketRight", keyCode: 221, shift: true },
  "\\": { code: "Backslash", keyCode: 220, shift: false },
  "|": { code: "Backslash", keyCode: 220, shift: true },
  ";": { code: "Semicolon", keyCode: 186, shift: false },
  ":": { code: "Semicolon", keyCode: 186, shift: true },
  "'": { code: "Quote", keyCode: 222, shift: false },
  "\"": { code: "Quote", keyCode: 222, shift: true },
  ",": { code: "Comma", keyCode: 188, shift: false },
  "<": { code: "Comma", keyCode: 188, shift: true },
  ".": { code: "Period", keyCode: 190, shift: false },
  ">": { code: "Period", keyCode: 190, shift: true },
  "/": { code: "Slash", keyCode: 191, shift: false },
  "?": { code: "Slash", keyCode: 191, shift: true },
};
const DIGIT_SHIFTED: Record<string, string> = { "0": ")", "1": "!", "2": "@", "3": "#", "4": "$", "5": "%", "6": "^", "7": "&", "8": "*", "9": "(" };

// Returns the physical US-layout key that would produce `char`, or null when
// no single key on a US keyboard can (accented Latin, CJK, emoji, most
// symbols on non-US layouts, etc). Callers fall back to Input.insertText for
// the null case - CDP's own documented mechanism for "text that doesn't come
// from a key press, e.g. an IME or emoji keyboard".
function keyInfoFor(char: string): { code: string; keyCode: number; shift: boolean } | null {
  if (PUNCT_KEY_MAP[char]) return PUNCT_KEY_MAP[char];
  if (/^[a-z]$/.test(char)) return { code: `Key${char.toUpperCase()}`, keyCode: char.toUpperCase().charCodeAt(0), shift: false };
  if (/^[A-Z]$/.test(char)) return { code: `Key${char}`, keyCode: char.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(char)) return { code: `Digit${char}`, keyCode: 48 + Number(char), shift: false };
  for (const [digit, sym] of Object.entries(DIGIT_SHIFTED)) {
    if (char === sym) return { code: `Digit${digit}`, keyCode: 48 + Number(digit), shift: true };
  }
  return null; // not reachable via a single US-layout physical key
}

// Adjacency table for a plausible "fat-finger" wrong key, used only for the
// transient typo-then-correct simulation below. Partial coverage is fine -
// typoFor() just skips the simulation for characters it doesn't cover.
const QWERTY_NEIGHBORS: Record<string, string> = { q: "w", w: "q", e: "w", r: "e", t: "r", y: "t", u: "y", i: "u", o: "i", p: "o", a: "s", s: "a", d: "s", f: "d", g: "f", h: "g", j: "h", k: "j", l: "k", z: "x", x: "z", c: "x", v: "c", b: "v", n: "b", m: "n" };

// Plausible wrong character for a single a-z/A-Z real character, preserving
// case, or null when not covered / not a letter (digits and punctuation
// never get the typo treatment - the adjacency table only models letter keys).
function typoFor(char: string): string | null {
  if (!/^[a-zA-Z]$/.test(char)) return null;
  const neighbor = QWERTY_NEIGHBORS[char.toLowerCase()];
  if (!neighbor) return null;
  return char === char.toLowerCase() ? neighbor : neighbor.toUpperCase();
}

// Shared keyDown+keyUp dispatch for one physical key, used for real
// characters, transient typo characters, and the typo-correcting Backspace.
// `text` is omitted for Backspace, which real keyboards never pair with a
// text-insertion payload.
async function dispatchKeyPair(
  tabId: number,
  key: string,
  info: { code: string; keyCode: number; shift: boolean } | null,
  text?: string,
): Promise<void> {
  const modifiers = info?.shift ? 8 : 0;
  const codeFields = info
    ? { code: info.code, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode }
    : {};
  const downPayload: Record<string, unknown> = { type: "keyDown", key, modifiers, ...codeFields };
  if (text !== undefined) {
    downPayload.text = text;
    downPayload.unmodifiedText = text;
  }
  await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", downPayload);
  await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", { type: "keyUp", key, modifiers, ...codeFields });
}

/**
 * fill_input (textHint mode) has no dedicated background handler by default
 * — an unrecognised message type just forwards to the content script and
 * returns its result verbatim. Workday-style fields (see
 * ISSUE-2026-08-11-workday-fill-input-not-binding.md) need an exception: the
 * content script (content/fill.ts) can detect that a field needs trusted
 * keystrokes but has no chrome.debugger access to dispatch them itself, so
 * it signals needsTrustedKeystrokes + a resolvedSelector back here instead of
 * doing the fill, and this handler completes it by delegating to
 * handleTypeText — reusing its existing landing-verification and fallback
 * logic rather than re-implementing keystroke dispatch a second time.
 */
export async function handleFillInput(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      const result = await forwardToContentScript(tab, msg) as {
        success: boolean;
        message: string;
        matched?: string;
        needsTrustedKeystrokes?: boolean;
        resolvedSelector?: string;
      };
      if (!result.needsTrustedKeystrokes || !result.resolvedSelector) {
        return result;
      }
      const retyped = await handleTypeText(
        { ...msg, text: msg.value as string, into_selector: result.resolvedSelector, clear_first: true },
        port,
      ) as { success: boolean; landed?: boolean; message: string };
      return {
        ...result,
        success: retyped.success,
        landed: retyped.landed,
        message: `${result.message} Escalated to trusted keystrokes: ${retyped.message}`,
      };
}

/**
 * fill_form has no dedicated background handler by default either — same
 * gap as fill_input, one level up: each per-field result from the content
 * script's opFillForm can carry needsTrustedKeystrokes/resolvedSelector (see
 * that file), but only a background handler can act on it, since
 * chrome.debugger isn't reachable from the content script. Escalates each
 * flagged field in turn via handleTypeText, same mechanism as
 * handleFillInput above, just looped per field.
 */
export async function handleFillForm(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      const result = await forwardToContentScript(tab, msg) as {
        results: Array<{
          label: string;
          success: boolean;
          message: string;
          matched?: string;
          needsTrustedKeystrokes?: boolean;
          resolvedSelector?: string;
          value?: string;
        }>;
        [key: string]: unknown;
      };
      let succeeded = 0;
      for (const field of result.results) {
        if (field.needsTrustedKeystrokes && field.resolvedSelector) {
          const retyped = await handleTypeText(
            { ...msg, text: field.value ?? "", into_selector: field.resolvedSelector, clear_first: true },
            port,
          ) as { success: boolean; landed?: boolean; message: string };
          field.success = retyped.success;
          field.message = `${field.message} Escalated to trusted keystrokes: ${retyped.message}`;
        }
        if (field.success) succeeded++;
      }
      return { ...result, succeeded };
}

export async function handleTypeText(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      const text = msg.text as string;
      const frameSelector = msg.frame as string | undefined;
      const intoSelector = msg.into_selector as string | undefined;
      const clearFirst = msg.clear_first === true;

      // If `into_selector` is given, focus that element FIRST. Resolves via
      // shadow-piercing query so contenteditables inside Radix portals or
      // other closed shadow roots are reachable. clear_first does
      // selectAll+delete before typing — useful for replacing existing text
      // in a tiptap / ProseMirror editor in one call rather than the old
      // wait_for_click → execCommand → type_text pattern.
      let intoSelectorOk: boolean | null = null;
      // The canonical, single, stable selector for the element we ACTUALLY
      // focused — surfaced so flow memory caches a precise locator instead of
      // the agent's loose (possibly multi-option / ambiguous) query. Generic:
      // no site-specific logic, just attribute preference + visibility.
      let resolvedSelector: string | null = null;
      if (intoSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector: string, clearFirst: boolean) => {
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
              function queryAllDeep(root: ParentNode, sel: string, out: Element[]): Element[] {
                for (const m of Array.from(root.querySelectorAll<Element>(sel))) out.push(m);
                for (const el of Array.from(root.querySelectorAll<Element>("*"))) {
                  const sr = getShadowRoot(el);
                  if (sr) queryAllDeep(sr, sel, out);
                }
                return out;
              }
              // A selector can match several elements (e.g. a hidden duplicate
              // search box + the visible one). Pick the VISIBLE, editable,
              // enabled match so typing lands on the real field — the generic
              // cause of "recalled selector focuses the wrong/hidden node".
              function isVisibleEditable(el: Element): boolean {
                if (!(el instanceof HTMLElement)) return false;
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) return false;
                const cs = getComputedStyle(el);
                if (cs.visibility === "hidden" || cs.display === "none") return false;
                const editable = el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
                const disabled = (el as HTMLInputElement).disabled === true ||
                  el.getAttribute("aria-disabled") === "true" ||
                  (el as HTMLInputElement).readOnly === true;
                return editable && !disabled;
              }
              // Canonical, stable, single selector for the resolved element —
              // attribute preference (id/name/aria/placeholder/testid), skipping
              // ids that look auto-generated. Returns null when no stable anchor.
              function canonical(el: HTMLElement): string | null {
                const tag = el.tagName.toLowerCase();
                const looksHashed = (s: string) => s.length > 12 && /\d/.test(s) && /[a-z]/i.test(s) && !/[\s_-]/.test(s);
                const id = el.getAttribute("id");
                if (id && !looksHashed(id)) { try { return `#${CSS.escape(id)}`; } catch { return `#${id}`; } }
                const name = el.getAttribute("name"); if (name) return `${tag}[name="${name}"]`;
                const aria = el.getAttribute("aria-label"); if (aria) return `${tag}[aria-label="${aria.replace(/"/g, '\\"')}"]`;
                const ph = el.getAttribute("placeholder"); if (ph) return `${tag}[placeholder="${ph.replace(/"/g, '\\"')}"]`;
                const tid = el.getAttribute("data-testid"); if (tid) return `[data-testid="${tid}"]`;
                return null;
              }
              const all = queryAllDeep(document, selector, []);
              if (all.length === 0) return { status: "not-found" };
              const target = (all.find(isVisibleEditable) ?? all.find((e) => e instanceof HTMLElement) ?? all[0]) as HTMLElement;
              if (!(target instanceof HTMLElement)) return { status: "not-html" };
              const rect = target.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) {
                target.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
              }
              target.focus();
              // Tag the target so the MAIN-world clear step can find the
              // same element. Page-script expandos like __lexicalEditor are
              // ONLY visible in MAIN world; ISOLATED can't reach them.
              if (clearFirst) {
                target.setAttribute("data-chromeflow-clear-target", "1");
                // Native input/textarea clear: works in ISOLATED.
                if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                  target.value = "";
                  target.dispatchEvent(new Event("input", { bubbles: true }));
                  target.dispatchEvent(new Event("change", { bubbles: true }));
                  target.removeAttribute("data-chromeflow-clear-target");
                }
              }
              return { status: "ok", resolved: canonical(target) };
            },
            args: [intoSelector, clearFirst],
          });
          const res = r[0]?.result as { status?: string; resolved?: string | null } | undefined;
          intoSelectorOk = res?.status === "ok";
          if (res?.resolved) resolvedSelector = res.resolved;
          if (!intoSelectorOk) {
            return {
              type: "action_done",
              requestId: msg.requestId,
              success: false,
              message: `into_selector "${intoSelector}" did not resolve to a focusable element (${res?.status ?? "unknown"}). Either the selector is wrong, the element is detached, or it lives in a cross-origin iframe.`,
            };
          }
          // Second pass: clear Lexical / ProseMirror / TipTap state in MAIN world.
          // Page-script expandos like __lexicalEditor are only visible from
          // MAIN world; the ISOLATED-world pass above can't reach them.
          if (clearFirst) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId },
                world: "MAIN",
                func: () => {
                  const target = document.querySelector<HTMLElement>('[data-chromeflow-clear-target]');
                  if (!target) return;
                  // Lexical
                  const lexicalKey = Object.keys(target).find((k) => k.startsWith("__lexicalEditor"));
                  if (lexicalKey) {
                    try {
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      const editor = (target as any)[lexicalKey];
                      const blank = editor.parseEditorState('{"root":{"children":[{"children":[],"direction":null,"format":"","indent":0,"type":"paragraph","version":1}],"direction":null,"format":"","indent":0,"type":"root","version":1}}');
                      editor.setEditorState(blank);
                      target.removeAttribute("data-chromeflow-clear-target");
                      return;
                    } catch { /* fall through */ }
                  }
                  // TipTap on closest [data-tiptap-editor] / .tiptap / .ProseMirror
                  const tiptapHost = target.closest("[data-tiptap-editor], .tiptap, .ProseMirror") as HTMLElement | null;
                  if (tiptapHost) {
                    const tiptapKey = Object.keys(tiptapHost).find((k) => k.startsWith("__tiptapEditor"));
                    if (tiptapKey) {
                      try {
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        const editor = (tiptapHost as any)[tiptapKey];
                        if (editor?.commands?.clearContent) {
                          editor.commands.clearContent();
                          target.removeAttribute("data-chromeflow-clear-target");
                          return;
                        }
                      } catch { /* fall through */ }
                    }
                  }
                  // ProseMirror via pmViewDesc
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const pmView = (target as any).pmViewDesc?.spec?.editor;
                  if (pmView?.state && pmView?.dispatch) {
                    try {
                      const tr = pmView.state.tr;
                      const size = pmView.state.doc.content.size;
                      pmView.dispatch(tr.delete(0, size));
                      target.removeAttribute("data-chromeflow-clear-target");
                      return;
                    } catch { /* fall through */ }
                  }
                  // Plain contenteditable: select all + delete
                  try { document.execCommand("selectAll"); } catch { /* ignore */ }
                  try { document.execCommand("delete"); } catch { /* ignore */ }
                  target.removeAttribute("data-chromeflow-clear-target");
                },
              });
            } catch { /* best-effort; typing will still happen */ }
          }
        } catch (e) {
          return {
            type: "action_done",
            requestId: msg.requestId,
            success: false,
            message: `Error focusing into_selector "${intoSelector}": ${(e as Error).message}`,
          };
        }
      }

      // If `frame` is given, focus a contenteditable/input inside that iframe
      // BEFORE the CDP keys fire. eBay's "se-rte" description editor is an
      // iframe containing a contenteditable; without focus inside the iframe,
      // the CDP keys land on the outer document and are silently dropped.
      // Only works for same-origin iframes (contentDocument access requires it).
      let frameFocusOk: boolean | null = null;
      if (frameSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (sel: string) => {
              const iframe = document.querySelector(sel);
              if (!(iframe instanceof HTMLIFrameElement)) return "no-iframe";
              let doc: Document | null = null;
              try { doc = iframe.contentDocument; } catch { doc = null; }
              if (!doc) return "cross-origin";
              const editable = doc.querySelector<HTMLElement>(
                '[contenteditable="true"], [contenteditable=""], textarea, input:not([type=hidden])'
              );
              if (!editable) return "no-editable-in-frame";
              editable.focus();
              // Place caret at the end so typing appends rather than overwriting selection
              if (editable.isContentEditable) {
                const sel = doc.getSelection();
                const range = doc.createRange();
                range.selectNodeContents(editable);
                range.collapse(false);
                sel?.removeAllRanges();
                sel?.addRange(range);
              } else if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) {
                const len = editable.value.length;
                editable.setSelectionRange(len, len);
              }
              return "ok";
            },
            args: [frameSelector],
          });
          frameFocusOk = r[0]?.result === "ok";
          if (!frameFocusOk) {
            return {
              type: "action_done",
              requestId: msg.requestId,
              success: false,
              message: `Could not focus an editable element inside iframe "${frameSelector}" (${r[0]?.result ?? "unknown"}). The iframe may be cross-origin or empty.`,
            };
          }
        } catch (e) {
          return {
            type: "action_done",
            requestId: msg.requestId,
            success: false,
            message: `Error focusing iframe "${frameSelector}": ${(e as Error).message}`,
          };
        }
      }

      // Type character-by-character with individual keyDown/keyUp events
      // and randomized delays to produce input indistinguishable from real typing.
      // For long typings, emit a progress heartbeat every 200 chars so the WS
      // request timer resets and we don't trip the timeout while still typing.
      await withDebugger(tabId, async () => {
        const PROGRESS_INTERVAL = 200;
        // Iterate by Unicode CODE POINT, not UTF-16 code unit: a plain
        // `for (let i = 0; i < text.length; i++)` walks code units, so any
        // astral-plane character (most emoji, code point > U+FFFF) gets
        // split into two iterations, each dispatching a lone, unpaired
        // surrogate half as ".key" - impossible for any real input source to
        // produce standalone. `for...of` over a string yields whole code
        // points, handling surrogate pairs as one unit. `i` is tracked
        // separately (not derived from the iteration) so the existing
        // progress-heartbeat cadence is unchanged.
        let i = 0;
        for (const char of text) {
          if (char === "\n") {
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
            });
          } else if (char === "\t") {
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
            });
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
            });
          } else {
            const info = keyInfoFor(char);
            if (info === null) {
              // No single US-layout physical key produces this character
              // (accented Latin, CJK, emoji, most non-US symbols). Dispatch
              // via Input.insertText instead of a synthetic keyDown/keyUp -
              // CDP's own documented mechanism for "text that doesn't come
              // from a key press, e.g. an IME or emoji keyboard", which also
              // sidesteps the surrogate-splitting bug entirely since it
              // takes the whole code point as one string argument.
              await (chrome.debugger as any).sendCommand({ tabId }, "Input.insertText", { text: char });
            } else {
              // Typo-then-correct: a real typist has a measurable non-zero
              // error rate (BeCAPTCHA-Type, GeeTest bot-detection material);
              // a perfectly error-free keystroke stream across an entire
              // corpus is itself a discriminator. Skip at i===0 (no context
              // yet to "correct"). Never changes the final landed value -
              // only inserts a transient wrong keystroke, self-corrected via
              // Backspace, immediately before the real one.
              if (i > 0 && Math.random() < 0.025) {
                const typoChar = typoFor(char);
                if (typoChar) {
                  const typoInfo = keyInfoFor(typoChar);
                  await dispatchKeyPair(tabId, typoChar, typoInfo, typoChar);
                  await new Promise((r) => setTimeout(r, 40 + Math.random() * 60));
                  await dispatchKeyPair(tabId, "Backspace", { code: "Backspace", keyCode: 8, shift: false });
                  await new Promise((r) => setTimeout(r, 30 + Math.random() * 40));
                }
              }
              // A real keyboard can't emit an uppercase letter or a shifted
              // symbol without Shift actually held, so
              // KeyboardEvent.shiftKey/getModifierState must agree with what
              // the character itself implies (CDP modifiers bit 8) - and
              // code/windowsVirtualKeyCode/nativeVirtualKeyCode must be
              // populated too, or Chromium leaves event.code empty and
              // event.keyCode/which at 0 for every typed character, a
              // combination no physical keystroke can produce.
              await dispatchKeyPair(tabId, char, info, char);
            }
          }

          // Slow-pause cap tightened from 500ms to 250ms. Empirically the
          // upper tail wasn't load-bearing for behavioral-fingerprint defeat
          // and it pushed long-typing budgets past the WS timeout. Reddit /
          // X composer flows continue to accept synthetic input at the 250ms
          // cap (validated via the chromeflow anti-bot click sequence which
          // already lands isTrusted=true events).
          const baseDelay = 30 + Math.random() * 60;
          const pause = Math.random() < 0.05 ? 150 + Math.random() * 100 : baseDelay;
          await new Promise((r) => setTimeout(r, pause));

          // Heartbeat: tell the bridge we're still making forward progress so
          // the request-timeout clock resets. Without this, ~1800-char typings
          // can complete on the page but trip the WS timeout in the bridge.
          // Routed via offscreen so the heartbeat lands on the correct WS
          // connection (one per Claude Code instance).
          if ((i + 1) % PROGRESS_INTERVAL === 0) {
            try {
              chrome.runtime.sendMessage({
                source: "chromeflow-progress",
                port,
                requestId: msg.requestId,
                phase: "type_text",
                detail: `${i + 1}/${text.length} chars`,
              }).catch(() => {});
            } catch { /* best-effort */ }
          }

          i++;
        }

        // After typing, dispatch an input event on the focused element to nudge
        // React's internal state reconciliation. Without this, React-controlled
        // textareas (especially inside shadow DOM) can show the text visually but
        // report the field as empty in form validation.
        await (chrome.debugger as any).sendCommand({ tabId }, "Runtime.evaluate", {
          expression: `(function() {
            var el = document.activeElement;
            if (el && el.shadowRoot) el = el.shadowRoot.activeElement || el;
            if (el) {
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          })()`,
          returnByValue: true,
        });
      });

      // Silent-drop guard: CDP keystrokes can visually appear to land but
      // never actually reach the target — a rich-text editor's own state
      // machine can revert them (TipTap/ProseMirror), OR the CDP Input layer
      // itself can go silently dead mid-session (chrome.debugger detaches
      // without any visible symptom until the next command has no effect —
      // see ISSUE-2026-07-15-cdp-input-dead.md, where type_text kept
      // reporting "Typed N characters" on a PLAIN <input> whose value stayed
      // "" the entire time), OR an anti-bot tenant discards synthetic
      // keystrokes outright regardless of isTrusted (see
      // ISSUE-2026-08-15-antibot-tenant-walls.md: a Workday tenant's
      // input-4 field stayed "" after 25 real CDP keystrokes with no error
      // anywhere). This verification used to run ONLY when into_selector was
      // passed — but type_text's other documented mode, "type into whatever
      // is currently focused" (no into_selector; the caller clicks first,
      // then types), had NO verification at all, so the exact silent-drop
      // trap this guard exists to catch was still fully reproducible through
      // that path. We now verify post-type for the into_selector target OR,
      // absent one, the live (possibly shadow-nested) document.activeElement
      // — and, if the content is significantly shorter than what we typed,
      // recover with a non-keystroke fill appropriate to the element. This
      // works whether the CDP layer is degraded, fine, or actively fought by
      // tenant-level anti-automation, since it never depends on CDP working.
      let dropFallback = "";
      // `landed` = did the typed text actually end up in the target element
      // (after any recovery fallback)? Defaults true only for the iframe
      // target case — see frameVerify below for that. When false, the caller
      // must NOT trust this call succeeded.
      let landed = true;
      if (!frameSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector: string | null, expectedText: string) => {
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
              function queryDeep(root: ParentNode, sel: string): Element | null {
                const direct = root.querySelector(sel);
                if (direct) return direct;
                for (const el of Array.from(root.querySelectorAll<Element>("*"))) {
                  const sr = getShadowRoot(el);
                  if (sr) {
                    const found = queryDeep(sr, sel);
                    if (found) return found;
                  }
                }
                return null;
              }
              // No into_selector was given — type_text targeted "whatever is
              // currently focused". Resolve the REAL focused element the same
              // way, walking into nested shadow roots (a shadow host reports
              // itself as document.activeElement; the actually-focused node
              // is host.shadowRoot.activeElement, possibly several levels
              // deep for nested Web Components).
              function deepActiveElement(): Element | null {
                let el: Element | null = document.activeElement;
                for (;;) {
                  if (!el) return el;
                  const sr = getShadowRoot(el);
                  if (sr?.activeElement) el = sr.activeElement;
                  else return el;
                }
              }
              const target = selector ? queryDeep(document, selector) : deepActiveElement();
              if (!(target instanceof HTMLElement)) return { ok: false };
              // Walk up to detect ProseMirror / tiptap ancestor.
              const isProseMirror =
                target.classList.contains("ProseMirror") ||
                target.classList.contains("tiptap") ||
                target.closest?.(".ProseMirror, .tiptap, [data-tiptap-editor]") !== null;
              // innerText, not textContent, for contenteditable: textContent
              // concatenates every text node with NO separator for element
              // boundaries, so a correctly-landed multi-<div>-per-line body
              // (Gmail's own line-break convention) and a body whose Enter
              // keydowns were silently swallowed read as the EXACT SAME
              // string ("Hi Drew,Great news..." either way) — the drop
              // check below would be structurally blind to a newline-only
              // loss no matter the threshold. innerText applies the same
              // layout-based line-break insertion a human reads on screen,
              // so it actually reflects whether paragraph structure landed.
              const readActual = () =>
                target.isContentEditable
                  ? (target.innerText ?? "")
                  : ((target as HTMLInputElement | HTMLTextAreaElement).value ?? "");
              const actual = readActual();
              // Drop threshold: < 50% of expected content survived. Stricter
              // than "0 chars" because a rich-text editor sometimes lands a
              // partial paste before reverting; < 50% captures both full-drop
              // and partial-drop, and also catches "CDP never fired at all".
              //
              // Separately: a contenteditable target whose TEXT all landed
              // but whose line breaks did not is not caught by the length
              // check above at all (losing two `\n` characters out of 32 is
              // a ~94% survival rate) — see ISSUE-2026-09-05-type-text-
              // newlines-dropped-gmail-contenteditable.md, where CDP's Enter
              // keydown/keyup pair (dispatched below for every `\n`) landed
              // reliably on some contenteditable targets but was silently
              // swallowed by Gmail's own key handling, merging every
              // paragraph into one run-on line with ZERO visible error.
              // Compare newline COUNTS, not just overall length.
              const expectedNewlines = (expectedText.match(/\n/g) ?? []).length;
              const actualNewlines = target.isContentEditable ? (actual.match(/\n/g) ?? []).length : expectedNewlines;
              const newlinesDropped = target.isContentEditable && expectedNewlines > 0 && actualNewlines < expectedNewlines * 0.5;
              const dropped = actual.length < expectedText.length * 0.5 || newlinesDropped;
              if (!dropped) {
                return { ok: true, fallback: "none" as const, isProseMirror, actualLength: actual.length, expectedLength: expectedText.length };
              }
              target.focus();
              let fallback: "prosemirror" | "native-setter" | "execcommand";
              if (isProseMirror) {
                // execCommand is what TipTap/ProseMirror's own input handler
                // listens for; a native value-setter write bypasses its state
                // machine entirely and the editor would just revert it too.
                fallback = "prosemirror";
                try { document.execCommand("selectAll"); } catch { /* ignore */ }
                try { document.execCommand("delete"); } catch { /* ignore */ }
                try { document.execCommand("insertText", false, expectedText); } catch { /* ignore */ }
              } else if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
                // Native value-setter write, same pattern as fill_input's
                // React-aware path (content/fill.ts) — bypasses whatever
                // dropped the synthetic keystrokes and still fires React's
                // onChange via the prototype setter + dispatched events.
                fallback = "native-setter";
                const proto = Object.getPrototypeOf(target);
                const setter =
                  Object.getOwnPropertyDescriptor(proto, "value")?.set ??
                  Object.getOwnPropertyDescriptor(
                    target instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
                    "value",
                  )?.set;
                if (setter) setter.call(target, expectedText);
                else (target as HTMLInputElement).value = expectedText;
                target.dispatchEvent(new Event("input", { bubbles: true }));
                target.dispatchEvent(new Event("change", { bubbles: true }));
              } else {
                // Generic contenteditable that isn't a recognised rich-text
                // editor: execCommand insertText is the closest thing to a
                // "type this text" primitive available outside CDP.
                fallback = "execcommand";
                try { document.execCommand("selectAll"); } catch { /* ignore */ }
                try { document.execCommand("delete"); } catch { /* ignore */ }
                try { document.execCommand("insertText", false, expectedText); } catch { /* ignore */ }
              }
              const finalText = readActual();
              return {
                ok: true,
                fallback,
                isProseMirror,
                newlinesDropped,
                actualLength: actual.length,
                expectedLength: expectedText.length,
                finalLength: finalText.length,
              };
            },
            args: [intoSelector ?? null, text],
          });
          const v = r[0]?.result as
            | { ok: false }
            | { ok: true; fallback: "none" | "prosemirror" | "native-setter" | "execcommand"; isProseMirror: boolean; newlinesDropped: boolean; actualLength: number; expectedLength: number; finalLength?: number }
            | undefined;
          if (v && v.ok) {
            const got = v.fallback === "none" ? v.actualLength : (v.finalLength ?? 0);
            landed = got >= v.expectedLength * 0.5;
            if (v.fallback !== "none") {
              const recoveredVia = v.fallback === "prosemirror" ? "execCommand insertText (TipTap/ProseMirror)"
                : v.fallback === "native-setter" ? "the native value setter" : "execCommand insertText";
              const whatDropped = v.newlinesDropped
                ? `text landed but line breaks were silently swallowed (a contenteditable's own key handling can eat a synthetic Enter keydown even though other keystrokes land fine — see ISSUE-2026-09-05-type-text-newlines-dropped-gmail-contenteditable.md)`
                : `CDP keystrokes did not land (${v.actualLength}/${v.expectedLength} chars survived)`;
              dropFallback = landed
                ? ` — ${whatDropped}, recovered via ${recoveredVia} (${v.finalLength ?? "?"} chars now in the field)`
                : ` — ${whatDropped} and recovery via ${recoveredVia} ALSO failed (${v.finalLength ?? "?"} chars now in the field)`;
            }
          } else if (v && v.ok === false) {
            landed = false; // verification couldn't find the target — text did not land where expected
          }
        } catch { /* best-effort */ }
      }

      // If we were typing into an iframe, also dispatch input/change on the
      // iframe's focused element (CDP's Runtime.evaluate above runs in the
      // top-level frame's execution context, so events dispatched there don't
      // reach the iframe's React tree), AND fold this into `landed` — this
      // path previously skipped verification entirely, which meant the exact
      // silent-drop trap (see ISSUE-2026-07-15-cdp-input-dead.md) was still
      // fully reproducible for iframe-targeted typing even with the
      // into_selector path fixed above. No recovery fallback is attempted
      // here (unlike into_selector) — just detection, so the caller at least
      // finds out rather than trusting a false "Typed N characters".
      let frameVerify = "";
      if (frameSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (sel: string) => {
              const iframe = document.querySelector(sel);
              if (!(iframe instanceof HTMLIFrameElement)) return { ok: false };
              let doc: Document | null = null;
              try { doc = iframe.contentDocument; } catch { doc = null; }
              if (!doc) return { ok: false };
              const active = doc.activeElement;
              if (!(active instanceof HTMLElement)) return { ok: false };
              active.dispatchEvent(new Event("input", { bubbles: true }));
              active.dispatchEvent(new Event("change", { bubbles: true }));
              const txt = active.isContentEditable
                ? (active.textContent ?? "")
                : (active as HTMLInputElement).value ?? "";
              return { ok: true, length: txt.length };
            },
            args: [frameSelector],
          });
          const v = r[0]?.result as { ok: boolean; length?: number } | undefined;
          if (v?.ok && typeof v.length === "number") {
            landed = v.length >= text.length * 0.5;
            frameVerify = `[frame editor now has ${v.length} chars]`;
          }
          // v.ok === false (cross-origin iframe, or no active element inside
          // it): genuinely can't verify — leave `landed` at its current
          // value rather than guessing either way.
        } catch { /* best-effort verification */ }
      }

      return {
        type: "action_done",
        requestId: msg.requestId,
        // `landed` false means the text verifiably did NOT end up in the
        // field (even after the drop-recovery fallback above) — this must
        // surface as success:false, not just a buried field, or a caller
        // that only checks `success` sees exactly the silent-failure trap
        // from ISSUE-2026-07-15-cdp-input-dead.md: "Typed N characters" with
        // an empty field underneath it.
        success: landed,
        landed,
        resolved_selector: resolvedSelector,
        message: `${landed ? "Typed" : "Attempted to type"} ${text.length} characters via individual keystrokes${frameSelector ? ` into iframe "${frameSelector}"${frameVerify ? " " + frameVerify : ""}` : ""}${dropFallback}${landed ? "" : " — the text did NOT land in the target field; do not trust this as a successful fill, verify with execute_script or retry"}`,
      };
}
