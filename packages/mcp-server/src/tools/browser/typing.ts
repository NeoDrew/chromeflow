import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";
import { FlowStore, isFragileSelector, type Atom } from "../../flow-store.js";

export function registerTypingTools(server: McpServer, bridge: WsBridge, flowStore: FlowStore) {
  server.tool(
    "type_text",
    `Type text into the currently focused element via CDP keystrokes (produces isTrusted=true events). Use when fill_input fails because the page validates isTrusted (CodeMirror/Monaco/Ace editors, shadow DOM inputs, isTrusted-gated forms). Pass \`into_selector\` to focus the target before typing (shadow-piercing CSS) — combined with \`clear_first: true\`, this collapses the old "wait_for_click → execute_script selectAll → type_text" pattern into a single call. Pass \`frame: "iframe.selector"\` to type into a same-origin iframe's first editable element.

**Post-type landing verification, always on.** Whether you pass \`into_selector\` or type into whatever's already focused, type_text reads back the target element after typing and returns \`landed:false\` (success:false) if the text did NOT actually stick — never trust a bare "Typed N characters" without checking this. Two known causes: (1) a rich-text editor's own state machine reverts the keystrokes (TipTap/ProseMirror — auto-recovers via \`document.execCommand('insertText', ...)\`, message records "recovered via execCommand insertText"); (2) tenant-level anti-automation discards synthetic keystrokes outright with zero visible error (seen on some Workday tenants) — for a plain \`<input>\`/\`<textarea>\` this attempts a native-value-setter recovery, and if that ALSO fails, reports \`landed:false\` so you stop and report the wall instead of proceeding on a false premise.`,
    {
      text: z.string().describe("The text to type into the focused element"),
      into_selector: z
        .string()
        .optional()
        .describe(
          'CSS selector for the element to focus before typing (shadow-piercing — resolves selectors that find_text returns for closed-shadow-root content, e.g. Radix portals). When omitted, types into whatever is currently focused (the caller is responsible for focusing first via click_element).'
        ),
      clear_first: z
        .boolean()
        .optional()
        .describe(
          "Only with into_selector: run document.execCommand('selectAll') + 'delete' on the focused element before typing. Use to overwrite tiptap / ProseMirror editors and similar contenteditable surfaces in one call."
        ),
      frame: z
        .string()
        .optional()
        .describe(
          "CSS selector for an iframe whose contents you want to type into (e.g. 'iframe.se-rte-frame__summary'). Same-origin only. Before typing, the first contenteditable/input inside the iframe is focused; after typing, input/change events are dispatched in the iframe's context."
        ),
    },
    async ({ text, frame, into_selector, clear_first }) => {
      // Average ~80ms per char (60ms avg delay + overhead) but with a 5% slow
      // pause tail. 110ms/char gives margin over the empirical p99 and the
      // background also emits a "progress" heartbeat every 200 chars that
      // resets the bridge's request timer — combined, ~1800-char typings
      // complete reliably without timeout-ambiguity.
      const timeoutMs = Math.max(30_000, text.length * 110 + 15_000);
      const response = await bridge.request(
        { type: "type_text", text, frame, into_selector, clear_first },
        timeoutMs
      );
      // `landed` is the extension's post-type verification (text actually stuck);
      // it lets us treat "typed but the field reverted" as a failure, not a success.
      // `resolved_selector` is the canonical, single, stable selector of the element
      // the extension actually focused — cache THAT (not the agent's loose / multi-
      // option query) so recall replays a precise locator and lands first try.
      const r = response as { success?: boolean; message?: string; landed?: boolean; resolved_selector?: string | null };
      const typeFailed = r.success === false || r.landed === false;
      const locator = r.resolved_selector || into_selector;
      // Flow memory: typing into a specific selector with type_text (rather than
      // fill_input) is a deliberate "this field needs real isTrusted keystrokes"
      // decision worth remembering — the canonical Reddit title/body case. Only
      // notable when an explicit target was given and the type actually landed.
      let capturable = "";
      if (into_selector && !typeFailed) {
        flowStore.observe({
          tool: "type_text",
          target: locator!,
          selector: locator,
          signal: clear_first ? "type_text(clear_first)" : "type_text",
          clear_first: clear_first || undefined,
          fragile: isFragileSelector(locator),
          reason: "field needs real keystrokes (type_text, not fill_input)",
        } as Atom);
        capturable = flowStore.capturableHint(undefined);
      } else if (into_selector && typeFailed) {
        // A recalled type_text step that didn't land — ding the flow so a drifted
        // shadow-DOM / React field selector self-demotes (the Reddit failure mode).
        flowStore.observeFailure(undefined, locator);
      }
      return {
        content: [{ type: "text", text: (r.message ?? (r.success ? "Text typed successfully" : "Failed to type text")) + capturable }],
      };
    }
  );
}
