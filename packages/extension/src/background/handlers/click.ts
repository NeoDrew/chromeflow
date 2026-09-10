// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, forwardToContentScript, waitForNavigation, resolvePostClickTab } from "../state";
import { withDebugger, getSubmitSignalCounts, classifyTopDialog, phaseRace, dispatchTapGesture, dispatchKeyboardActivation, dispatchHumanMouseClick, armBeforeunloadDismissOnAttachedTab, snapshotVisibleCount, freshTargetPoint, runActivityProbe, countInFlightRequests, commitReactControlState, type ActivityProbeResult } from "../cdp";
import { isBlockedUrl, isScriptableUrl } from "../policy";
import { markerIds } from "../../markers";

export async function handleClickElement(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      const before_url = tab.url ?? "";
      // Genuinely pre-dispatch (unlike preSubmitCounts below, which isn't
      // captured until after the whole click+fallback-cascade sequence has
      // already run). A synchronous UI change — a button relabelling itself,
      // no network round-trip involved — has usually already happened by
      // then, so comparing against a snapshot taken that late means "before"
      // and "after" are both post-change and no flip is ever seen. Only
      // paired-word detection needs this early snapshot: alert/toast/modal
      // are typically the result of an async network response, which
      // reliably still hasn't resolved by the time preSubmitCounts runs, so
      // that comparison is left alone.
      const earlyPairedCounts = msg.expect_submit === true && isScriptableUrl(before_url)
        ? (await getSubmitSignalCounts(tabId)).paired
        : null;

      // Phase 1: ask content script to find, scroll, and tag the element,
      // returning its viewport coordinates (with small jitter).
      // Retry up to 3 times with 500ms gap. Elements briefly disappear during
      // a React re-render and a single attempt fails; a short retry loop
      // turns those into successful clicks instead of 30s timeouts.
      type PrepResult = {
        success: boolean;
        message: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        label?: string;
        skipClick?: boolean;
        nextCandidate?: string;
        scope_missed?: boolean;
        ambiguous_match?: boolean;
        match_count?: number;
        other_matches?: string[];
        target_disabled?: boolean;
        disabled_state?: {
          disabled: boolean;
          aria_disabled: string | null;
          pointer_events: string;
          opacity: string;
          visible: boolean;
        };
      };
      // via:"fiber" skips the CDP click entirely and goes straight to React
      // fiber prop invocation. Use when the caller already knows the site is
      // React-fiber-only and wants to skip ~3 seconds of bezier-ceremony +
      // activity probe. via:"cdp" is the historical default — no fiber
      // fallback ever fires. via:"auto" (default) does CDP first, then fiber
      // when try_fiber=true was also set and activity probe failed.
      const via = (msg.via as "auto" | "cdp" | "fiber" | undefined) ?? "auto";

      if (via === "fiber") {
        const fiberResult = await forwardToContentScript(tab, {
          type: "react_fiber_click",
          requestId: msg.requestId + "-fiber-only",
          textHint: msg.textHint,
          nth: msg.nth,
          within_selector: msg.within_selector,
          near_text: msg.near_text,
          in_dialog: msg.in_dialog,
          dialog_query: msg.dialog_query,
        }).catch((e) => ({ success: false, message: String(e), fired: false })) as {
          success: boolean; message: string; fired: boolean; component?: string; label?: string;
        };
        const postTabF = await resolvePostClickTab(port, tab.windowId!);
        const afterUrlF = postTabF?.url ?? before_url;
        return {
          type: "click_element_response",
          success: fiberResult.success,
          message: fiberResult.message,
          before_url,
          after_url: afterUrlF,
          navigated: afterUrlF !== before_url,
          fiber_attempted: true,
        };
      }

      let prep: PrepResult | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        prep = await forwardToContentScript(tab, {
          type: "prepare_click_target",
          requestId: msg.requestId,
          textHint: msg.textHint,
          selector: msg.selector,
          nth: msg.nth,
          within_selector: msg.within_selector,
          near_text: msg.near_text,
          in_dialog: msg.in_dialog,
          dialog_query: msg.dialog_query,
        }) as PrepResult;
        if (prep.success) break;
        // Don't retry when the scope itself was missing — it won't appear on a 500ms delay.
        if (prep.scope_missed) break;
        if (attempt < 2) await new Promise((r) => setTimeout(r, 500));
      }

      if (!prep || !prep.success) {
        let failMsg = prep?.message ?? "click failed";
        // Dotted-id pitfall: a selector like "#a.b" (or "input#a.b") parses ".b"
        // as a CLASS, so an id with a literal dot in it (e.g. a UUID-style
        // "id1.id2") silently matches nothing. If the attribute form DOES
        // resolve, tell the caller to use it; otherwise this looks like a
        // missing element when it's really a selector-syntax trap.
        const selStr = typeof msg.selector === "string" ? msg.selector : "";
        const dotted = selStr.match(/#([\w-]+(?:\.[\w-]+)+)/);
        if (dotted && !prep?.scope_missed && tab.id && isScriptableUrl(tab.url)) {
          const literalId = dotted[1];
          try {
            const probe = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (id: string) => {
                try { return !!document.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`); }
                catch { return false; }
              },
              args: [literalId],
            });
            if (probe[0]?.result) {
              failMsg += ` Hint: "${selStr}" has a literal "." in the id, which CSS reads as a class selector. Use the attribute form instead: [id="${literalId}"].`;
            }
          } catch { /* best-effort diagnostic */ }
        }
        return { type: "click_element_response", success: false, message: failMsg, before_url, after_url: before_url, navigated: false, scope_missed: prep?.scope_missed };
      }

      // Pre-flight skip: matched element resolved to an already-checked radio.
      // The page is already in the desired state, so firing the click would
      // toggle it OFF on React-controlled forms.
      if (prep.skipClick) {
        return {
          type: "click_element_response",
          success: true,
          message: prep.message,
          before_url,
          after_url: before_url,
          navigated: false,
          ...(prep.ambiguous_match ? { ambiguous_match: true, match_count: prep.match_count, other_matches: prep.other_matches } : {}),
        };
      }

      // Pre-flight disabled handling. When the resolved match is disabled and
      // the caller supplied wait_until_enabled_ms, poll prepareClickTarget
      // briefly. Many "Submit" buttons go from disabled (validating) to enabled
      // within ~1s; this avoids the agent re-reading state mid-async via
      // execute_script and chasing a phantom missing field.
      //
      // When wait_until_enabled_ms is 0 (default) OR the wait times out, return
      // a structured target_disabled response with the full signal snapshot so
      // the agent can read disabled / aria-disabled / pointer-events / opacity
      // in one call instead of four separate execute_script reads.
      const waitUntilEnabledMs = (msg.wait_until_enabled_ms as number | undefined) ?? 0;
      if (prep.target_disabled && waitUntilEnabledMs > 0) {
        const start = Date.now();
        // Re-poll every 250ms. The first poll already happened above; start
        // the wait loop with a delay so we don't immediately re-issue.
        while (Date.now() - start < waitUntilEnabledMs) {
          await new Promise((r) => setTimeout(r, 250));
          const reprep = await forwardToContentScript(tab, {
            type: "prepare_click_target",
            requestId: msg.requestId + "-enabledpoll",
            textHint: msg.textHint,
            selector: msg.selector,
            nth: msg.nth,
            within_selector: msg.within_selector,
            near_text: msg.near_text,
            in_dialog: msg.in_dialog,
            dialog_query: msg.dialog_query,
          }) as PrepResult;
          if (reprep.success && !reprep.target_disabled) {
            prep = reprep;
            prep.message = `Target became enabled after ${Date.now() - start}ms wait. ${prep.message}`;
            break;
          }
        }
      }
      if (prep.target_disabled) {
        const ds = prep.disabled_state;
        return {
          type: "click_element_response",
          success: false,
          message: `Refusing to click "${prep.label ?? msg.textHint}" — element is disabled (disabled=${ds?.disabled}, aria-disabled=${ds?.aria_disabled ?? "null"}, pointer-events=${ds?.pointer_events}, opacity=${ds?.opacity}). If the disable is transient (mid-async-validate), retry with wait_until_enabled_ms=3000. If permanent, run get_form_fields(only_empty:true) to surface required-but-empty fields.`,
          before_url,
          after_url: before_url,
          navigated: false,
          target_disabled: true,
          disabled_state: ds,
        };
      }

      // Pre-flight refusal: matched element is 0×0 (display:none, off-DOM, or
      // a render-time race). A click at coords inside a 0×0 element doesn't
      // dispatch any useful event and any until_* clause is guaranteed to
      // time out (5s wasted per call). Better to fail fast with a clear
      // message so the caller can wait for visibility first.
      //
      // When the caller did NOT pin a specific nth and the matcher found a
      // visible peer, auto-advance to it before refusing — the most common
      // case is a duplicated label on a card grid where the hidden detail-
      // panel copy outranks the visible card. Respect explicit nth: if the
      // user pinned the 3rd "Confirmed" radio, we shouldn't silently
      // re-resolve to the 2nd one.
      if (prep.width === 0 && prep.height === 0) {
        const label = prep.label ?? msg.textHint;
        const nthExplicit = typeof msg.nth === "number" && (msg.nth as number) >= 1;
        if (!nthExplicit && prep.nextCandidate) {
          const reprep = await forwardToContentScript(tab, {
            type: "prepare_click_target",
            requestId: msg.requestId + "-advance",
            textHint: msg.textHint,
            selector: msg.selector,
            // Skip the hidden first match by asking for nth=2 — findClickableAll
            // ranks visible candidates before hidden ones, so nth=2 lands on
            // the first visible peer (or a later visible candidate if there
            // are multiple hidden ones in front).
            nth: 2,
            within_selector: msg.within_selector,
            near_text: msg.near_text,
            in_dialog: msg.in_dialog,
            dialog_query: msg.dialog_query,
          }) as PrepResult;
          if (reprep.success && reprep.width !== 0 && reprep.height !== 0) {
            // Replace prep so the rest of the flow uses the visible candidate.
            prep = reprep;
            prep.message = `Auto-advanced from hidden first match for "${msg.textHint}" → visible candidate "${prep.label ?? msg.textHint}". ${prep.message}`;
          } else {
            return {
              type: "click_element_response",
              success: false,
              message: `Matched element "${label}" is 0×0 (hidden, display:none, or not yet rendered) and the next visible candidate (${prep.nextCandidate}) couldn't be re-resolved. Retry without nth=, with a different nth, or with a more specific textHint.`,
              before_url,
              after_url: before_url,
              navigated: false,
            };
          }
        } else {
          const nextSuggestion = prep.nextCandidate
            ? ` Next visible candidate: ${prep.nextCandidate}. Retry without nth=, with a different nth, or with a more specific textHint.`
            : ` No visible candidates matched "${msg.textHint}".`;
          return {
            type: "click_element_response",
            success: false,
            message: `Matched element "${label}" is 0×0 (hidden, display:none, or not yet rendered). Refusing to click — a click at this size would dispatch no useful event.${nextSuggestion}`,
            before_url,
            after_url: before_url,
            navigated: false,
          };
        }
      }

      // Phase 2: dispatch the click via CDP (isTrusted=true events) if possible.
      // On isTrusted-strict sites, synthetic clicks are ignored but
      // CDP-dispatched events pass. Falls back to the content script's
      // synthetic-click path on chrome:// pages or debugger failure.
      //
      // ANTI-BOT BYPASS: stricter Web Components (Reddit's faceplate-*, Twitter's
      // tweet composer, etc.) check `event instanceof PointerEvent && event.isPrimary`
      // in addition to isTrusted. The default Input.dispatchMouseEvent fires only
      // MouseEvent, NOT PointerEvent. We pass pointerType="mouse" which makes
      // Chrome fire PointerEvent alongside (isPrimary=true, pointerId=1, plus
      // a realistic pressure value via `force`). Combined with the bezier
      // trajectory, settle hover, and post-click jitter, this passes
      // every behavioral check we've seen short of OS-level input.
      //
      // BEFOREUNLOAD HANG FIX (0.10.22): wrap from here through the entire
      // fallback chain + until-poll in a single outer withDebugger attach so
      // a Page.javascriptDialogOpening listener registered here stays armed
      // for the whole flow. Reddit's submit redirect fires "Leave site?" 1-2s
      // post-click, well after dispatchHumanMouseClick's own withDebugger
      // would have detached — hangs the tab if the listener is gone.
      // via === "fiber" returned early above, so by here via is "auto" or "cdp"
      // and CDP is always allowed when canCdp is true.
      const canCdp = isScriptableUrl(tab.url) && typeof prep.x === "number" && typeof prep.y === "number";

      const runClickFlow = async (): Promise<unknown> => {
      let result: { success: boolean; message: string };
      let usedCdp = false;
      const activityTimeoutMs = (msg.activity_timeout_ms as number | undefined) ?? 1500;
      // The probe is implicitly skipped when an until-clause is set (the until
      // poll IS the verification) or the caller passes skip_activity_probe.
      // Compute this here, BEFORE the click, so we can skip the expensive
      // pre-click snapshotVisibleCount baseline walk. On a deeply-nested SPA
      // page this deep walk costs 50-150ms per click; wasting it when the
      // probe won't run accounts for a measurable chunk of perceived slowness.
      const willSkipProbe =
        msg.skip_activity_probe === true ||
        !!(msg.until_selector || msg.until_url_contains || msg.until_text_contains || msg.until_url_changes);
      // Re-read the target's CURRENT center (scrolling it into view if it sits
      // outside the viewport) just before the click. prepareClickTarget's x/y
      // can be stale by now: a tall modal puts its primary button below the
      // fold, so the captured coordinate misses and the action never fires
      // (the Easy Apply "Submit" case). Done BEFORE the visible-count snapshot
      // so any scroll is reflected in the probe baseline rather than read as
      // post-click activity. Falls back to prep's coordinate if the re-read
      // fails.
      let clickX = typeof prep.x === "number" ? Math.round(prep.x) : 0;
      let clickY = typeof prep.y === "number" ? Math.round(prep.y) : 0;
      if (canCdp && tab.id) {
        const fresh = await freshTargetPoint(tab.id, markerIds.clickTargetAttr()).catch(() => null);
        if (fresh) { clickX = Math.round(fresh.x); clickY = Math.round(fresh.y); }
      }
      // Snapshot the shadow-pierce visible-element count BEFORE dispatching
      // the click, so the activity probe has a baseline that pre-dates any
      // synchronous Lit / Stencil render the click might trigger. See
      // snapshotVisibleCount jsdoc for why this can't be deferred to inside
      // the probe.
      const preClickVisibleCount = canCdp && tab.id && !willSkipProbe
        ? await snapshotVisibleCount(tab.id).catch(() => null)
        : null;
      let cdpPhaseError: string | null = null;
      if (canCdp) {
        try {
          // Per-phase budget: bezier + settle + press/release usually completes
          // in well under 2s. Cap at 8s so a hung CDP attach reports the phase
          // explicitly instead of dragging the whole click to the 30s WS cap.
          await phaseRace("cdp_click", 8000, dispatchHumanMouseClick(tabId, clickX, clickY));
          usedCdp = true;
        } catch (e) {
          const err = e as Error & { phase?: string; phaseTimedOut?: boolean };
          if (err.phaseTimedOut) cdpPhaseError = err.phase ?? "cdp_click";
          // Either CDP attach failed (fall through to synthetic) or the
          // phase exceeded its budget (record so the response carries it).
        }
      }

      // Phase 3: inspect post-click state (radio/checkbox check state, 0×0 warnings)
      // and untag. Best-effort — skip if the click caused navigation.
      let postNote = "";
      // Structured record of which fallback (if any) actually fired, so the MCP
      // server's flow-memory can tell a hard-won click apart from a trivial one
      // without parsing the free-text message.
      let recoveredVia = "";
      let postClickStateChanged = false;
      try {
        const post = await forwardToContentScript(tab, {
          type: "post_click_inspect",
          requestId: msg.requestId + "-post",
        }) as { message?: string; stateChanged?: boolean };
        postNote = post.message ?? "";
        postClickStateChanged = post.stateChanged === true;
      } catch { /* page may have navigated away */ }

      if (usedCdp) {
        result = { success: true, message: `Clicked "${prep.label ?? msg.textHint}"${postNote}` };
      } else if (cdpPhaseError) {
        // CDP phase hit its budget. Try the content-script synthetic click
        // as a graceful fallback, but tag the message so the agent sees the
        // CDP path didn't run. Helps diagnose "click_element succeeded but
        // looks like a synthetic click" cases.
        try {
          result = await forwardToContentScript(tab, msg) as { success: boolean; message: string };
          result.message = `${result.message} (CDP phase "${cdpPhaseError}" timed out; used synthetic click fallback)`;
        } catch {
          return {
            type: "click_element_response",
            success: false,
            message: `Clicked "${prep.label ?? msg.textHint}" failed: CDP phase "${cdpPhaseError}" exceeded its budget and the synthetic-click fallback also failed. Likely a hung debugger session or a tab whose content script was evicted.`,
            before_url,
            after_url: before_url,
            navigated: false,
            phase_timed_out: cdpPhaseError,
          };
        }
      } else {
        // Fallback: content-script synthetic click (isTrusted=false).
        try {
          result = await forwardToContentScript(tab, msg) as { success: boolean; message: string };
        } catch (e) {
          const errStr = String(e);
          if (/Frame with ID \d+ was removed/i.test(errStr) || errStr.includes("No frame with id")) {
            // Click triggered navigation mid-handler — treat as success.
            result = { success: true, message: `Clicked "${prep.label ?? msg.textHint}" — page navigated during click` };
          } else {
            throw e;
          }
        }
        if (!result.success) {
          const postFailTab = await resolvePostClickTab(port, tab.windowId!);
          const after_url = postFailTab?.url ?? before_url;
          return { type: "click_element_response", success: false, message: result.message, before_url, after_url, navigated: after_url !== before_url };
        }
      }

      // Implicit skip_activity_probe when an until-clause was set. The until
      // clause IS the verification: it polls for selector/text/URL appearance
      // for up to until_timeout_ms (default 5s). Running the activity probe
      // in addition produces false negatives on slow async submits (Reddit
      // post submit takes 2-3s before the page redirects, the probe times
      // out at 1500ms and reports silently_rejected), and the fallback chain
      // (tap gesture, pointer chain, DOM .click()) fires duplicate events on
      // the SAME button that the original click already hit — which on
      // Reddit gets deduped and on other sites can double-submit forms.
      const hasUntilClause = !!(
        msg.until_selector || msg.until_url_contains ||
        msg.until_text_contains || msg.until_url_changes
      );
      // Hoisted from its original declaration further down (near the
      // until-clause polling logic) so the fallback cascade below can see it
      // — expect_submit callers need the weak-signal check immediately after.
      const expectSubmit = msg.expect_submit === true;
      // postClickStateChanged is set when post_click_inspect confirmed a
      // radio/checkbox toggled state. That's a direct observation of click
      // success — running the activity probe in addition produces false
      // negatives on form inputs whose state change doesn't trigger DOM
      // mutations (Reddit's faceplate-radio-input is the canonical case).
      const effectiveSkipProbe =
        msg.skip_activity_probe === true ||
        hasUntilClause ||
        postClickStateChanged;

      if (msg.skip_activity_probe && usedCdp) {
        result.message += " (activity probe skipped; verify state manually)";
      }

      // Fast-fail probe: watch the page for ANY observable activity in the
      // 1500ms after dispatch. When 0 activity is detected, the click was
      // almost certainly silently rejected by anti-bot detection.
      //
      // Returns early as soon as activity is detected, so most clicks add
      // only ~100ms before continuing to the until-poll / expect_submit flow.
      const probeBudgetMs = activityTimeoutMs + 2000;
      const probeSkipReason = postClickStateChanged
        ? "(probe skipped: post-click state change already confirmed)"
        : hasUntilClause
          ? "(probe skipped: until-clause verifies)"
          : "(probe skipped)";
      // Cleanup helper: postClickInspect no longer removes the click-target
      // marker because the activity probe needs it to read post-click state.
      // Untag after all probes and fallbacks finish. Shadow-piercing because
      // the tagged element may live inside a closed shadow root.
      const untagClickTarget = async () => {
        if (!isScriptableUrl(tab.url) || !tab.id) return;
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (markerAttr: string) => {
              const chromeDom = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
              function getShadowRoot(el: Element): ShadowRoot | null {
                if (chromeDom?.openOrClosedShadowRoot) {
                  try { const sr = chromeDom.openOrClosedShadowRoot(el); if (sr) return sr; } catch { /* ignore */ }
                }
                return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
              }
              const stack: (Document | ShadowRoot)[] = [document];
              while (stack.length) {
                const root = stack.pop()!;
                root.querySelectorAll(`[${markerAttr}]`).forEach((el) => el.removeAttribute(markerAttr));
                root.querySelectorAll("*").forEach((el) => {
                  const sr = getShadowRoot(el);
                  if (sr) stack.push(sr);
                });
              }
            },
            args: [markerIds.clickTargetAttr()],
          });
        } catch { /* best-effort */ }
      };

      // Fallback probe budget. Each step in the fallback chain re-runs the
      // activity probe — and on a heavy antibot page where every step
      // silently_rejects, the cumulative probe wait was 5x activityTimeoutMs
      // (~7.5s on the default). Fallback probes only need a quick "did THIS
      // alternate dispatch fire" answer — successful fallbacks tend to show
      // activity within ~300-500ms. Cap each fallback at min(800,
      // activityTimeoutMs) so worst-case fallback-chain probe wait is
      // ~3.2s instead of ~6s, with no measured loss in success detection.
      const fallbackProbeTimeoutMs = Math.min(800, activityTimeoutMs);
      const probe = effectiveSkipProbe
        ? { activity: true, reason: probeSkipReason, mutation_count: 0, url_changed: false, weak: false, after_url: before_url, focused_after: null } as ActivityProbeResult
        : isScriptableUrl(tab.url) && tab.id
        ? await phaseRace("activity_probe", probeBudgetMs, runActivityProbe(tab.id, before_url, activityTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr())).catch((e) => {
            const err = e as Error & { phase?: string };
            return {
              activity: true,
              reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
              mutation_count: 0,
              url_changed: false,
              weak: false,
              after_url: before_url,
              focused_after: null,
            } as ActivityProbeResult;
          })
        : ({ activity: true, reason: "(non-scriptable; probe skipped)", mutation_count: 0, url_changed: false, weak: false, after_url: before_url, focused_after: null } as ActivityProbeResult);

      // A caller that passed expect_submit cares whether the click's actual
      // PURPOSE succeeded, not just whether SOMETHING happened. A "weak"
      // probe signal (a DOM mutation, a focus change) is exactly the kind of
      // incidental side effect a REJECTED click can still produce — e.g.
      // LinkedIn's "Send without a note" confirmation dialog closing on
      // click without the invite actually being sent (see
      // ISSUE-2026-08-15-antibot-tenant-walls.md). Without this, that weak
      // signal alone satisfies `!probe.activity` below and skips the ENTIRE
      // fallback cascade — including try_fiber, even when the caller
      // explicitly asked for it — before expect_submit's own stricter
      // URL/toast/alert/modal check ever gets a say. needsFallback() is
      // re-evaluated at each gate below since a fallback stage can flip
      // probe.activity/weak as it goes.
      const needsFallback = (p: ActivityProbeResult) => !p.activity || (expectSubmit && p.weak);

      if (needsFallback(probe)) {
        // First-line automatic fallback when the primary CDP click had
        // valid coordinates: re-dispatch as a CDP synthesizeTapGesture.
        // This is also isTrusted=true (same trust level as the primary)
        // but the auto-generated click event carries isPrimary=true on
        // the click stage — dispatchHumanMouseClick's click stage gets
        // isPrimary=false because Chromium derives the click from the
        // already-released pointer. Reddit's faceplate-* Lit components
        // gate on `event.isTrusted && event.isPrimary` on the click event
        // (most visibly the new-post flair button), and that combination
        // is exactly what the tap gesture satisfies.
        if (
          canCdp &&
          typeof prep.x === "number" &&
          typeof prep.y === "number" &&
          tab.id
        ) {
          try {
            // Re-verify the tagged element is still there and re-read its
            // CURRENT position before dispatching at a coordinate. Previously
            // this block could only be reached when probe.activity was FALSE
            // (zero observable change at all), which meant the target could
            // not have been removed from the DOM yet. needsFallback() above
            // now also enters here on a WEAK signal (expect_submit only) —
            // e.g. a confirmation dialog closing IS a mutation, so the tagged
            // "Send" button inside it may already be gone. Dispatching a tap
            // at the stale prep.x/prep.y in that case would land on whatever
            // page content is now underneath instead, a real misclick risk
            // that didn't exist before this path could be reached. Skip the
            // coordinate dispatch (falls through to keyboard-enter, which
            // safely no-ops on its own re-query) rather than guess.
            const fresh = await freshTargetPoint(tabId, markerIds.clickTargetAttr());
            if (!fresh) throw new Error("tagged target no longer present");
            await phaseRace(
              "tap_gesture_fallback",
              3500,
              dispatchTapGesture(tabId, Math.round(fresh.x), Math.round(fresh.y)),
            );
            const probeTap = await phaseRace(
              "activity_probe_tap_fallback",
              3500,
              runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr()),
            ).catch((e) => {
              const err = e as Error & { phase?: string };
              return {
                activity: true,
                reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
                mutation_count: 0,
                url_changed: false,
                weak: false,
                after_url: before_url,
                focused_after: null,
              } as ActivityProbeResult;
            });
            if (probeTap.activity) {
              postNote += ` (fired via CDP synthesizeTapGesture after dispatchMouseEvent silently_rejected)`;
              recoveredVia = "tap-gesture";
              probe.activity = true;
              probe.weak = probeTap.weak;
              probe.after_url = probeTap.after_url;
              probe.focused_after = probeTap.focused_after;
              probe.mutation_count = probeTap.mutation_count;
              probe.url_changed = probeTap.url_changed;
            }
          } catch {
            // synthesizeTapGesture failed (older Chrome, debugger detached).
            // Fall through to the DOM .click() path below.
          }
        }
      }

      if (needsFallback(probe)) {
        // Keyboard activation fallback. Reddit's <faceplate-*> web
        // components (flair button, comment composer expand) and similar
        // strict gates check something beyond isTrusted=true on the click
        // event — likely the activation provenance. CDP mouse events count
        // as trusted but get rejected anyway. Dispatching a CDP keyboard
        // Enter on the focused element activates the button via the
        // browser's native keyboard activation path, which bypasses any
        // mouse-event source checks the page added.
        //
        // Focuses the tagged element via execute_script (ISOLATED world so
        // the marker attribute resolves), then dispatches Input.dispatchKeyEvent
        // for Enter. Buttons and most form controls handle Enter natively.
        if (canCdp && tab.id) {
          try {
            // Two focus strategies:
            // 1. el.focus() via execute_script (works for plain buttons; programmatic focus)
            // 2. Fallback: send a CDP-level Tab keypress until the element gets focus
            //    (slower but creates a "real" focus via the browser's tab order)
            // After focus, dispatchKeyboardActivation sends Enter via CDP.
            const focusOk = await chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (markerAttr: string) => {
                const el = document.querySelector<HTMLElement>(`[${markerAttr}]`);
                if (!el) return false;
                el.focus({ preventScroll: false });
                // Some custom elements delegate focus — accept if activeElement is el OR descendant
                const ae = document.activeElement;
                return ae === el || (ae && el.contains(ae));
              },
              args: [markerIds.clickTargetAttr()],
            });
            if (focusOk[0]?.result === true) {
              await phaseRace("keyboard_activation_fallback", 3500, dispatchKeyboardActivation(tabId));
              const probeKB = await phaseRace(
                "activity_probe_keyboard_fallback",
                3500,
                runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr()),
              ).catch((e) => {
                const err = e as Error & { phase?: string };
                return {
                  activity: true,
                  reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
                  mutation_count: 0,
                  url_changed: false,
                  weak: false,
                  after_url: before_url,
                  focused_after: null,
                } as ActivityProbeResult;
              });
              if (probeKB.activity) {
                postNote += ` (fired via CDP keyboard Enter after mouse silently_rejected)`;
                recoveredVia = "keyboard-enter";
                probe.activity = true;
                probe.weak = probeKB.weak;
                probe.after_url = probeKB.after_url;
                probe.focused_after = probeKB.focused_after;
                probe.mutation_count = probeKB.mutation_count;
                probe.url_changed = probeKB.url_changed;
              }
            }
          } catch { /* fall through to pointer chain */ }
        }
      }

      if (needsFallback(probe)) {
        // Pointer chain fallback: dispatch the full pointer event sequence
        // (pointerdown, mousedown, pointerup, mouseup, click) directly ON
        // the tagged element via the content script. This avoids the shadow
        // DOM event retargeting problem: CDP coordinate-based clicks fire
        // correctly inside the shadow root, but when the event bubbles OUT
        // of the shadow boundary, event.target is retargeted to the shadow
        // host. React event delegation checks event.target to route to the
        // component handler, finds the host instead of the button, and
        // discards the event. Dispatching directly on the element keeps
        // event.target correct within the shadow root's delegation context.
        //
        // Also reachable when the PRIMARY cdp_click phase itself timed out
        // (cdpPhaseError set, usedCdp false) — a hung CDP mouse dispatch (a
        // renderer main thread pegged busy by an anti-bot/fingerprinting
        // script is one plausible cause; unlike a coordinate click, this
        // dispatch needs no hit-testing) is a DIFFERENT failure mode from
        // "CDP click landed but the page silently rejected it", and this
        // fallback was previously unreachable in that case even though
        // nothing pointer-chain-shaped had been tried yet (unlike dom-click
        // below, which the cdpPhaseError branch above already ran once, so
        // it correctly stays usedCdp-gated to avoid double-firing). See
        // ISSUE-2026-08-15-antibot-tenant-walls.md.
        if (
          (usedCdp || !!cdpPhaseError) &&
          isScriptableUrl(tab.url) &&
          tab.id
        ) {
          const pcResult = await phaseRace(
            "pointer_chain_fallback",
            3500,
            forwardToContentScript(tab, {
              type: "pointer_chain_click",
              requestId: msg.requestId + "-pc",
            }),
          ).catch(() => null) as { fired?: boolean; label?: string } | null;

          if (pcResult?.fired) {
            const probePC = await phaseRace(
              "activity_probe_pointer_chain",
              3500,
              runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr()),
            ).catch((e) => {
              const err = e as Error & { phase?: string };
              return {
                activity: true,
                reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
                mutation_count: 0,
                url_changed: false,
                weak: false,
                after_url: before_url,
                focused_after: null,
              } as ActivityProbeResult;
            });

            if (probePC.activity) {
              postNote += ` (fired via pointer chain fallback after CDP silently_rejected inside shadow DOM)`;
              recoveredVia = "pointer-chain";
              probe.activity = true;
              probe.weak = probePC.weak;
              probe.after_url = probePC.after_url;
              probe.focused_after = probePC.focused_after;
              probe.mutation_count = probePC.mutation_count;
              probe.url_changed = probePC.url_changed;
            }
          }
        }
      }

      if (needsFallback(probe)) {
        // DOM .click() fallback (only when the primary CDP path ran):
        // re-dispatch the click via the content-script's `.click()` method,
        // which loses isTrusted=true but catches a class of handlers the CDP
        // click misses: HTML Popover API triggers (button[popovertarget]
        // toggling <r-post-flairs-modal> on Reddit's new-post composer),
        // <faceplate-*> Lit web components that bind via addEventListener
        // without isTrusted gating, and onclick handlers attached on hosts
        // whose pointer-events:none parents ate the coordinate-based event.
        //
        // Outer `if (!probe.activity)` already gates on confident inactivity
        // so double-firing isn't a real risk; gate only on CDP having been
        // the primary path so the content-script .click() hasn't already
        // run (cdpPhaseError + non-scriptable url paths run it pre-probe).
        // Sites that gate strictly on isTrusted (Reddit comment submit
        // pre-0.9.12, X submit) will still silently_reject here.
        if (
          usedCdp &&
          isScriptableUrl(tab.url) &&
          tab.id
        ) {
          const domResult = await phaseRace(
            "dom_click_fallback",
            3500,
            forwardToContentScript(tab, msg),
          ).catch(() => null) as { success: boolean; message: string } | null;

          if (domResult?.success) {
            const probeDom = await phaseRace(
              "activity_probe_dom_fallback",
              3500,
              runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr()),
            ).catch((e) => {
              const err = e as Error & { phase?: string };
              return {
                activity: true,
                reason: `(probe phase exceeded budget: ${err.phase}; treating as activity)`,
                mutation_count: 0,
                url_changed: false,
                weak: false,
                after_url: before_url,
                focused_after: null,
              } as ActivityProbeResult;
            });

            if (probeDom.activity) {
              postNote += ` (fired via DOM .click() fallback after CDP silently_rejected)`;
              recoveredVia = "dom-click";
              // Refresh probe with the post-fallback state so the until_*
              // poll below sees the right after_url / focused_after.
              probe.activity = true;
              probe.weak = probeDom.weak;
              probe.after_url = probeDom.after_url;
              probe.focused_after = probeDom.focused_after;
              probe.mutation_count = probeDom.mutation_count;
              probe.url_changed = probeDom.url_changed;
            }
          }
        }
      }

      if (needsFallback(probe)) {
        // Last-resort fallback: walk the React fiber tree from the matched
        // element and invoke __reactProps$.onClick directly. Helps on React-
        // heavy SPAs whose action buttons need the synthetic React handler and
        // don't respond to a coordinate CDP click even when isTrusted (e.g.
        // LinkedIn's Easy Apply "Submit application" button). Fires by default
        // for via:"auto" on textHint clicks, since it only runs after every
        // isTrusted fallback above already silently_rejected.
        //
        // SELECTOR-mode clicks require an explicit try_fiber=true. The activity
        // probe can be blind to a CDP click that DID land inside a shadow-DOM
        // modal (a step-swap changes too few visible elements to cross the
        // probe's delta threshold), so auto-firing onClick on a precisely
        // selected element risks DOUBLE-FIRING an action the CDP click already
        // performed. textHint clicks re-resolve by visible text and carry the
        // same long-standing accepted risk; selector clicks are the precise
        // path where the user can opt in deliberately. via:"cdp" skips it
        // entirely (callers who never want the undocumented fiber-prop path).
        if (via !== "cdp" && (!msg.selector || msg.try_fiber === true)) {
          const fiberResult = await phaseRace("react_fiber_click", 3500, forwardToContentScript(tab, {
            type: "react_fiber_click",
            requestId: msg.requestId + "-fiber",
            textHint: msg.textHint,
            selector: msg.selector,
            nth: msg.nth,
            within_selector: msg.within_selector,
            near_text: msg.near_text,
            in_dialog: msg.in_dialog,
            dialog_query: msg.dialog_query,
          })).catch((e) => ({ success: false, message: String(e), fired: false })) as {
            success: boolean; message: string; fired: boolean; component?: string; label?: string;
          };

          // Re-probe activity after the fiber invocation. If the onClick
          // handler actually did something (state change, navigation, mutation),
          // the second probe sees it and we fall through to the rest of the
          // click flow (until_*, expect_submit, etc).
          const probe2 = isScriptableUrl(tab.url) && tab.id
            ? await phaseRace("activity_probe_2", 3500, runActivityProbe(tab.id, before_url, fallbackProbeTimeoutMs, preClickVisibleCount, markerIds.clickTargetAttr())).catch((e) => {
                const err = e as Error & { phase?: string };
                return {
                  activity: true,
                  reason: `(probe2 phase exceeded budget: ${err.phase}; treating as activity)`,
                  mutation_count: 0,
                  url_changed: false,
                  weak: false,
                  after_url: before_url,
                  focused_after: null,
                } as ActivityProbeResult;
              })
            : ({ activity: true, reason: "(non-scriptable; probe skipped)", mutation_count: 0, url_changed: false, weak: false, after_url: before_url, focused_after: null } as ActivityProbeResult);

          if (probe2.activity) {
            // Fiber click succeeded. Continue with the existing flow (until_*
            // poll lower down). Stash a note so the success message records
            // that the fiber path was used.
            postNote += ` (fired via React fiber after CDP silently_rejected)`;
            recoveredVia = "react-fiber";
          } else if (!expectSubmit) {
            // expect_submit callers get a more specific verdict from their
            // own URL/toast/alert/modal poll further down instead of this
            // generic message — falling through here (not returning) is what
            // lets that poll actually run rather than being pre-empted by a
            // silently_rejected bail-out. Non-expect_submit callers keep the
            // existing behavior: report the rejection now.
            return {
              type: "click_element_response",
              success: false,
              message: `Clicked "${prep.label ?? msg.textHint}" but no observable activity (DOM mutations, focus change, URL change, alert/toast/modal) within ${activityTimeoutMs}ms even after the React fiber fallback (${fiberResult.fired ? "fiber onClick invoked, no DOM/URL/focus/alert change" : `no React fiber __reactProps$.onClick found: ${fiberResult.message}`}). The click MAY have succeeded for actions whose state change isn't observable in the DOM (toggling internal state, opening native dialogs). Verify with find_text or execute_script before retrying. If genuinely rejected, this action cannot complete unattended — report it rather than falling back to highlight_region + wait_for_click.`,
              before_url,
              after_url: probe2.after_url,
              navigated: false,
              focused_after: probe2.focused_after,
              silently_rejected: true,
              fiber_attempted: true,
            };
          }
        } else if (!expectSubmit) {
          // Same expect_submit deferral as above — let its own poll decide.
          return {
            type: "click_element_response",
            success: false,
            message: `Clicked "${prep.label ?? msg.textHint}" but no observable activity (DOM mutations, focus change, URL change, alert/toast/modal) within ${activityTimeoutMs}ms. Possible causes: (1) the click DID work but the state change isn't observable in the DOM (toggling internal Lit state, opening native dialogs, setting a value) — verify with find_text or execute_script before retrying; (2) the action takes longer than ${activityTimeoutMs}ms — retry with activity_timeout_ms=3000+; (3) genuine anti-bot rejection, retry with try_fiber=true on React SPAs — if that also fails, this action cannot complete unattended; report it rather than falling back to highlight_region + wait_for_click.`,
            before_url,
            after_url: probe.after_url,
            navigated: false,
            focused_after: probe.focused_after,
            silently_rejected: true,
          };
        }
      }

      // React controlled radio/checkbox commit. A CDP/synthetic click flips the
      // input's DOM .checked (so the activity probe reports success), but
      // React's delegated change listener can MISS the event when event.target
      // is retargeted at a shadow boundary — leaving the form-level store stale
      // and a "This question is required" error stuck. If the clicked target is
      // a radio/checkbox whose React-controlled `checked` prop disagrees with
      // the DOM, call __reactProps$.onChange directly to sync the store. Runs
      // in MAIN world (the only place page expandos like __reactProps$ are
      // visible). Idempotent: only fires on a genuine prop/DOM mismatch, so it
      // never double-toggles an already-committed change.
      if (isScriptableUrl(tab.url) && tab.id) {
        const committed = await phaseRace(
          "react_state_commit",
          2500,
          commitReactControlState(tab.id, markerIds.clickTargetAttr()),
        ).catch(() => null) as { committed: boolean; kind?: string } | null;
        if (committed?.committed) {
          result.message += ` (synced stale React ${committed.kind ?? "control"} state via onChange)`;
          if (!recoveredVia) recoveredVia = `react-onchange-${committed.kind ?? "control"}`;
        }
      }

      // Probe + fallbacks done. Remove the marker so the next click doesn't
      // hit a stale tag.
      await untagClickTarget();

      // If the caller specified an until-clause, poll for it before returning.
      // This catches the "click_element returned success but the click didn't
      // register" case on React-heavy sites — Claude can require an observable
      // post-click condition (URL change, new selector, new page text) instead
      // of trusting the synthetic-success message.
      const untilSelector = msg.until_selector as string | undefined;
      const untilUrlContains = msg.until_url_contains as string | undefined;
      const untilTextContains = msg.until_text_contains as string | undefined;
      const untilUrlChanges = msg.until_url_changes === true;
      // url-change waits gate submit-style navigations whose backend roundtrip
      // can run 5-15s before the URL flips, so default them longer than
      // selector/text waits. Caller can still override with until_timeout_ms.
      const untilTimeoutMs = (msg.until_timeout_ms as number | undefined) ?? (untilUrlChanges ? 15000 : 5000);
      const hasUntil = !!(untilSelector || untilUrlContains || untilTextContains || untilUrlChanges);
      // If the substring is already present in the pre-click URL, require
      // an actual URL change too — otherwise /tasks/OLD → /tasks/NEW with
      // until_url_contains="tasks/" matches instantly on the pre-click URL.
      const urlContainsRequiresChange = !!(untilUrlContains && before_url.includes(untilUrlContains));

      // For expect_submit: snapshot the pre-click counts of alert/toast/modal
      // selectors so we can detect NEW ones appearing after the click.
      // Without this snapshot, a pre-existing toast would be misread as a
      // post-submit signal.
      const preSubmitCounts = expectSubmit && !hasUntil && isScriptableUrl(tab.url)
        ? await getSubmitSignalCounts(tabId)
        : null;

      let untilResult: {
        ok: boolean;
        reason: string;
        request_in_flight?: boolean;
        dialog?: { kind: string; label: string; primary_action: string };
      } | null = null;
      let navigationResult: string | null = null;

      if (hasUntil) {
        const start = Date.now();
        // Hard ceiling for the grace-extension below: if a submit request is
        // still in flight at the base deadline, keep waiting (up to this cap)
        // rather than declaring failure on a click that genuinely fired.
        const maxDeadline = start + Math.max(untilTimeoutMs, untilUrlChanges ? 30000 : untilTimeoutMs);
        let deadline = start + untilTimeoutMs;
        let sawInFlight = false;
        // Pre-loop visible-modal count so the in-loop early-dialog check can
        // tell a dialog that opened in RESPONSE to this click from one that was
        // already on screen before it.
        const preModalCount = (untilUrlChanges && isScriptableUrl(tab.url) && tab.id)
          ? (await getSubmitSignalCounts(tab.id)).modal
          : 0;
        // Pre-click top dialog (shadow-aware) so the post-timeout blocker
        // diagnosis only attributes a dialog to THIS click when one genuinely
        // appeared. Without it, a modal already open before the click would be
        // misreported as "the click opened a dialog" on any until-timeout.
        const preDialog = (untilUrlChanges && isScriptableUrl(tab.url) && tab.id)
          ? await classifyTopDialog(tab.id)
          : null;
        let earlyDialog: { kind: string; label: string; primary_action: string } | undefined;
        let iter = 0;
        while (Date.now() < deadline) {
          iter++;
          // Pull the current tab state each iteration (URL may change after navigation).
          const [currentTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
          const currentUrl = currentTab?.url ?? "";

          if (untilUrlChanges && currentUrl && currentUrl !== before_url) {
            untilResult = { ok: true, reason: `URL changed to ${currentUrl}` };
            navigationResult = currentUrl;
            break;
          }

          if (
            untilUrlContains
            && currentUrl.includes(untilUrlContains)
            && (!urlContainsRequiresChange || currentUrl !== before_url)
          ) {
            untilResult = { ok: true, reason: `URL now contains "${untilUrlContains}"` };
            navigationResult = currentUrl;
            break;
          }

          if (currentTab?.id && isScriptableUrl(currentUrl) && (untilSelector || untilTextContains)) {
            try {
              // Selector + text checks in ONE round-trip. The light-DOM checks
              // (document.querySelector / body.innerText) run EVERY 250ms tick
              // and are cheap + visible-text-correct. The shadow-pierce walk is
              // the part that costs real CPU on 1000+ shadow-host pages, so it
              // runs only on a ~1Hz throttle (doShadow) and only for whatever the
              // light DOM hasn't already satisfied. It exists so until_selector /
              // until_text_contains can see inside web-component modals (LinkedIn
              // Easy Apply, Radix portals, Reddit faceplate) that the old
              // light-DOM-only checks were blind to. Shadow TEXT is read via each
              // root's children innerText (rendered/visible), NOT textContent, so
              // it keeps the "visible page text" contract and never matches a
              // display:none / hidden subtree the user can't see.
              const r = await chrome.scripting.executeScript({
                target: { tabId: currentTab.id },
                func: (sel: string | null, needle: string | null, doShadow: boolean) => {
                  // Light DOM, every tick.
                  let selOk = sel ? !!document.querySelector(sel) : false;
                  let textOk = needle ? (document.body?.innerText ?? "").includes(needle) : false;
                  const needSel = !!sel && !selOk;
                  const needText = !!needle && !textOk;
                  if (doShadow && (needSel || needText)) {
                    const cd = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
                    const getSR = (el: Element): ShadowRoot | null => {
                      try { if (cd?.openOrClosedShadowRoot) { const sr = cd.openOrClosedShadowRoot(el); if (sr) return sr; } } catch { /* ignore */ }
                      return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
                    };
                    const stack: (Document | ShadowRoot)[] = [document];
                    while (stack.length && ((needSel && !selOk) || (needText && !textOk))) {
                      const root = stack.pop()!;
                      for (const el of Array.from(root.querySelectorAll("*"))) {
                        const sr = getSR(el);
                        if (!sr) continue;
                        if (needSel && !selOk) { try { if (sr.querySelector(sel!)) selOk = true; } catch { /* bad selector */ } }
                        if (needText && !textOk) {
                          let vis = "";
                          for (const c of Array.from(sr.children)) vis += " " + ((c as HTMLElement).innerText ?? "");
                          if (vis.includes(needle!)) textOk = true;
                        }
                        stack.push(sr);
                      }
                    }
                  }
                  return { selOk, textOk };
                },
                args: [untilSelector ?? null, untilTextContains ?? null, iter % 4 === 1],
              });
              const res = r[0]?.result as { selOk: boolean; textOk: boolean } | undefined;
              if (res?.selOk) { untilResult = { ok: true, reason: `Selector "${untilSelector}" appeared` }; break; }
              if (res?.textOk) { untilResult = { ok: true, reason: `Text "${untilTextContains}" appeared` }; break; }
            } catch { /* page may be navigating — keep polling */ }
          }

          // Network-aware deadline extension. A click whose handler fired an
          // API request (submit, save) often navigates only AFTER the request
          // resolves, sometimes past the base timeout. Probe for a fresh
          // fetch/XHR on EVERY iteration once we're past the first second (not
          // only in the final 500ms: a submit that runs client-side validation
          // before firing its POST can have that request in flight well before
          // the old single-check window, so a lone probe at deadline-500 missed
          // it entirely). While a request is in flight, keep the deadline ahead
          // of now (capped at maxDeadline) so a genuinely-fired submit isn't
          // reported as "click may not have registered" and retried into a
          // double-submit. The 1s grace skips the initial fast-match window so
          // quick navigations/selector matches don't pay for the probe.
          if (currentTab?.id && isScriptableUrl(currentUrl) && Date.now() - start >= 1000) {
            const inflight = await countInFlightRequests(currentTab.id).catch(() => 0);
            if (inflight > 0) {
              sawInFlight = true;
              deadline = Math.min(maxDeadline, Date.now() + 4000);
            }
          }

          // Early two-step-submit detection. On an until_url_changes wait, a
          // click that opens a confirmation / required-input dialog (instead of
          // navigating) would otherwise sit here for the ENTIRE timeout before
          // the post-loop classifier runs. Check ~once a second for a NEW
          // visible modal; if an actionable one appeared (not a bare spinner),
          // record it and stop waiting; the post-loop block turns earlyDialog
          // into the blocker hint and dialog_opened field. The pre-loop count
          // guard means a modal already open before the click won't trip this.
          if (untilUrlChanges && currentTab?.id && isScriptableUrl(currentUrl) && iter % 4 === 0) {
            const modalNow = (await getSubmitSignalCounts(currentTab.id)).modal;
            if (modalNow > preModalCount) {
              const d = await classifyTopDialog(currentTab.id);
              if (d && (d.kind === "confirmation" || d.kind === "required-input")) {
                earlyDialog = d;
                break;
              }
            }
          }

          await new Promise((r) => setTimeout(r, 250));
        }
        if (!untilResult) {
          // One last in-flight probe to catch a request that fired in the final
          // poll gap (between the loop's last iteration and the deadline). This
          // flips the message below from the dangerous "may not have registered"
          // (which invites a double-submit retry) to "request in flight".
          if (!sawInFlight && tab.id && isScriptableUrl(tab.url)) {
            const finalInflight = await countInFlightRequests(tab.id).catch(() => 0);
            if (finalInflight > 0) sawInFlight = true;
          }
          const conditions = [
            untilSelector && `selector "${untilSelector}"`,
            untilUrlContains && `URL containing "${untilUrlContains}"`,
            untilTextContains && `text "${untilTextContains}"`,
            untilUrlChanges && `URL change`,
          ].filter(Boolean).join(" or ");

          // Check if a dialog/modal opened post-click and CLASSIFY it. Two very
          // different things both open a [role=dialog]:
          //   - a confirmation step ("Submit?" -> [Confirm]) — the click worked,
          //     it's just a two-step action; the agent should click through.
          //   - a required-input prompt (flair picker, "answer this first") —
          //     the agent must supply the missing value before retrying.
          // The old code labelled everything "required-input prompt", which was
          // misleading on confirm dialogs. We now distinguish them by content
          // (form fields / validation text => required-input, else => confirm)
          // and surface the primary action label so the agent knows what to
          // click next.
          let blockerHint = "";
          let dialogInfo: { kind: string; label: string; primary_action: string } | undefined;
          // Reuse the dialog detected mid-loop (early-dialog path below) if one
          // was already classified; otherwise probe now.
          if (earlyDialog) {
            dialogInfo = earlyDialog;
          } else if (isScriptableUrl(tab.url) && tab.id) {
            const d = await classifyTopDialog(tab.id);
            // Only attribute the dialog to this click when it is actually new;
            // a dialog already open before the click (same label) was not
            // opened by it, so don't claim "the click opened a dialog".
            if (d && (!preDialog || d.label !== preDialog.label)) dialogInfo = d;
          }
          if (dialogInfo) {
            const d = dialogInfo;
            if (d.kind === "confirmation") {
              blockerHint = ` A confirmation dialog opened: "${d.label}". This is a two-step action, not a validation error; the first click worked. Click its primary action${d.primary_action ? ` ("${d.primary_action}")` : ""} to complete, e.g. click_element with textHint="${d.primary_action || "Confirm"}".`;
            } else if (d.kind === "required-input") {
              blockerHint = ` A required-input dialog opened: "${d.label}". Supply the missing value inside it${d.primary_action ? `, then click "${d.primary_action}"` : ""}, before retrying the original action.`;
            } else {
              blockerHint = ` A dialog opened post-click: "${d.label}".`;
            }
          }

          const waited = Date.now() - start;
          if (dialogInfo) {
            // A dialog opened in response to the click (caught mid-loop or at
            // timeout) instead of the awaited ${conditions}. The click DID
            // register; blockerHint says what to do next (click the dialog's
            // primary action). Do NOT tell the caller to re-click the original
            // element: on a submit that is the double-submit this code works to
            // avoid. Preserve request_in_flight when a request was also pending.
            untilResult = {
              ok: false,
              dialog: dialogInfo,
              ...(sawInFlight ? { request_in_flight: true } : {}),
              reason: `Click fired and opened a dialog instead of ${conditions} within ${waited}ms; the click DID register, do NOT re-click it.${blockerHint}`,
            };
          } else if (sawInFlight) {
            // The click fired a network request that was still resolving — it
            // DID register. Surface that instead of "may not have registered",
            // which on a submit invites a double-submit retry.
            untilResult = {
              ok: false,
              request_in_flight: true,
              reason: `Click fired and triggered a network request still in flight after ${waited}ms; ${conditions} has not appeared yet. The click DID register — navigation/response is likely pending. Do NOT retry (double-submit risk). Re-check page state, or call again with a higher until_timeout_ms.`,
            };
          } else {
            untilResult = {
              ok: false,
              reason: `Click fired but ${conditions} did not appear within ${waited}ms; the click may not have registered. Try execute_script with a direct .click() on the matched element, or pass a different until_* value.`,
            };
          }
        }
      } else if (expectSubmit) {
        // expect_submit: poll for any anti-bot-friendly submit signal within
        // 4s. Catches the "synthetic click silently rejected" case on Reddit /
        // X submit without needing a specific until_* destination.
        const start = Date.now();
        while (Date.now() - start < 4000) {
          const [t] = await chrome.tabs.query({ active: true, windowId: tab.windowId! });
          const url = t?.url ?? "";
          if (url && url !== before_url) {
            untilResult = { ok: true, reason: `URL changed to ${url}` };
            navigationResult = url;
            break;
          }
          if (t?.id && isScriptableUrl(url)) {
            const counts = await getSubmitSignalCounts(t.id);
            const pre = preSubmitCounts ?? { alert: 0, toast: 0, modal: 0, paired: [] };
            if (counts.alert > pre.alert) {
              untilResult = { ok: true, reason: `alert/aria-live element appeared` };
              break;
            }
            if (counts.toast > pre.toast) {
              untilResult = { ok: true, reason: `toast / notification element appeared` };
              break;
            }
            if (counts.modal > pre.modal) {
              untilResult = { ok: true, reason: `modal / [role=dialog] appeared` };
              break;
            }
            // A confirmed action whose only feedback is a button relabelling
            // itself (Connect->Pending, Follow->Following) produces none of
            // the three signals above. Require the SAME pair to move in both
            // directions (a before-word disappearing, its paired after-word
            // appearing) so an unrelated page refresh can't satisfy this by
            // coincidence. See ISSUE-2026-08-16-linkedin-connect-expect-
            // submit-weak-signal.md.
            const flipped = earlyPairedCounts && counts.paired.find((now) => {
              const before = earlyPairedCounts!.find((p) => p.before === now.before && p.after === now.after);
              return before && now.afterCount > before.afterCount && now.beforeCount < before.beforeCount;
            });
            if (flipped) {
              untilResult = { ok: true, reason: `a control's label flipped from "${flipped.before}" to "${flipped.after}" — the action completed even though no URL/toast/alert/modal signal fired` };
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 300));
        }
        if (!untilResult) {
          untilResult = {
            ok: false,
            reason: `submit silently rejected (likely anti-bot): no URL change, toast, alert, modal, or label-flip signal appeared within 4s. Synthetic clicks fail on Reddit / X / mcp.so even though isTrusted passes. Retry with try_fiber=true on React SPAs; otherwise this action cannot complete unattended — report the rejection back rather than waiting on highlight_region + wait_for_click, since most sessions have no one present to click.`,
          };
        }
      } else {
        // No until-clause and no expect_submit — race a real-load wait against
        // a brief hard cap. 1500ms is the SPA-pushState window — most React-
        // router clicks complete their pushState in <1000ms; 1500ms gives margin
        // without making non-navigating clicks feel slow.
        navigationResult = await Promise.race([
          waitForNavigation(tab.id!, 4000),
          new Promise<null>((r) => setTimeout(() => r(null), 1500)),
        ]);
        // pushState-only navigations: chrome.tabs URL can lag a few hundred ms
        // behind the actual location after a synchronous history.pushState.
        // Without this settle, navigated:false fires on legitimate SPA navs.
        if (!navigationResult) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      // Check if a JS alert/confirm/prompt fired during or after the click.
      // The interceptor (injected on page load) captures these non-blockingly.
      let alertMessage: string | null = null;
      if (isScriptableUrl(tab.url)) {
        try {
          const alertResults = await chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            world: "MAIN",
            func: () => {
              const captured = (window as any)._alertCapture ?? null;
              if (captured) (window as any)._alertCapture = null;
              return captured;
            },
          });
          alertMessage = (alertResults[0]?.result as string | null) ?? null;
        } catch { /* non-scriptable or unloaded tab — ignore */ }
      }

      // Snapshot the post-click URL so callers can spot silent redirects.
      // A click "Assessment" link on Canvas that bounces to the course home
      // returns success today with no indication anything went wrong — the
      // before/after URL pair makes that visible.
      const postTab = await resolvePostClickTab(port, tab.windowId!);
      const after_url = postTab?.url ?? navigationResult ?? before_url;
      const navigated = after_url !== before_url;

      // Post-click navigation guard: if the click navigated to a blocked URL
      // (e.g. clicked a github.com link), reverse the navigation immediately
      // and report a refusal. Honors the hard-coded URL policy at the
      // navigation result layer for clicks that originate as plain text-hint
      // clicks but resolve to blocked destinations.
      if (navigated) {
        const blockNav = isBlockedUrl(after_url);
        if (blockNav.blocked && postTab?.id) {
          try { await chrome.tabs.goBack(postTab.id); } catch { /* no history — leave tab as-is */ }
          return {
            type: "click_element_response",
            success: false,
            message: `Click navigated to a blocked URL (${after_url}). ${blockNav.reason} The navigation has been reversed.`,
            before_url,
            after_url,
            navigated: true,
          };
        }
      }

      let message: string;
      if (untilResult) {
        // The until-clause is the authoritative signal — a successful click
        // is the one whose post-click condition was met. Failure is reported
        // as success:false so callers can branch on it.
        message = `${result.message}${untilResult.ok ? "" : "\n"}${untilResult.ok ? ` — ${untilResult.reason}` : `\n⚠ ${untilResult.reason}`}`;
        if (alertMessage) {
          message += `\n\nPAGE ALERT: "${alertMessage}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
        }
        return {
          type: "click_element_response",
          success: untilResult.ok,
          message,
          before_url,
          after_url,
          navigated,
          focused_after: probe.focused_after,
          ...(recoveredVia ? { recovered_via: recoveredVia } : {}),
          ...(untilResult.request_in_flight ? { request_in_flight: true } : {}),
          ...(untilResult.dialog ? { dialog_opened: untilResult.dialog } : {}),
          ...(prep.ambiguous_match ? { ambiguous_match: true, match_count: prep.match_count, other_matches: prep.other_matches } : {}),
        };
      }

      message = navigationResult
        ? `Clicked and navigated to ${navigationResult}`
        : result.message;

      if (alertMessage) {
        message += `\n\nPAGE ALERT: "${alertMessage}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
      }

      if (prep.ambiguous_match) {
        message += `\n\n⚠ selector matched ${prep.match_count} elements — clicked the first (nth=${msg.nth ?? 1}). Other matches: ${(prep.other_matches ?? []).join("; ") || "(none captured)"}. If this selector was meant to target ONE specific control, duplicate/repeated elements on the page mean this click may have hit the wrong copy — verify the result, or re-issue with within_selector/near_text/nth to disambiguate.`;
      }

      return {
        type: "click_element_response",
        success: true,
        message,
        before_url,
        after_url,
        navigated,
        focused_after: probe.focused_after,
        ...(recoveredVia ? { recovered_via: recoveredVia } : {}),
        ...(prep.ambiguous_match ? { ambiguous_match: true, match_count: prep.match_count, other_matches: prep.other_matches } : {}),
      };
      }; // end runClickFlow

      // Safety net for the ambiguous-match warning: several of runClickFlow's
      // internal return points (the various "no observable activity" /
      // silently_rejected branches for each fallback stage) were written
      // before this signal existed and don't append it themselves. Rather
      // than touch every one of those branches individually, catch anything
      // that slipped through here — this is exactly the case that matters
      // MOST (a click that looks like it failed might actually have hit the
      // WRONG duplicate). Guarded by a distinctive substring so a branch that
      // ALREADY appended the note (the success paths above do) doesn't get it
      // twice.
      const withAmbiguityNote = (res: unknown): unknown => {
        if (!prep.ambiguous_match || typeof res !== "object" || res === null) return res;
        const r = res as { message?: unknown; ambiguous_match?: boolean };
        if (r.ambiguous_match) return res; // already annotated
        const note = `\n\n⚠ selector matched ${prep.match_count} elements — this call resolved to the first (nth=${msg.nth ?? 1}). Other matches: ${(prep.other_matches ?? []).join("; ") || "(none captured)"}. Duplicate/repeated elements on the page mean this may have targeted the wrong copy — verify the result, or re-issue with within_selector/near_text/nth to disambiguate.`;
        return {
          ...r,
          message: typeof r.message === "string" ? r.message + note : r.message,
          ambiguous_match: true,
          match_count: prep.match_count,
          other_matches: prep.other_matches,
        };
      };

      // Wrap the entire post-prep flow in an outer withDebugger when CDP is
      // available, so the beforeunload listener registered inside stays armed
      // across the activity probe and fallback chain. When CDP isn't usable
      // (chrome:// pages, missing coords), run the flow without an attach.
      if (canCdp) {
        return await withDebugger(tabId, async () => {
          const buCtx = await armBeforeunloadDismissOnAttachedTab(tabId);
          try {
            return withAmbiguityNote(await runClickFlow());
          } finally {
            buCtx.release();
          }
        });
      }
      return withAmbiguityNote(await runClickFlow());
}
