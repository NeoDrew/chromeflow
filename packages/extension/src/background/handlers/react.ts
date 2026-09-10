// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, forwardToContentScript, resolvePostClickTab } from "../state";
import { phaseRace, dispatchHumanMouseClick } from "../cdp";
import { isScriptableUrl } from "../policy";
import { handleTypeText } from "./type";

export async function handleClickAtCoordinates(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      const before_url = tab.url ?? "";
      const x = Math.round(msg.x as number);
      const y = Math.round(msg.y as number);
      const button = (msg.button as "left" | "right" | "middle" | undefined) ?? "left";
      const double = msg.double === true;

      if (!isScriptableUrl(tab.url)) {
        return {
          type: "click_at_coordinates_response",
          requestId: msg.requestId,
          success: false,
          message: `Cannot click on ${tab.url} (non-scriptable URL — chrome://, devtools, etc.)`,
          before_url,
          after_url: before_url,
          navigated: false,
        };
      }
      // Cheap viewport sanity check: a click at (-50, 5000) is almost
      // certainly a coordinate-space mix-up. We don't know the actual viewport
      // size from background but we can spot obviously-bad values.
      if (x < 0 || y < 0 || x > 10000 || y > 10000) {
        return {
          type: "click_at_coordinates_response",
          requestId: msg.requestId,
          success: false,
          message: `click_at_coordinates refused: (${x}, ${y}) is outside any plausible viewport. Coordinates must be viewport CSS pixels relative to the active tab; list_frames reports each iframe at (x, y, width, height) in this space.`,
          before_url,
          after_url: before_url,
          navigated: false,
        };
      }

      let fallbackNote = "";
      // Set right after the real mousePressed/mouseReleased land — phaseRace
      // can't cancel the underlying dispatch, so if it loses the race on a
      // slow-but-not-actually-dead CDP round trip, this flag is how the catch
      // block below tells "real click landed late" apart from "truly dead"
      // and avoids firing a second, synthetic click at the same target.
      let realClickLanded = false;
      try {
        await phaseRace("cdp_click_at", 8000, dispatchHumanMouseClick(tabId, x, y, {
          button, double, onPressReleaseComplete: () => { realClickLanded = true; },
        }));
      } catch (e) {
        if (realClickLanded) {
          // The real click fired before we gave up waiting — only the
          // trailing settle jitter was slow. Treat as a normal success
          // instead of risking a double-click via the fallback below.
          await new Promise((r) => setTimeout(r, 250));
          const postTab = await resolvePostClickTab(port, tab.windowId!);
          const after_url = postTab?.url ?? before_url;
          return {
            type: "click_at_coordinates_response",
            requestId: msg.requestId,
            success: true,
            message: `Clicked at (${x}, ${y})${double ? " double-click" : ""}${button !== "left" ? ` button=${button}` : ""}${after_url !== before_url ? ` — navigated to ${after_url}` : ""} (CDP settle phase ran past its budget after the click itself landed, so this took longer than usual)`,
            before_url,
            after_url,
            navigated: after_url !== before_url,
          };
        }
        const err = e as Error & { phase?: string; phaseTimedOut?: boolean };
        // CDP attach/dispatch failed or timed out — most commonly the
        // debugger session silently died mid-run (see
        // ISSUE-2026-07-15-cdp-input-dead.md: the tab's chrome.debugger
        // attachment can go dead without any visible symptom until the next
        // command hangs). Unlike click_element, this tool has no selector to
        // hand off to a content-script click, so the fallback has to be
        // coordinate-based: ask the page itself what's at (x, y) and .click()
        // it directly via chrome.scripting (no debugger involved at all,
        // so it's unaffected by whatever wedged the CDP session).
        try {
          const r = await chrome.scripting.executeScript({
            target: { tabId },
            func: (cx: number, cy: number) => {
              const el = document.elementFromPoint(cx, cy) as HTMLElement | null;
              if (!el) return { ok: false, reason: "no element at that point" };
              el.click();
              return { ok: true, tag: el.tagName.toLowerCase() };
            },
            args: [x, y],
          });
          const res = r[0]?.result as { ok: boolean; reason?: string; tag?: string } | undefined;
          if (!res?.ok) {
            return {
              type: "click_at_coordinates_response",
              requestId: msg.requestId,
              success: false,
              message: `click_at_coordinates failed at (${x}, ${y}): CDP click ${err.phaseTimedOut ? `timed out after its ${err.phase} budget` : `errored (${err.message})`}, and the synthetic elementFromPoint fallback found ${res?.reason ?? "nothing there either"}.`,
              before_url,
              after_url: before_url,
              navigated: false,
            };
          }
          // isTrusted=false — strict anti-bot sites (Reddit/X/mcp.so-style
          // submit gates) will likely still reject this; it exists so the
          // caller isn't left with a bare timeout on ordinary pages (cross-
          // origin iframe targets, canvas elements) where a plain click
          // suffices.
          fallbackNote = ` (CDP click ${err.phaseTimedOut ? "timed out" : "failed"}; used a synthetic .click() on the <${res.tag}> at that point instead — isTrusted=false, may not pass strict anti-bot checks)`;
        } catch (fallbackErr) {
          return {
            type: "click_at_coordinates_response",
            requestId: msg.requestId,
            success: false,
            message: `click_at_coordinates failed at (${x}, ${y}): CDP click ${err.phaseTimedOut ? `timed out after its ${err.phase} budget` : `errored (${err.message})`}, and the synthetic fallback also failed: ${(fallbackErr as Error).message}`,
            before_url,
            after_url: before_url,
            navigated: false,
          };
        }
      }

      // Brief settle so navigations and modal openings register before we
      // read after_url. Don't run the full activity probe — coordinate
      // clicks frequently target cross-origin iframes whose state changes
      // are invisible to the parent.
      await new Promise((r) => setTimeout(r, 250));
      const postTab = await resolvePostClickTab(port, tab.windowId!);
      const after_url = postTab?.url ?? before_url;
      return {
        type: "click_at_coordinates_response",
        requestId: msg.requestId,
        success: true,
        message: `Clicked at (${x}, ${y})${double ? " double-click" : ""}${button !== "left" ? ` button=${button}` : ""}${after_url !== before_url ? ` — navigated to ${after_url}` : ""}${fallbackNote}`,
        before_url,
        after_url,
        navigated: after_url !== before_url,
      };
}

