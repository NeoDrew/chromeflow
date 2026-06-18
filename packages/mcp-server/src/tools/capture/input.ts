import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerInputTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "fill_input",
    `Fill a form input by visible label / placeholder / aria-label (\`textHint\`) OR by direct CSS selector (\`selector\`). Pass exactly one.

\`textHint\` mode: fuzzy-rank against label/placeholder/aria-label/name/id. Response includes the matched element's identifying attributes and match-strength (aria-eq, placeholder-eq, label-text-eq, name-eq, id-eq, *-includes, fuzzy-text-walk). Verify the match — fuzzy-text-walk is the lowest-confidence kind. Pass \`exact: true\` to refuse fuzzy and *-includes matches.

\`selector\` mode (replaces the old react_set_input): targets the input directly and routes through the React-aware native value-setter so React's onChange picks up the change. Handles same-origin iframe inputs via \`frame\`.

Works on React-controlled inputs, contenteditable (Stripe, Notion), and CodeMirror 6 editors. Use \`nth\` (1-based) when multiple inputs share the same label.`,
    {
      textHint: z.string().optional().describe("Label / placeholder / aria-label identifying the input. Exactly one of textHint or selector must be set."),
      selector: z.string().optional().describe("CSS selector of the input (e.g. 'input[name=email]'). Bypasses fuzzy matching."),
      value: z.string().describe("Value to fill"),
      nth: z.number().int().min(1).optional().describe("Which match to fill when multiple inputs share the same label (1 = first, default 1). textHint mode only."),
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
        const response = await bridge.request({ type: "react_set_input", selector, value, frame: frame ?? "" });
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
      const r = response as { success: boolean; message: string };
      if (!r.success) {
        const workaround =
          `\n\nWorkaround when textHint-mode keeps failing:\n` +
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
