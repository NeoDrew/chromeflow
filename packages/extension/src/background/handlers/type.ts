// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab } from "../state";
import { withDebugger } from "../cdp";

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
        for (let i = 0; i < text.length; i++) {
          const char = text[i];

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
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyDown", key: char, text: char, unmodifiedText: char,
            });
            await (chrome.debugger as any).sendCommand({ tabId }, "Input.dispatchKeyEvent", {
              type: "keyUp", key: char,
            });
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

      // TipTap / ProseMirror silent-drop guard: CDP keystrokes land visually
      // but tiptap's internal state machine doesn't see them as valid input,
      // so a few hundred ms later the editor reverts to placeholder. We
      // verify post-type for any into_selector target and, when the editor's
      // text content is significantly shorter than what we typed AND the
      // target is inside a recognised rich-text editor, fall back to
      // execCommand('insertText') which tiptap DOES accept.
      let tiptapFallback = "";
      // `landed` = did the typed text actually end up in the target element? We
      // already read the element's content for the TipTap guard; reuse it as a
      // general post-type verification so the MCP layer can treat "typed but the
      // field is still empty / reverted" (a drifted shadow-DOM selector landing
      // on the wrong node) as a failure rather than a success. Defaults true when
      // we can't verify (no into_selector, or iframe target).
      let landed = true;
      if (intoSelector && intoSelectorOk && !frameSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (selector: string, expectedText: string) => {
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
              const target = queryDeep(document, selector);
              if (!(target instanceof HTMLElement)) return { ok: false };
              // Walk up to detect ProseMirror / tiptap ancestor.
              const isProseMirror =
                target.classList.contains("ProseMirror") ||
                target.classList.contains("tiptap") ||
                target.closest?.(".ProseMirror, .tiptap, [data-tiptap-editor]") !== null;
              const actual = target.isContentEditable
                ? (target.textContent ?? "")
                : ((target as HTMLInputElement | HTMLTextAreaElement).value ?? "");
              // Drop threshold: editor has < 50% of expected content. Stricter
              // than "0 chars" because tiptap sometimes lands a partial paste
              // before reverting; < 50% captures both full-drop and partial-drop.
              const dropped = actual.length < expectedText.length * 0.5;
              if (!isProseMirror || !dropped) {
                return { ok: true, fallback: false, isProseMirror, actualLength: actual.length, expectedLength: expectedText.length };
              }
              // Fallback: focus, select-all, replace via insertText.
              target.focus();
              try { document.execCommand("selectAll"); } catch { /* ignore */ }
              try { document.execCommand("delete"); } catch { /* ignore */ }
              try { document.execCommand("insertText", false, expectedText); } catch { /* ignore */ }
              target.dispatchEvent(new Event("input", { bubbles: true }));
              target.dispatchEvent(new Event("change", { bubbles: true }));
              const finalText = target.textContent ?? "";
              return {
                ok: true,
                fallback: true,
                isProseMirror: true,
                actualLength: actual.length,
                expectedLength: expectedText.length,
                finalLength: finalText.length,
              };
            },
            args: [intoSelector, text],
          });
          const v = r[0]?.result as
            | { ok: false }
            | { ok: true; fallback: boolean; isProseMirror: boolean; actualLength: number; expectedLength: number; finalLength?: number }
            | undefined;
          if (v && v.ok) {
            const got = v.fallback ? (v.finalLength ?? 0) : v.actualLength;
            landed = got >= v.expectedLength * 0.5;
            if (v.fallback) {
              tiptapFallback =
                ` — TipTap/ProseMirror silently dropped the typed text (${v.actualLength}/${v.expectedLength} chars survived), recovered via execCommand insertText (${v.finalLength ?? "?"} chars now in editor)`;
            }
          } else if (v && v.ok === false) {
            landed = false; // verification couldn't find the target — text did not land where expected
          }
        } catch { /* best-effort */ }
      }

      // If we were typing into an iframe, also dispatch input/change on the
      // iframe's focused element. CDP's Runtime.evaluate above runs in the
      // top-level frame's execution context, so events dispatched there don't
      // reach the iframe's React tree.
      let frameVerify = "";
      if (frameSelector) {
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            world: "MAIN",
            func: (sel: string) => {
              const iframe = document.querySelector(sel);
              if (!(iframe instanceof HTMLIFrameElement)) return "";
              let doc: Document | null = null;
              try { doc = iframe.contentDocument; } catch { doc = null; }
              if (!doc) return "";
              const active = doc.activeElement;
              if (active instanceof HTMLElement) {
                active.dispatchEvent(new Event("input", { bubbles: true }));
                active.dispatchEvent(new Event("change", { bubbles: true }));
                const txt = active.isContentEditable
                  ? (active.textContent ?? "")
                  : (active as HTMLInputElement).value ?? "";
                return `[frame editor now has ${txt.length} chars]`;
              }
              return "";
            },
            args: [frameSelector],
          });
          frameVerify = (r[0]?.result as string) ?? "";
        } catch { /* best-effort verification */ }
      }

      return {
        type: "action_done",
        requestId: msg.requestId,
        success: true,
        landed,
        resolved_selector: resolvedSelector,
        message: `Typed ${text.length} characters via individual keystrokes${frameSelector ? ` into iframe "${frameSelector}"${frameVerify ? " " + frameVerify : ""}` : ""}${tiptapFallback}`,
      };
}