export async function handleReactSetInput(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      if (!isScriptableUrl(tab.url)) {
        return { type: "action_done", requestId: msg.requestId, success: false, message: `Cannot run on ${tab.url}` };
      }

      const selector = msg.selector as string;
      const value = msg.value as string;
      const frameSelector = msg.frame as string | undefined;
      const nth = typeof msg.nth === "number" && msg.nth >= 1 ? msg.nth : 1;

      // Tag the element in the content script first (queryAllDeep pierces
      // open AND closed shadow roots). The MAIN-world script then reads by
      // tag attribute. Top-frame only — same-origin iframe access is still
      // routed through doc.querySelector below since the content script
      // doesn't run inside iframe documents.
      const tagId = `chromeflow-react-target-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      let taggedInShadow = false;
      let ambiguousMatch = false;
      let matchCount: number | undefined;
      // Tracks whether the content script's tag actually landed — only then
      // is [data-chromeflow-react-target="tagId"] guaranteed resolvable as an
      // escalation selector below (the iframe path and a failed tag both skip
      // it, in which case a native-setter mismatch just fails plainly rather
      // than escalating to a selector that wouldn't resolve to anything).
      let contentScriptTagged = false;
      if (!frameSelector) {
        try {
          const tagResult = await forwardToContentScript(tab, {
            type: "tag_for_react",
            requestId: msg.requestId + "-tag",
            selector,
            tagId,
            nth,
          }) as { tagged: boolean; in_shadow: boolean; ambiguous_match?: boolean; match_count?: number };
          if (tagResult?.tagged) {
            contentScriptTagged = true;
            taggedInShadow = !!tagResult.in_shadow;
            if (tagResult.ambiguous_match) {
              ambiguousMatch = true;
              matchCount = tagResult.match_count;
            }
          }
        } catch {
          // Tagging is best-effort; fall back to plain doc.querySelector below
          // if it failed (e.g. content script not loaded on this page).
        }
      }

      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (sel: string, val: string, frameSel: string | undefined, tag: string, nthArg: number) => {
          // Resolve the input — top-frame document by default, contentDocument
          // when frameSel is given (same-origin iframes only).
          let doc: Document = document;
          if (frameSel) {
            const iframe = document.querySelector(frameSel);
            if (!(iframe instanceof HTMLIFrameElement)) return { ok: false, reason: `iframe "${frameSel}" not found` };
            try {
              const fdoc = iframe.contentDocument;
              if (!fdoc) return { ok: false, reason: `iframe "${frameSel}" is cross-origin` };
              doc = fdoc;
            } catch {
              return { ok: false, reason: `iframe "${frameSel}" is cross-origin` };
            }
          }
          // Prefer the tag-based lookup when the content script tagged
          // something for us (closed-shadow-root reachable). Fall through to
          // plain querySelector when no tag was placed (iframe path, or
          // tagging failed).
          let el: Element | null = null;
          if (tag) {
            // Tag lookup walks open shadow roots only from MAIN world. The
            // content script already verified the element exists via
            // queryAllDeep, so we just need to find it in a re-attached form.
            const findTagged = (root: ParentNode): Element | null => {
              const direct = root.querySelector(`[data-chromeflow-react-target="${tag}"]`);
              if (direct) return direct;
              const all = root.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                const sr = (all[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                if (sr) {
                  const nested = findTagged(sr);
                  if (nested) return nested;
                }
              }
              return null;
            };
            el = findTagged(doc);
          }
          // fallbackMatchCount is only meaningful when the tag-based lookup
          // above didn't already resolve `el` (frame path, or tagging
          // failed) — that's the only case this querySelectorAll reflects
          // which element `el` ends up being.
          let fallbackMatchCount: number | undefined;
          if (!el) {
            const all = doc.querySelectorAll(sel);
            fallbackMatchCount = all.length;
            el = all[(nthArg >= 1 ? nthArg : 1) - 1] ?? null;
          }
          if (!el) return { ok: false, reason: `selector "${sel}" not found${frameSel ? ` inside iframe "${frameSel}"` : ""}` };

          // Use the prototype FROM THE INSTANCE so the setter is callable on
          // the input directly. Inputs hosted inside an iframe have their own
          // window.HTMLInputElement that differs from the outer one — calling
          // window.HTMLInputElement.prototype's value setter on them throws
          // "Illegal invocation". Object.getPrototypeOf(el) sidesteps that.
          if (!(el instanceof HTMLElement)) return { ok: false, reason: "selector matched a non-HTMLElement" };

          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, "value");
          if (!desc?.set) return { ok: false, reason: `element does not expose a value setter (tag=${el.tagName.toLowerCase()})` };

          (el as HTMLElement).focus();
          desc.set.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));

          // Deliberately NOT cleaning up the chromeflow tag here anymore — if
          // the read-back below shows the value didn't land, the caller needs
          // the tag to still be on the page to hand off
          // [data-chromeflow-react-target="tag"] as a stable escalation
          // selector for trusted keystrokes (see handleReactSetInput's
          // needsTrustedKeystrokes handling). The background handler cleans
          // it up itself once it knows whether escalation is needed.

          // Read back to confirm React accepted it
          const readBack = (el as unknown as { value?: unknown }).value;
          return {
            ok: true,
            reason: "set",
            tag: el.tagName.toLowerCase(),
            name: (el as HTMLInputElement).name ?? "",
            id: el.id ?? "",
            type: (el as HTMLInputElement).type ?? "",
            readBack: typeof readBack === "string" ? readBack : String(readBack),
            // Workday's (and similarly-built platforms') own component marker
            // — a structural signature, not a domain check, so this also
            // covers non-myworkdayjobs.com hosts running the same component
            // library (see ISSUE-2026-08-11-workday-fill-input-not-binding.md).
            // Only meaningful combined with a mismatch on read-back below;
            // presence alone does NOT mean escalation is needed (some tenants
            // are the opposite: native setter works, keystrokes get dropped).
            hasWorkdayMarker: !!(el.closest && el.closest("[data-automation-id]")),
            ...(fallbackMatchCount && fallbackMatchCount > 1 ? { fallback_match_count: fallbackMatchCount } : {}),
          };
        },
        args: [selector, value, frameSelector, tagId, nth],
      });

      const result = r[0]?.result as
        | { ok: false; reason: string }
        | { ok: true; reason: string; tag: string; name: string; id: string; type: string; readBack: string; fallback_match_count?: number; hasWorkdayMarker?: boolean }
        | undefined;
      if (!result) return { type: "action_done", requestId: msg.requestId, success: false, message: "no response from page" };
      if (!result.ok) return { type: "action_done", requestId: msg.requestId, success: false, message: result.reason };

      let accepted = result.readBack === value;
      let normalizedNote = "";
      if (!accepted) {
        // Same false-negative as fill_input's textHint path: a controlled
        // `value={n || ""}` renders 0 as empty, and number inputs reformat
        // ("0.50" -> "0.5"). Both mean the value WAS accepted.
        const writtenNum = Number(value);
        const readNum = Number(result.readBack);
        const isZeroWrite = value.trim() !== "" && writtenNum === 0;
        if (isZeroWrite && (result.readBack === "" || readNum === 0)) {
          accepted = true;
          normalizedNote = result.readBack === "" ? " (wrote 0; field renders zero as empty, accepted as 0)" : "";
        } else if (result.readBack !== "" && !Number.isNaN(writtenNum) && !Number.isNaN(readNum) && writtenNum === readNum) {
          accepted = true;
          normalizedNote = ` (normalised "${value}" → "${result.readBack}")`;
        }
      }

      // Selector-mode equivalent of fill_input(textHint mode)'s Workday
      // auto-escalation (see checkTrustedKeystrokeEscalation in content/
      // fill.ts and ISSUE-2026-08-11-workday-fill-input-not-binding.md) —
      // previously MISSING entirely from this path, which forced callers on
      // duplicate-id pages (where selector mode + nth-of-type scoping is the
      // only way to hit a SPECIFIC instance) to choose between disambiguation
      // and Workday-binding protection. Only fires after a VERIFIED mismatch,
      // never on marker-presence alone (some tenants are the opposite: native
      // setter works, keystrokes get dropped — see ISSUE-2026-08-15-antibot-
      // tenant-walls.md). Escalates via the same tag attribute already used
      // to resolve `el`, not a fresh id/name-derived selector, so it can't
      // regress into the exact duplicate-id ambiguity this was built to avoid.
      let escalated = false;
      let escalationMessage = "";
      // Mirrors handleFillInput's convention (background/handlers/type.ts):
      // when escalation isn't attempted at all, `accepted` staying false still
      // reports success:true with a soft warning in the message (a non-Workday
      // normalisation mismatch is common and a hard failure there would be
      // worse than a clearly-worded uncertain success) — only an ATTEMPTED
      // escalation's own verified outcome should flip success to false.
      let finalSuccess = true;
      if (!accepted && result.hasWorkdayMarker && contentScriptTagged) {
        const retyped = await handleTypeText(
          { ...msg, text: value, into_selector: `[data-chromeflow-react-target="${tagId}"]`, clear_first: true },
          port,
        ) as { success: boolean; landed?: boolean; message: string };
        escalated = true;
        accepted = retyped.success;
        finalSuccess = retyped.success;
        escalationMessage = ` Escalated to trusted keystrokes: ${retyped.message}`;
      }
      // Clean up the tag now that both the native-setter attempt and any
      // escalation (which resolves through the same attribute) are done.
      if (contentScriptTagged) {
        await chrome.scripting.executeScript({
          target: { tabId },
          world: "MAIN",
          func: (tag: string) => {
            const el = document.querySelector(`[data-chromeflow-react-target="${tag}"]`);
            try { el?.removeAttribute("data-chromeflow-react-target"); } catch { /* ignore */ }
          },
          args: [tagId],
        }).catch(() => {});
      }

      const desc = `<${result.tag}${result.type ? ` type="${result.type}"` : ""}${result.name ? ` name="${result.name}"` : ""}${result.id ? ` id="${result.id}"` : ""}>`;
      const shadowNote = taggedInShadow ? " (resolved inside shadow DOM)" : "";
      const effectiveMatchCount = matchCount ?? result.fallback_match_count;
      const isAmbiguous = ambiguousMatch || (result.fallback_match_count ?? 0) > 1;
      const ambiguousNote = isAmbiguous
        ? `\n\n⚠ selector "${selector}" matched ${effectiveMatchCount} elements — set nth=${nth}. Duplicate elements sharing this selector (e.g. a page rendering two copies of the same form, see ISSUE-2026-09-10-workday-duplicate-id-colliding-create-account-form.md) mean this may have landed in the wrong copy if nth wasn't deliberately chosen. Verify the result, or pass nth=1..${effectiveMatchCount} to target a specific one.`
        : "";
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: finalSuccess,
        message: (accepted
          ? `Set ${desc} to "${value.slice(0, 60)}"${frameSelector ? ` (inside iframe "${frameSelector}")` : ""}${shadowNote}${normalizedNote}${escalationMessage}`
          : `Set ${desc} via native setter, but React reported back "${result.readBack.slice(0, 60)}" — the page may be controlling the value externally.${shadowNote}${escalationMessage}`) + ambiguousNote,
        ...(isAmbiguous ? { ambiguous_match: true, match_count: effectiveMatchCount } : {}),
        ...(escalated ? { escalated_to_trusted_keystrokes: true } : {}),
      };
}

