import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerInputTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "fill_input",
    `Fill a form input by visible label / placeholder / aria-label (\`textHint\`) OR by direct CSS selector (\`selector\`). Pass exactly one.

\`textHint\` mode: fuzzy-rank against label/placeholder/aria-label/name/id. Response includes the matched element's identifying attributes and match-strength (aria-eq, placeholder-eq, label-text-eq, name-eq, id-eq, *-includes, fuzzy-text-walk). Verify the match — fuzzy-text-walk is the lowest-confidence kind. Pass \`exact: true\` to refuse fuzzy and *-includes matches.

\`selector\` mode (replaces the old react_set_input): targets the input directly and routes through the React-aware native value-setter so React's onChange picks up the change. Handles same-origin iframe inputs via \`frame\`.

Works on React-controlled inputs, contenteditable (Stripe, Notion), and CodeMirror 6 editors. Use \`nth\` (1-based) when multiple inputs share the same label (textHint mode) or when a selector resolves to more than one element (selector mode, e.g. two duplicate elements sharing an id, see ISSUE-2026-09-10-workday-duplicate-id-colliding-create-account-form.md). A selector-mode call that resolves to 2+ elements reports match_count and other candidates in the response instead of silently picking the first.

**Workday auto-escalation** (textHint mode): fill_input always tries the native-setter fill first and reads the value back. On fields marked with Workday's \`data-automation-id\` convention where that read-back genuinely fails, it transparently re-enters the value via trusted keystrokes instead, same mechanism as type_text — the response message says "Escalated to trusted keystrokes" when this fires. This is a per-tenant behavior, not a per-platform one: on some anti-bot-hardened tenants it's the OPPOSITE (native setter lands, trusted keystrokes get dropped) — which is exactly why escalation only fires after a verified failure, never on marker-presence alone.`,
    {
      textHint: z.string().optional().describe("Label / placeholder / aria-label identifying the input. Exactly one of textHint or selector must be set."),
      selector: z.string().optional().describe("CSS selector of the input (e.g. 'input[name=email]'). Bypasses fuzzy matching."),
      value: z.string().describe("Value to fill"),
      nth: z.number().int().min(1).optional().describe("Which match to fill when multiple candidates match (1 = first, default 1). Works in both textHint mode (multiple inputs sharing a label) and selector mode (a selector resolving to 2+ elements)."),
      exact: z.boolean().optional().describe("Refuse fuzzy text-walk and *-includes matches. textHint mode only. Default false."),
      frame: z.string().optional().describe("Same-origin iframe CSS selector for selector-mode targeting of inputs inside an iframe."),
    },
    async ({ textHint, selector, value, nth, exact, frame }) => {
      if (!textHint && !selector) {
        return { content: [{ type: "text", text: "fill_input requires either textHint or selector." }] };
      }
      if (textHint && selector) {
        return { content: [{ type: "text", text: "fill_input: pass textHint OR selector, not both." }] };
      }
      if (selector) {
        // Pass "" instead of undefined for frame — chrome.scripting.executeScript
        // rejects `undefined` in args as unserializable. The extension handler
        // treats empty string as falsy (no iframe), same as undefined.
        const response = await bridge.request({ type: "react_set_input", selector, value, frame: frame ?? "", nth });
        const r = response as { success?: boolean; message?: string };
        if (!r.success) {
          const workaround =
            `\n\nWorkaround when selector-mode keeps failing:\n` +
            `  1. click_element("<visible label or selector text>") to focus the input.\n` +
            `  2. type_text("${value.slice(0, 40)}") via trusted keyboard events.\n` +
            `Or for React/CodeMirror/contenteditable that ignores synthetic events, drop into execute_script with the React-aware native value-setter (see CLAUDE.md → React Select recipes).`;
          return { content: [{ type: "text", text: `Failed to set "${selector}": ${r.message ?? "unknown"}${workaround}` }] };
        }
        return { content: [{ type: "text", text: r.message ?? `Set "${selector}"` }] };
      }
      const response = await bridge.request({ type: "fill_input", textHint: textHint!, value, nth, exact });
      if (response.type !== "fill_response") throw new Error("Unexpected response");
      const r = response as { success: boolean; message: string; landed?: boolean };
      if (!r.success) {
        // When the extension already escalated to trusted keystrokes and
        // THAT failed too (r.landed === false), the usual "click_element
        // then type_text" workaround suggests retrying the exact mechanism
        // that was just attempted — confusing, not helpful. Point at the
        // real remedy for a degraded CDP Input layer instead.
        const workaround = r.landed === false
          ? `\n\nThis field already escalated to trusted keystrokes internally and that ALSO failed to land — retrying type_text on it directly will likely hit the same wall. This usually means the CDP Input layer itself is degraded (see ISSUE-2026-07-15-cdp-input-dead.md): try execute_script with the native value-setter as a diagnostic, or reload the chromeflow extension if this persists across fields.`
          : `\n\nWorkaround when textHint-mode keeps failing:\n` +
            `  1. find_input("${textHint}") to confirm the field exists and see its exact label.\n` +
            `  2. click_element("${textHint}") to focus it, then type_text("${value.slice(0, 40)}").\n` +
            `Or pass selector="<css>" instead of textHint to bypass fuzzy matching entirely.`;
        return { content: [{ type: "text", text: `Could not fill "${textHint}": ${r.message}${workaround}` }] };
      }
      return {
        content: [{ type: "text", text: `Filled "${textHint}": ${r.message}` }],
      };
    }
  );
}
