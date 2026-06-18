// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, getWindowId } from "../state";
import { withDebugger } from "../cdp";
import { isScriptableUrl } from "../policy";

export async function handleExecuteScript(msg: McpMsg, port: number): Promise<unknown> {
      // Resolve target tab: tab_query lets the caller target a tab without
      // focus-switching. Used by self-rescheduling loops where the active tab
      // may have drifted while the user was AFK.
      const tabQuery = msg.tab_query as string | undefined;
      let tab: chrome.tabs.Tab;
      if (tabQuery) {
        await getActiveTab(port);
        const wid = getWindowId(port)!;
        const allTabs = await chrome.tabs.query({ windowId: wid });
        const lower = tabQuery.toLowerCase();
        const byIndex = parseInt(tabQuery, 10);
        const match = !isNaN(byIndex)
          ? allTabs[byIndex - 1]
          : allTabs.find((t) => (t.url ?? "").toLowerCase().includes(lower) || (t.title ?? "").toLowerCase().includes(lower));
        if (!match?.id) {
          const list = allTabs.map((t, i) => `${i + 1}. ${t.title} — ${t.url}`).join("\n");
          throw new Error(`tab_query "${tabQuery}" matched no tab. Open tabs:\n${list}`);
        }
        tab = match;
      } else {
        tab = await getActiveTab(port);
      }
      if (!isScriptableUrl(tab.url)) {
        throw new Error(`Cannot execute script on ${tab.url}`);
      }
      const code = msg.code as string;
      let tabId = tab.id!;
      let reauthorized = false;
      const beforeUrl = tab.url ?? "";

      // Race a chrome.scripting / chrome.debugger call against a tab-navigation
      // listener. If the page navigates away mid-script, the chrome APIs can
      // hang indefinitely (sync `location.href` = ... followed by `await` is
      // the canonical case). The listener rejects with a Frame-removed-shaped
      // error so the existing catch routes it to the [navigated] response.
      const raceWithNavigation = async <T>(p: Promise<T>): Promise<T> => {
        let listener: ((id: number, info: chrome.tabs.TabChangeInfo) => void) | null = null;
        const navPromise = new Promise<never>((_, reject) => {
          listener = (id, info) => {
            if (id === tabId && info.url && info.url !== beforeUrl) {
              reject(new Error("Frame removed — page navigated during script execution"));
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
        });
        try {
          return await Promise.race([p, navPromise]);
        } finally {
          if (listener) chrome.tabs.onUpdated.removeListener(listener);
        }
      };

      // Detect top-level `await` so the script can use it directly. The
      // word-boundary check excludes false positives like `myawaitable`. With
      // await, we wrap the code in an async IIFE expression and either:
      //  - chrome.scripting path: make the injected func async, await eval'd promise
      //  - CDP path: pass awaitPromise: true to Runtime.evaluate
      const usesAwait = /\bawait\b/.test(code);

      // Try normal content-script injection first
      let result = "undefined";
      let alertMsg: string | null = null;
      let cspBlocked = false;

      // Shadow-DOM-piercing helpers ($deep, $deepAll, shadowDocument) are
      // injected into the user's script via a wrapper that declares them as
      // local variables of an IIFE. Direct eval inside the IIFE sees the
      // locals, so `$deep('button')` works without polluting window.* on
      // the page.
      //
      // Open shadow roots only — MAIN world can't reach
      // chrome.dom.openOrClosedShadowRoot. For closed roots, callers should
      // use find_text / get_page_text / click_element / fill_input which DO
      // pierce both kinds via the content-script API.
      const SHADOW_HELPERS = `
        var $deep = function(selector, root) {
          root = root || document;
          var direct = root.querySelector(selector);
          if (direct) return direct;
          var all = root.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) {
              var nested = $deep(selector, all[i].shadowRoot);
              if (nested) return nested;
            }
          }
          return null;
        };
        var $deepAll = function(selector, root) {
          root = root || document;
          var out = [];
          var seen = new WeakSet();
          var recurse = function(r) {
            var matches = r.querySelectorAll(selector);
            for (var i = 0; i < matches.length; i++) {
              if (!seen.has(matches[i])) { seen.add(matches[i]); out.push(matches[i]); }
            }
            var all = r.querySelectorAll('*');
            for (var i = 0; i < all.length; i++) {
              if (all[i].shadowRoot) recurse(all[i].shadowRoot);
            }
          };
          recurse(root);
          return out;
        };
        var shadowDocuments = (function() {
          var roots = [];
          var all = document.querySelectorAll('*');
          for (var i = 0; i < all.length; i++) {
            if (all[i].shadowRoot) roots.push(all[i].shadowRoot);
          }
          return roots;
        })();
        var shadowDocument = (function() {
          if (shadowDocuments.length === 0) return document;
          if (shadowDocuments.length === 1) return shadowDocuments[0];
          var best = shadowDocuments[0];
          var bestScore = 0;
          for (var i = 0; i < shadowDocuments.length; i++) {
            var sr = shadowDocuments[i];
            var score = sr.querySelectorAll('button, input, select, textarea, a, [role="button"], [role="radio"], [role="checkbox"], [role="link"], [contenteditable]').length;
            if (score > bestScore) { bestScore = score; best = sr; }
          }
          return bestScore > 0 ? best : shadowDocuments[0];
        })();
      `;

      const runInjection = () => chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (code: string, usesAwait: boolean, shadowHelpers: string) => {
          let result: unknown;
          // Build a single source string that declares $deep/$deepAll/
          // shadowDocument as locals of an IIFE, then runs the user code
          // inside that IIFE. Direct eval inside the IIFE picks up the
          // helpers without leaking them onto window.
          //
          // For non-await: try direct eval first (expression returns work)
          // and fall back to a wrapping function on "Illegal return".
          // For await: always wrap as async IIFE since top-level await
          // only makes sense inside an async function anyway.
          const wrap = (body: string) => `(function() { ${shadowHelpers}; return (function() { ${body} })(); })()`;
          const wrapAsync = (body: string) => `(async function() { ${shadowHelpers}; return await (async function() { ${body} })(); })()`;
          // Expression form: helpers declared in an outer IIFE, user code
          // evaluated via direct eval to allow `42` / `document.title`-style
          // returns. var declarations inside indirect eval would leak globally;
          // direct eval inside the IIFE scopes them to the IIFE.
          const wrapExpr = `(function() { ${shadowHelpers}; return eval(${JSON.stringify(code)}); })()`;
          try {
            if (usesAwait) {
              result = await (0, eval)(wrapAsync(code));
            } else {
              result = (0, eval)(wrapExpr);
            }
          } catch (e) {
            if (String(e).includes("Illegal return")) {
              try {
                if (usesAwait) {
                  result = await (0, eval)(wrapAsync(code));
                } else {
                  result = (0, eval)(wrap(code));
                }
              } catch (e2) {
                result = `Error: ${e2}`;
              }
            } else {
              result = `Error: ${e}`;
            }
          }
          // Auto-stringify objects so callers don't have to wrap every return
          // in JSON.stringify themselves. Strings, numbers, booleans, null,
          // undefined all pass through String(). Arrays and objects become
          // JSON; circular refs fall back to String() (which yields
          // "[object Object]" but that's the documented behavior for circular
          // structures the caller would have hit anyway).
          let serialized: string;
          if (result === null || result === undefined) {
            serialized = "undefined";
          } else if (typeof result === "object") {
            try {
              serialized = JSON.stringify(result);
            } catch {
              serialized = String(result);
            }
          } else {
            serialized = String(result);
          }
          const captured = (window as any)._alertCapture ?? null;
          if (captured) (window as any)._alertCapture = null;
          return JSON.stringify({ result: serialized, alert: captured });
        },
        args: [code, usesAwait, SHADOW_HELPERS],
      });

      try {
        let results;
        try {
          results = await raceWithNavigation(runInjection());
        } catch (e) {
          const errStr = String(e);
          if (errStr.includes("Cannot access contents of the page") || errStr.includes("Extension manifest must request permission")) {
            // Idle tab lost host access (Chrome silently revokes after long
            // periods, navigation between origin variants, etc). Reload the
            // tab once to re-attach the content script, then retry.
            await new Promise<void>((resolve) => {
              const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
                if (id === tabId && info.status === "complete") {
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
              chrome.tabs.reload(tabId).catch(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              });
              setTimeout(() => {
                chrome.tabs.onUpdated.removeListener(listener);
                resolve();
              }, 15_000);
            });
            reauthorized = true;
            results = await raceWithNavigation(runInjection());
          } else {
            throw e;
          }
        }
        try {
          const parsed = JSON.parse(String(results[0]?.result ?? "{}"));
          result = parsed.result ?? "undefined";
          alertMsg = parsed.alert ?? null;
        } catch {
          result = String(results[0]?.result ?? "undefined");
        }
        // Check if the result indicates CSP blocked eval
        if (result.includes("EvalError") || result.includes("Content Security Policy") || result.includes("unsafe-eval")) {
          cspBlocked = true;
        }
      } catch (e) {
        const errStr = String(e);
        if (errStr.includes("EvalError") || errStr.includes("Content Security Policy") || errStr.includes("unsafe-eval")) {
          cspBlocked = true;
        } else if (
          /Frame with ID \d+ was removed/i.test(errStr)
          || errStr.includes("No frame with id")
          || errStr.includes("page navigated during script execution")
        ) {
          // Page navigated during script execution. The script's effects may
          // or may not have completed; surface as a non-error signal so the
          // caller can verify post-navigation state rather than treating
          // this as a hard failure.
          return {
            type: "script_response",
            requestId: msg.requestId,
            result: "[navigated]",
            alert: null,
            context: "main" as const,
            navigated: true,
            reauthorized: reauthorized || undefined,
          };
        } else {
          throw e;
        }
      }

      // CSP blocked eval: fall back to CDP Runtime.evaluate which bypasses CSP.
      // Race against a configurable timeout (default 30s) to prevent hung scripts
      // from locking the debugger indefinitely ("Another debugger is already
      // attached" on every subsequent call until the tab is refreshed).
      const scriptTimeoutMs = (msg.timeout_ms as number | undefined) ?? 30000;
      if (cspBlocked) {
        try {
          await raceWithNavigation(withDebugger(tabId, async () => {
            const dbg = chrome.debugger as unknown as {
              sendCommand: (t: { tabId: number }, method: string, params?: object) => Promise<unknown>;
            };
            const SERIALIZER = `function(__r) {
              if (__r === null || __r === undefined) return "undefined";
              if (typeof __r === "object") {
                try { return JSON.stringify(__r); } catch (e) { return String(__r); }
              }
              return String(__r);
            }`;
            const wrappedCode = usesAwait
              ? `(async () => {
                  var __serialize = ${SERIALIZER};
                  ${SHADOW_HELPERS}
                  var __result;
                  try { __result = await (async () => { ${code} })(); }
                  catch(e) { __result = "Error: " + e; }
                  var __alert = window._alertCapture || null;
                  if (__alert) window._alertCapture = null;
                  return JSON.stringify({ result: __serialize(__result), alert: __alert });
                })()`
              : `(function() {
                  var __serialize = ${SERIALIZER};
                  ${SHADOW_HELPERS}
                  var __result;
                  try { __result = eval(${JSON.stringify(code)}); }
                  catch(e) {
                    if (String(e).includes("Illegal return")) {
                      try { __result = (function() { ${code} })(); }
                      catch(e2) { __result = "Error: " + e2; }
                    } else { __result = "Error: " + e; }
                  }
                  var __alert = window._alertCapture || null;
                  if (__alert) window._alertCapture = null;
                  return JSON.stringify({ result: __serialize(__result), alert: __alert });
                })()`;
            const evalPromise = dbg.sendCommand({ tabId }, "Runtime.evaluate", {
              expression: wrappedCode,
              returnByValue: true,
              allowUnsafeEvalBlockedByCSP: true,
              awaitPromise: usesAwait,
            });
            const evalResult = await Promise.race([
              evalPromise,
              new Promise<never>((_, reject) => setTimeout(async () => {
                try { await dbg.sendCommand({ tabId }, "Runtime.terminateExecution"); } catch { /* best-effort */ }
                reject(new Error(`execute_script timed out after ${scriptTimeoutMs}ms. Script execution was terminated and the debugger will be released. Retry the call; no page refresh needed.`));
              }, scriptTimeoutMs)),
            ]) as { result: { value?: string }; exceptionDetails?: unknown };
            try {
              const parsed = JSON.parse(evalResult.result.value ?? "{}");
              result = parsed.result ?? "undefined";
              alertMsg = parsed.alert ?? null;
            } catch {
              result = String(evalResult.result.value ?? "undefined");
            }
          }));
        } catch (e) {
          const errStr = String((e as { message?: string })?.message ?? e);
          if (
            /Frame with ID \d+ was removed/i.test(errStr)
            || errStr.includes("No frame with id")
            || errStr.includes("Inspected target navigated or closed")
            || errStr.includes("target closed")
            || errStr.includes("page navigated during script execution")
          ) {
            return {
              type: "script_response",
              requestId: msg.requestId,
              result: "[navigated]",
              alert: null,
              context: "main" as const,
              navigated: true,
              reauthorized: reauthorized || undefined,
            };
          }
          throw e;
        }
      }

      return {
        type: "script_response",
        requestId: msg.requestId,
        result,
        alert: alertMsg,
        context: "main" as const,
        reauthorized: reauthorized || undefined,
      };
}
