import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerWaitTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "wait_for_click",
    `Wait for the user to click (or interact with) the currently highlighted element, then return.
Use this after highlighting a step so the flow advances automatically without the user returning to the chat.
After this resolves, highlight the next step immediately.
If the click causes page navigation, this resolves when the new page finishes loading.

Pass \`redispatch: true\` to turn the user's gesture into a CDP-dispatched isTrusted=true click. When the user clicks the highlighted area, chromeflow captures the coordinates and re-dispatches a full humanlike CDP click (bezier approach, settle hover, pointer events) at those exact coordinates. This produces an isTrusted=true event that passes anti-bot checks. Use for buttons that reject all synthetic clicks (shadow DOM buttons checking isTrusted, annotation dashboard "Collect Traces" buttons) where highlight_region + wait_for_click normally works but only the user's real gesture fires the action. With redispatch, the user still clicks, but chromeflow re-fires via CDP so subsequent automation (activity probe, state verification) works normally.`,
    {
      timeout: z
        .number()
        .optional()
        .describe("Max seconds to wait for the click (default 120)"),
      redispatch: z
        .boolean()
        .optional()
        .describe('Re-dispatch the user\'s click via CDP at the captured coordinates (isTrusted=true). The user clicks the highlighted area, chromeflow captures the (x, y) and fires a full humanlike CDP click sequence at those coordinates. Use for anti-bot buttons that reject all synthetic clicks. Returns redispatched=true and redispatch_activity=true/false in the response.'),
    },
    async ({ timeout = 120, redispatch }) => {
      const watchMs = timeout * 1000;
      const response = await bridge.request(
        {
          type: "start_click_watch",
          timeout: watchMs,
          redispatch,
        },
        watchMs + 5_000,
      );

      const r = response as {
        type: string;
        url?: string;
        target?: { selector: string; text: string; tag: string; x: number; y: number } | null;
        redispatched?: boolean;
        redispatch_activity?: boolean;
      };
      const targetLine = r.target
        ? `\nClicked element: <${r.target.tag}>${r.target.text ? ` "${r.target.text}"` : ""} at (${r.target.x}, ${r.target.y}) — selector: ${r.target.selector}`
        : "";
      const redispatchLine = r.redispatched
        ? `\nCDP re-dispatched: isTrusted=true click at (${r.target?.x ?? 0}, ${r.target?.y ?? 0})${r.redispatch_activity ? " — activity detected" : " — no immediate activity (async action may still be processing)"}`
        : "";

      if (r.type === "navigation_complete") {
        return {
          content: [
            {
              type: "text",
              text: `User clicked. Page navigated to: ${r.url ?? "(unknown)"}${targetLine}${redispatchLine}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `User clicked the highlighted element.${targetLine}${redispatchLine}` }],
      };
    }
  );

  server.tool(
    "wait_for",
    `Wait for one of: a CSS selector to appear, a text substring (or any of an array of substrings) to appear, or an existing element's subtree to mutate. Pass exactly one of \`selector\`, \`text\`, or \`change_in\`. Pierces open AND closed shadow roots (text \`scope_selector\` pierces too). Pass \`shadow_root: true\` when waiting for the host's shadowRoot to attach (post-SPA-navigation hydration). \`scope_selector\` limits text-mode search; \`regex: true\` interprets text as a case-insensitive regex; \`frame: "iframe.selector"\` waits inside a same-origin iframe (text mode).

Text mode accepts an array — \`text: ["New session", "Error", "Stop"]\` resolves on the first match and the response carries \`matched_query\` so you know which entry fired. Useful for "wait for success OR failure" without a polling loop.

On timeout, the response carries \`last_text\` — the trailing 240 chars of the scope's content — so you can see the page state when the wait gave up. If the deploy panel shows "Starting up... 47%" and never reaches "Live", you'll see "Starting up... 47%" in last_text and know to extend the timeout instead of debugging a phantom failure.

Pass \`since: "now"\` in text mode to skip the initial check and only resolve on text appearing in a NEW DOM mutation — defeats the "stale instruction panels still in DOM" false-positive. When the wait DOES match on the initial check faster than 50ms, the response carries \`initial_match_warning\` suggesting since:"now" so you don't accidentally short-circuit on stale state.`,
    {
      selector: z.string().optional().describe("CSS selector to wait for."),
      text: z.union([z.string(), z.array(z.string()).min(1)]).optional().describe('Text substring(s) to wait for. String for single match, array for "any of" mode (resolves on the first match; response includes matched_query and matched_index).'),
      change_in: z.string().optional().describe("CSS selector of an existing element whose subtree should mutate (MutationObserver)."),
      timeout_ms: z.number().int().optional().describe("Max ms to wait (default 30000)."),
      poll_interval_ms: z.number().int().optional().describe("Selector-mode poll interval (default 500). Set to 15000 for slow server-side jobs."),
      shadow_root: z.boolean().optional().describe("Selector mode: require the matched host to have an attached shadowRoot. Default false."),
      scope_selector: z.string().optional().describe("Text mode: limit search to this CSS selector's subtree. Pierces shadow roots."),
      regex: z.boolean().optional().describe("Text mode: interpret query (each entry, if an array) as a case-insensitive regex."),
      frame: z.string().optional().describe("Same-origin iframe CSS selector to wait inside (text mode)."),
      since: z.enum(["now"]).optional().describe(`Text mode: gate on a NEW mutation. Skips the initial check so already-present matches don't short-circuit. Use when the page keeps stale text in the DOM after a route change (e.g. stacked instruction panels) and you need to wait for the next render.`),
      whole_word: z.boolean().optional().describe(`Text mode: gate matches on word boundaries. Use for common English words ("Live", "New", "Done") that would otherwise substring-match unrelated content (e.g. "Live" matching "delivery"). Default false.`),
      settle_ms: z.number().int().optional().describe("change_in mode: ms to wait after the first mutation for batching (default 150)."),
      max_chars: z.number().int().min(50).optional().describe("change_in mode: cap the returned text content (default 1000). Chat-style mutations can dump huge text; agents that need more should opt in explicitly."),
    },
    async (args) => {
      const { selector, text, change_in, timeout_ms, poll_interval_ms, shadow_root, scope_selector, regex, frame, since, settle_ms, max_chars, whole_word } = args;
      const isTextSet = text !== undefined && text !== null && !(Array.isArray(text) && text.length === 0) && text !== "";
      const set = [selector, isTextSet ? text : undefined, change_in].filter((v) => v !== undefined && v !== null && v !== "").length;
      if (set !== 1) {
        return { content: [{ type: "text", text: "wait_for: pass exactly one of selector, text, or change_in." }] };
      }
      const timeoutMs = timeout_ms ?? 30_000;
      if (selector !== undefined) {
        await bridge.request(
          { type: "wait_for_selector", selector, timeout: timeoutMs, refresh: poll_interval_ms, shadow_root },
          timeoutMs + 5_000
        );
        const suffix = shadow_root ? " (with attached shadowRoot)" : "";
        return { content: [{ type: "text", text: `Selector "${selector}" found on page${suffix}.` }] };
      }
      if (text !== undefined) {
        const response = await bridge.request(
          { type: "wait_for_text", query: text, timeout_ms: timeoutMs, scope_selector, regex, frame, since, whole_word },
          timeoutMs + 5_000
        );
        const r = response as {
          found: boolean;
          selector?: string;
          text?: string;
          context?: string;
          matched_query?: string;
          matched_index?: number;
          elapsed_ms: number;
          last_text?: string;
          initial_match_warning?: string;
          frame_error?: string;
        };
        if (r.frame_error) return { content: [{ type: "text", text: r.frame_error }] };
        const display = Array.isArray(text)
          ? text.map((t) => `"${t}"`).join(" / ")
          : `"${text}"`;
        if (!r.found) {
          const tail = r.last_text ? `\nLast text seen in scope (trailing 240 chars): ${JSON.stringify(r.last_text)}` : "";
          return { content: [{ type: "text", text: `Text ${display} did not appear within ${timeoutMs}ms.${tail}` }] };
        }
        const whichMatched = r.matched_query
          ? `\nmatched: "${r.matched_query}" (index ${r.matched_index})`
          : "";
        const warn = r.initial_match_warning ? `\n⚠ ${r.initial_match_warning}` : "";
        return { content: [{ type: "text", text: `Found ${display} after ${r.elapsed_ms}ms.${whichMatched}\nselector: ${r.selector}\ncontext: ${r.context}${warn}` }] };
      }
      // change_in mode
      const response = await bridge.request(
        { type: "wait_for_change", selector: change_in!, timeout: timeoutMs, settle: settle_ms ?? 150 },
        timeoutMs + 5_000
      );
      const r = response as unknown as { ok: boolean; text?: string; message?: string };
      if (!r.ok) return { content: [{ type: "text", text: r.message ?? `wait_for change_in timed out on "${change_in}"` }] };
      const fullText = r.text ?? "";
      const cap = max_chars ?? 1000;
      const preview = fullText.length > cap
        ? `${fullText.slice(0, cap)}... [truncated, ${fullText.length} chars total — pass max_chars to see more]`
        : fullText;
      return { content: [{ type: "text", text: `Element "${change_in}" changed.\n\n${preview}` }] };
    }
  );

  server.tool(
    "scroll_to_element",
    `Scroll an element into view by CSS selector or label/text match.
Use this instead of guessing scroll amounts when you know which field or section you need to reach.
Examples: scroll_to_element("#submit-btn"), scroll_to_element("Billing address"), scroll_to_element(".cm-editor")`,
    {
      query: z.string().describe("CSS selector (e.g. '#my-input', '.section-header') or visible text / label to search for"),
    },
    async ({ query }) => {
      const response = await bridge.request({ type: "scroll_to_element", query });
      const msg = (response as { message?: string }).message ?? `Scrolled to element matching "${query}".`;
      return { content: [{ type: "text", text: msg }] };
    }
  );
}