export async function handleReactCallProp(msg: McpMsg, port: number): Promise<unknown> {
      const tab = await getActiveTab(port);
      const tabId = tab.id!;
      if (!isScriptableUrl(tab.url)) {
        return { type: "action_done", requestId: msg.requestId, success: false, message: `Cannot run on ${tab.url}` };
      }

      const selector = msg.selector as string;
      const propName = msg.prop_name as string;
      const args = (msg.args ?? []) as unknown[];
      const maxDepth = (msg.max_depth ?? 30) as number;
      const frameSelector = msg.frame as string | undefined;

      // Tag-from-content-script + read-from-main-world so closed shadow root
      // selectors work. Iframe path skips tagging since the content script
      // runs against the top frame only.
      const tagId = `chromeflow-react-target-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      if (!frameSelector) {
        try {
          await forwardToContentScript(tab, {
            type: "tag_for_react",
            requestId: msg.requestId + "-tag",
            selector,
            tagId,
          });
        } catch { /* best-effort */ }
      }

      const r = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (sel: string, pName: string, callArgs: unknown[], depth: number, frameSel: string | undefined, tag: string) => {
          let doc: Document = document;
          if (frameSel) {
            const iframe = document.querySelector(frameSel);
            if (!(iframe instanceof HTMLIFrameElement)) return { ok: false, reason: `iframe "${frameSel}" not found` };
            try {
              const fdoc = iframe.contentDocument;
              if (!fdoc) return { ok: false, reason: `iframe "${frameSel}" is cross-origin` };
              doc = fdoc;
            } catch {
              return { ok: false, reason: `iframe "${frameSel}" is cross-origin` };
            }
          }
          let el: Element | null = null;
          if (tag) {
            const findTagged = (root: ParentNode): Element | null => {
              const direct = root.querySelector(`[data-chromeflow-react-target="${tag}"]`);
              if (direct) return direct;
              const all = root.querySelectorAll('*');
              for (let i = 0; i < all.length; i++) {
                const sr = (all[i] as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
                if (sr) {
                  const nested = findTagged(sr);
                  if (nested) return nested;
                }
              }
              return null;
            };
            el = findTagged(doc);
            if (el) {
              try { el.removeAttribute("data-chromeflow-react-target"); } catch { /* ignore */ }
            }
          }
          if (!el) el = doc.querySelector(sel);
          if (!el) return { ok: false, reason: `selector "${sel}" not found${frameSel ? ` inside iframe "${frameSel}"` : ""}` };

          const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
          if (!fiberKey) return { ok: false, reason: `no React fiber on element matched by "${sel}" — is this a React app?` };

          let cur = (el as unknown as Record<string, unknown>)[fiberKey] as
            | { memoizedProps?: Record<string, unknown>; type?: unknown; return?: unknown }
            | null
            | undefined;

          for (let i = 0; i < depth && cur; i++) {
            const props = cur.memoizedProps;
            const fn = props?.[pName];
            if (typeof fn === "function") {
              const t = cur.type as { displayName?: string; name?: string } | string | undefined;
              const componentName =
                (typeof t === "string" ? t : null) ||
                (t && typeof t === "object" ? (t.displayName || t.name) : null) ||
                "anonymous";
              try {
                const ret = await Promise.resolve((fn as (...a: unknown[]) => unknown)(...callArgs));
                let returned: string;
                if (ret === undefined) returned = "undefined";
                else if (ret === null) returned = "null";
                else if (typeof ret === "object") {
                  try {
                    returned = JSON.stringify(ret).slice(0, 200);
                  } catch {
                    returned = "[object]";
                  }
                } else {
                  returned = String(ret).slice(0, 200);
                }
                return {
                  ok: true,
                  depth: i,
                  componentName,
                  returned,
                };
              } catch (err) {
                const e = err as Error;
                return {
                  ok: false,
                  reason: `prop "${pName}" threw: ${e?.message ?? String(err)}`,
                  depth: i,
                  componentName,
                };
              }
            }
            cur = cur.return as typeof cur;
          }
          return { ok: false, reason: `no prop "${pName}" found within ${depth} fiber levels`, walked: depth };
        },
        args: [selector, propName, args, maxDepth, frameSelector, tagId],
      });

      const result = r[0]?.result as
        | { ok: false; reason: string; depth?: number; walked?: number; componentName?: string }
        | { ok: true; depth: number; componentName: string; returned: string }
        | undefined;
      if (!result) return { type: "action_done", requestId: msg.requestId, success: false, message: "no response from page" };
      if (!result.ok) {
        const where = result.depth !== undefined
          ? ` (at fiber depth ${result.depth}${result.componentName ? ` in <${result.componentName}>` : ""})`
          : result.walked !== undefined ? ` (walked ${result.walked} levels)` : "";
        return { type: "action_done", requestId: msg.requestId, success: false, message: `${result.reason}${where}` };
      }
      return {
        type: "action_done",
        requestId: msg.requestId,
        success: true,
        message: `Called ${propName}(...) on <${result.componentName}> at fiber depth ${result.depth}. Return: ${result.returned}`,
      };
}
