import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";
import { FlowStore, isFragileSelector, type Atom } from "../../flow-store.js";

export function registerClickTools(server: McpServer, bridge: WsBridge, flowStore: FlowStore) {
  server.tool(
    "click_element",
    `Click an interactive element by its visible text/aria-label (textHint) OR by direct CSS selector (selector). Pass exactly one.

\`textHint\` mode: fuzzy-rank against visible text, aria-label, button content. Ranks visible candidates ahead of hidden.

\`selector\` mode: pierces open AND closed shadow roots via queryAllDeep. Use when the target has no visible text (icon buttons, custom-element placeholders like Reddit's collapsed comment composer, drop-zone overlays). Skips the textHint matcher entirely. \`nth\` still picks the Nth match.

Optionally pass an until_* clause to verify the click took effect:
- until_selector — CSS selector that should appear after the click
- until_url_contains — substring that should appear in the URL (requires an actual URL change if the substring was already in the pre-click URL)
- until_text_contains — substring that should appear in page text
- until_url_changes — ANY URL change (use for submits where the destination URL is unknown ahead of time)
- expect_submit — broad anti-bot detector for form submissions (toast, alert, modal, URL change, form removal). See note below.

Returns {success, message, before_url, after_url, navigated}. \`navigated\` is true when the post-click URL differs from the pre-click URL — surfaces silent redirects without a second list_tabs call. Refuses to click 0×0 elements and now ranks visible candidates above hidden when text/aria match; when forced to refuse a hidden element it surfaces the next visible candidate in the error message.

Scope matching with \`within_selector\` or \`near_text\` restricts where matches are searched — useful for long forms with repeated labels per section (e.g. one "Approve" radio per row). \`within_selector\` is a CSS selector; \`near_text\` finds the nearest container whose heading starts with the given text.

Shadow DOM (open AND closed) is pierced by default via chrome.dom.openOrClosedShadowRoot — Reddit faceplate-* / r-post-form-submit-button / web-component-heavy SPAs no longer need manual deepFind recipes.

ANTI-BOT SUBMIT CEILING — synthetic clicks on social/auth platforms (Reddit, X / Twitter, mcp.so) are silently rejected by isTrusted-aware form validators and CSRF/reCAPTCHA gates. Pass \`expect_submit: true\` to detect this case (returns success=false with "submit silently rejected" when no signal fires within 4s). For confirmed anti-bot sites, do NOT retry — pre-fill the form and retry once with \`try_fiber: true\`; if it's still rejected, most sessions run unattended, so report the rejection rather than reaching for highlight_region + wait_for_click. Only use that pairing when a human is actually present for this session.`,
    {
      textHint: z
        .string()
        .optional()
        .describe(
          "The visible label of the button or link (e.g. 'Save product', 'Continue', 'Add a product', 'Create'). Exactly one of textHint or selector must be set."
        ),
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector for the element to click (e.g. 'faceplate-textarea-input', '#open-composer', 'button[aria-label=\"More options\"]'). Pierces open AND closed shadow roots via queryAllDeep. Use when the target has no usable text. Exactly one of textHint or selector must be set."
        ),
      nth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Which match to click when multiple elements share the same label (1 = first/topmost, default 1). Visible candidates are ranked above hidden, so a hidden flair-dropdown won't claim nth=1 over the visible submit button."),
      until_selector: z
        .string()
        .optional()
        .describe('Wait until this CSS selector appears on the page after the click (e.g. ".success-toast"). Returns success=false if it does not appear within until_timeout_ms.'),
      until_url_contains: z
        .string()
        .optional()
        .describe('Wait until the URL contains this substring after the click (e.g. "/checkout/complete"). If the substring was already in the pre-click URL, requires the URL to actually change before matching — prevents false positives on intra-prefix navigation like /tasks/OLD → /tasks/NEW with until_url_contains="tasks/".'),
      until_text_contains: z
        .string()
        .optional()
        .describe('Wait until the visible page text contains this substring after the click (e.g. "Listing published"). Returns success=false if it does not.'),
      until_url_changes: z
        .boolean()
        .optional()
        .describe('Wait until the URL changes after the click — for navigating submits whose destination URL is unknown ahead of time. Succeeds on any change away from the pre-click URL. Combine with until_url_contains for "must change AND must contain X".'),
      until_timeout_ms: z
        .number()
        .int()
        .min(500)
        .optional()
        .describe("How long to wait for the until-condition, in milliseconds (default 5000). Only used if one of until_* is set."),
      expect_submit: z
        .boolean()
        .optional()
        .describe('Broad anti-bot detector. After the click, watch up to 4s for ANY of: URL change, [role=alert] / [data-sonner-toast] / .toast / .notification / aria-live appearance, [role=dialog] / [aria-modal=true] appearance. Returns success=false with "submit silently rejected (likely anti-bot)" when no signal fires. Use on form submits when the until_* destination isn\'t known. Ignored when any until_* is set (those are more specific).'),
      within_selector: z
        .string()
        .optional()
        .describe('Limit candidate matches to this CSS selector\'s subtree (mirrors find_text\'s scope_selector). Use to scope nth-counting to one section of a long form: click_element("Approve", nth=1, within_selector="#section-b"). Returns success=false with scope_missed=true if the selector does not match.'),
      near_text: z
        .string()
        .optional()
        .describe('Find the nearest container whose heading starts with this text, then scope candidates to that container\'s subtree. Ignored when within_selector is set. Useful when the target section has no stable CSS selector but the heading is unique.'),
      try_fiber: z
        .boolean()
        .optional()
        .describe(`Opt-in last-resort fallback when silently_rejected fires. After the activity probe reports zero activity, chromeflow walks the React fiber tree from the already-matched element (up to 12 levels, in the page's own MAIN world so it can actually see React's internal props) checking for \`onClick\`, then \`onMouseDown\`, then \`onPointerDown\` — the last two matter for listbox/combobox option rows (react-select, downshift, Radix Combobox, Workday's multiselect prompt widget), which commonly bind selection on mousedown specifically to survive a "blur closes the list" race — and invokes whichever is found with a minimal synthetic event. Reaches elements inside OPEN shadow roots; a closed-shadow target reports not-found rather than misfiring. Returns fiber_attempted=true in the response when the path was taken. Do NOT default to this; reserve for repeat silently_rejected on a known-safe React site, or for listbox/combobox options where the CDP click cascade risks losing the race against the list closing (use via="fiber" there to skip straight to it).`),
      activity_timeout_ms: z
        .number()
        .int()
        .min(500)
        .optional()
        .describe(`How long the activity probe watches for DOM mutations, focus changes, URL changes, or alert/toast/modal appearance after the click (default 1500ms). The probe returns early as soon as activity is detected, so the default adds only ~100ms on successful clicks. Increase to 2500-4000ms for buttons that trigger async API calls before producing visible DOM changes. The probe reports "silently_rejected" when zero activity is seen within this window; a higher value reduces false negatives but slows genuine rejection detection. For buttons where the click triggers a 3-5s API call with no immediate DOM change, use skip_activity_probe instead.`),
      skip_activity_probe: z
        .boolean()
        .optional()
        .describe(`Skip the 1500ms activity probe AND all automatic fallbacks (tap gesture, pointer chain, DOM .click(), fiber walk) after the CDP click. The click is dispatched and success is returned immediately without verifying page activity. Use for buttons that trigger slow async API calls (3-5s+) before producing visible DOM changes, where the activity probe would falsely report "silently_rejected" and the fallback chain would double-fire. Verify state yourself via find_text or execute_script after an appropriate delay. NOTE: this is set IMPLICITLY when any until_* clause is passed, since the until-clause already provides verification. WARNING: no automatic silent-rejection detection when this is set without an until-clause.`),
      via: z
        .enum(["auto", "cdp", "fiber"])
        .optional()
        .describe(`Click dispatch mode. "auto" (default): CDP click, then fiber fallback when try_fiber=true and the activity probe failed. "cdp": CDP click only, no fiber fallback ever. "fiber": skip the CDP bezier + activity probe entirely and invoke the element's onClick/onMouseDown/onPointerDown fiber prop directly. Use "fiber" on React-heavy SPAs (fiber-only annotation dashboards) where you already know the site is fiber-only, and especially on listbox/combobox options (a real CDP click risks losing the race against the list closing before the option's own handler fires) — cuts ~3 seconds of ceremony off the round trip either way. The fiber path is undocumented React internal access, prefer "auto" until you've confirmed the site needs it.`),
      in_dialog: z
        .boolean()
        .optional()
        .describe(`Scope candidate matches to the topmost open dialog (\`[role=dialog]\`, \`[role=alertdialog]\`, or \`<dialog open>\`), highest z-index wins. Use when Radix/Headless UI dialogs portal to document.body and a generic textHint like "Cancel" would otherwise match the wrong button. Returns scope_missed=true when no dialog is open.`),
      dialog_query: z
        .string()
        .optional()
        .describe(`Scope candidate matches to a specific dialog by heading or aria-label substring. Use when multiple dialogs are open and in_dialog (topmost) would pick the wrong one — e.g. click_element("Confirm", dialog_query="Delete account"). Mutually exclusive with in_dialog; dialog_query wins when both are set.`),
      wait_until_enabled_ms: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(`When the matched target is currently disabled (native disabled OR aria-disabled=true), poll for up to this many ms waiting for it to become enabled before clicking. Default 0 (do not wait — return target_disabled immediately). Use 2000-5000 for Submit-style buttons that briefly disable while an async copilot/validator/save is in flight. On timeout the response carries target_disabled=true plus a structured disabled_state snapshot (disabled, aria_disabled, pointer_events, opacity, visible) so the caller can decide between "wait more" or "field is genuinely missing — run get_form_fields(only_empty:true)".`),
    },
    async ({ textHint, selector, nth, until_selector, until_url_contains, until_text_contains, until_url_changes, until_timeout_ms, expect_submit, within_selector, near_text, try_fiber, activity_timeout_ms, skip_activity_probe, via, in_dialog, dialog_query, wait_until_enabled_ms }) => {
      // Validate exactly-one-of(textHint, selector)
      if ((!textHint && !selector) || (textHint && selector)) {
        return {
          content: [{ type: "text", text: "click_element requires exactly one of textHint or selector" }],
        };
      }
      // Identifier for error messages (which one the caller passed)
      const targetLabel = textHint ?? `selector="${selector}"`;
      // The WS request must outlive the until-poll, with a buffer for navigation.
      const wsTimeout = Math.max(30_000, (until_timeout_ms ?? 0) + 10_000);
      let response;
      try {
        response = await bridge.request(
          { type: "click_element", textHint, selector, nth, until_selector, until_url_contains, until_text_contains, until_url_changes, until_timeout_ms, expect_submit, within_selector, near_text, try_fiber, activity_timeout_ms, skip_activity_probe, via, in_dialog, dialog_query, wait_until_enabled_ms },
          wsTimeout
        );
      } catch (err) {
        const errMsg = (err instanceof Error ? err.message : String(err));
        if (errMsg.includes("timed out")) {
          // Best-effort: ask the extension where the active tab is now. The
          // click handler may still be running, but a parallel list_tabs
          // request usually returns. If we see a URL, surface it — the agent
          // can decide whether the click actually landed.
          let stateLine = "";
          try {
            const tabsResp = await bridge.request({ type: "list_tabs" }, 3_000);
            const activeTab = (tabsResp as { tabs?: Array<{ url?: string; active?: boolean }> }).tabs?.find((t) => t.active);
            if (activeTab?.url) stateLine = `\nCurrent URL: ${activeTab.url}`;
          } catch { /* extension still busy or disconnected */ }
          return {
            content: [
              {
                type: "text",
                text: `Could not confirm click on "${targetLabel}": ${errMsg}. The click MAY have already fired — the page just took longer than ${wsTimeout}ms to respond. Verify with get_page_text or wait_for_selector before retrying. Re-clicking can toggle the wrong way on React-controlled radios.${stateLine}`,
              },
            ],
          };
        }
        return {
          content: [
            { type: "text", text: `Could not click "${targetLabel}": ${errMsg}` },
          ],
        };
      }
      const r = response as {
        success: boolean;
        message: string;
        before_url?: string;
        after_url?: string;
        navigated?: boolean;
        scope_missed?: boolean;
        silently_rejected?: boolean;
        fiber_attempted?: boolean;
        recovered_via?: string;
        request_in_flight?: boolean;
        focused_after?: {
          tag: string;
          id: string;
          name: string;
          type: string;
          aria_label: string;
          value_preview: string;
        } | null;
      };
      // Surface silent redirects: a click whose post-URL differs from the
      // pre-URL is the canonical Canvas "Assessment link → course home" case.
      // Only emit the line when navigation actually happened so the
      // common-case output stays one line.
      const navLine = r.navigated && r.after_url ? `\n→ Navigated: ${r.after_url}` : "";
      // Surface focus landed after the click, so the agent knows whether to
      // chain type_text/fill_input on the same element. Omitted for radio /
      // checkbox / button targets where focus rarely lands on the focused
      // element of interest (and the line would be noise).
      let focusLine = "";
      const f = r.focused_after ?? null;
      if (f && !["button", "a"].includes(f.tag)) {
        const idBit = f.id ? `#${f.id}` : "";
        const nameBit = f.name ? ` name="${f.name}"` : "";
        const aria = f.aria_label ? ` aria-label="${f.aria_label.slice(0, 30)}"` : "";
        const valueBit = f.value_preview ? ` value="${f.value_preview.slice(0, 30)}"` : "";
        focusLine = `\n→ Focused: <${f.tag}${idBit}${nameBit}${aria}${valueBit}>`;
      }
      // Flow memory. Record this click as a notable "resolution" only when it
      // cost something to discover — a fallback fired (recovered_via) or it drove
      // a real navigation. A plain first-try click that merely carried an until_*
      // verification is NOT hard-won: rediscovery is free, and on high-cardinality
      // pages (search results, feeds) the selector embeds a per-instance literal
      // (e.g. a[aria-label="Invite <person> to connect"]) that can never recur, so
      // persisting it produces one dead provisional flow per action forever. Recall
      // surfaces known flows for the origin once per session; capturable nudges a save.
      // Key the atom to where the click HAPPENED (before_url), not where it
      // landed — a submit on /submit that navigates to the new post page must
      // be recalled next time we're on /submit, not on the post page.
      const actionUrl = r.before_url ?? r.after_url;
      const nowUrl = r.after_url ?? r.before_url;
      const usedUntil = !!(until_selector || until_url_contains || until_text_contains || until_url_changes);
      // The verification arg that proved this click took effect — persisted so
      // recall replays it (the agent re-confirms instead of re-discovering).
      const verification = until_url_changes ? "until_url_changes=true"
        : until_selector ? `until_selector=${JSON.stringify(until_selector)}`
        : until_url_contains ? `until_url_contains=${JSON.stringify(until_url_contains)}`
        : until_text_contains ? `until_text_contains=${JSON.stringify(until_text_contains)}`
        : expect_submit ? "expect_submit=true"
        : undefined;
      if (r.success && (r.recovered_via || r.navigated)) {
        flowStore.observe({
          tool: "click_element",
          target: textHint ?? `selector=${selector}`,
          selector,
          recovered_via: r.recovered_via,
          signal: r.navigated ? "navigated" : until_url_changes ? "until_url_change" : usedUntil ? "until_*" : r.recovered_via,
          verification,
          fragile: isFragileSelector(selector),
          reason: r.recovered_via ? `click recovered via ${r.recovered_via}` : "navigating submit/link",
        } as Atom, actionUrl);
      }
      flowStore.noteUrl(nowUrl);
      // Recall the flow for the page we ACTED on (before_url) first — that's the
      // page a known_flow is relevant to when the agent clicked without an
      // open_page (already-loaded page). Fall back to the destination. Both are
      // gated once-per-origin, so this can't double up with open_page/list_tabs.
      const recall = flowStore.recallHint(actionUrl) || flowStore.recallHint(nowUrl);
      const capturable = flowStore.capturableHint(actionUrl);

      if (!r.success) {
        // Failure feedback: if a step we RECALLED for this origin just failed on
        // replay, that's evidence the stored flow has drifted — ding it so a
        // repeatedly-broken flow self-prunes.
        flowStore.observeFailure(actionUrl, selector ?? textHint);
        return {
          content: [
            {
              type: "text",
              text: `Could not click "${targetLabel}": ${r.message}${navLine}${focusLine}${recall}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `${r.message}${navLine}${focusLine}${recall}${capturable}` }],
      };
    }
  );

  server.tool(
    "click_at_coordinates",
    `Dispatch a real CDP mouse click at viewport (x, y). The only way to interact with cross-origin iframes — \`click_element\` refuses cross-origin frames because \`find_text\` can't enter them, but a CDP-level mouse event resolves at the renderer process and reaches the iframe's content the way an OS-level click does.

Coordinates are viewport CSS pixels, NOT screen coordinates. \`list_frames\` reports each iframe at \`(x, y, width, height)\` in this same space, so to click 50px in / 80px down inside an iframe: \`click_at_coordinates(frame.x + 50, frame.y + 80)\`.

Runs the same humanlike sequence as \`click_element\` (bezier approach path, settle-hover micro-tremor, press, release, post-click micro-move) so behavioural fingerprinters can't distinguish the call from any other chromeflow click. Skips the activity probe — cross-origin iframe activity isn't observable from the parent.

Refuses obviously-bad coordinates (negative, > 10000). Use this only when DOM matching has failed and you have a known target position from \`list_frames\` or a screenshot.`,
    {
      x: z.number().describe("Viewport CSS X coordinate (left=0). Get from list_frames or a screenshot grid."),
      y: z.number().describe("Viewport CSS Y coordinate (top=0). Get from list_frames or a screenshot grid."),
      button: z.enum(["left", "right", "middle"]).optional().describe('Mouse button (default "left").'),
      double: z.boolean().optional().describe("Fire a double-click instead of a single click. Default false."),
    },
    async ({ x, y, button, double }) => {
      const response = await bridge.request({ type: "click_at_coordinates", x, y, button, double });
      const r = response as { success: boolean; message: string; before_url?: string; after_url?: string; navigated?: boolean };
      const navLine = r.navigated && r.after_url ? `\n→ Navigated: ${r.after_url}` : "";
      return { content: [{ type: "text", text: `${r.message}${navLine}` }] };
    }
  );
}
