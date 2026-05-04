import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

export function registerFlowTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "scroll_page",
    "Scroll the page or the focused panel up or down. Use this when the target location is unknown. If you know which field or element you need, use scroll_to_element instead — it scrolls precisely without guessing. After scrolling, call get_page_text to read the new content — NEVER call take_screenshot after scrolling.",
    {
      direction: z.enum(["down", "up"]).describe("Scroll direction"),
      amount: z.number().optional().describe("Pixels to scroll (default 400)"),
    },
    async ({ direction, amount = 400 }) => {
      await bridge.request({ type: "scroll_page", direction, amount });
      return { content: [{ type: "text", text: `Scrolled ${direction} ${amount}px.` }] };
    }
  );

  server.tool(
    "click_element",
    `Click a button, link, or interactive element on the page by its visible text or aria-label.
Use this whenever Claude can press a button without needing user input — e.g. "Save", "Continue", "Create product", "Add pricing", "Confirm", "Next".
After clicking, use get_page_text to check the result — only use take_screenshot if you need pixel positions.
Do NOT use for: elements that require the user to make a personal choice, consent to terms, or enter sensitive data.
When multiple elements share the same label (e.g. many "Remove" buttons), use nth to target a specific one (1 = first/topmost, 2 = second, etc.).

Verifying the click took effect: on React-heavy sites the synthetic click sometimes returns success but the handler never ran. Pass an "until" condition that should hold AFTER the click — click_element will then poll for it and return success only if the page actually changed:
- until_selector: a CSS selector that should appear (e.g. ".success-toast", "#confirm-modal")
- until_url_contains: a substring that should appear in the URL (e.g. "/listing-published")
- until_text_contains: a substring that should appear anywhere in page text (e.g. "Listing created")
If the until-condition is not met within until_timeout_ms (default 5000ms), click_element returns success=false with a clear message so the caller can retry or take a different path.`,
    {
      textHint: z
        .string()
        .describe(
          "The visible label of the button or link (e.g. 'Save product', 'Continue', 'Add a product', 'Create')"
        ),
      nth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Which match to click when multiple elements share the same label (1 = first/topmost, default 1)"),
      until_selector: z
        .string()
        .optional()
        .describe('Wait until this CSS selector appears on the page after the click (e.g. ".success-toast"). Returns success=false if it does not appear within until_timeout_ms.'),
      until_url_contains: z
        .string()
        .optional()
        .describe('Wait until the URL contains this substring after the click (e.g. "/checkout/complete"). Returns success=false if it does not.'),
      until_text_contains: z
        .string()
        .optional()
        .describe('Wait until the visible page text contains this substring after the click (e.g. "Listing published"). Returns success=false if it does not.'),
      until_timeout_ms: z
        .number()
        .int()
        .min(500)
        .optional()
        .describe("How long to wait for the until-condition, in milliseconds (default 5000). Only used if one of until_* is set."),
    },
    async ({ textHint, nth, until_selector, until_url_contains, until_text_contains, until_timeout_ms }) => {
      // The WS request must outlive the until-poll, with a buffer for navigation.
      const wsTimeout = Math.max(30_000, (until_timeout_ms ?? 0) + 10_000);
      const response = await bridge.request(
        { type: "click_element", textHint, nth, until_selector, until_url_contains, until_text_contains, until_timeout_ms },
        wsTimeout
      );
      const r = response as { success: boolean; message: string };
      if (!r.success) {
        return {
          content: [
            {
              type: "text",
              text: `Could not click "${textHint}": ${r.message}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: r.message }],
      };
    }
  );

  server.tool(
    "wait_for_click",
    `Wait for the user to click (or interact with) the currently highlighted element, then return.
Use this after highlighting a step so the flow advances automatically without the user returning to the chat.
After this resolves, highlight the next step immediately.
If the click causes page navigation, this resolves when the new page finishes loading.`,
    {
      timeout: z
        .number()
        .optional()
        .describe("Max seconds to wait for the click (default 120)"),
    },
    async ({ timeout = 120 }) => {
      const response = await bridge.request({
        type: "start_click_watch",
        timeout: timeout * 1000,
      });

      if (response.type === "navigation_complete") {
        return {
          content: [
            {
              type: "text",
              text: `User clicked. Page navigated to: ${(response as { url: string }).url}`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: "User clicked the highlighted element." }],
      };
    }
  );

  server.tool(
    "wait_for_selector",
    `Wait for a CSS selector to appear on the page. Use this instead of polling with take_screenshot.
Examples: wait for a build to finish, a success/error message to appear, a modal to open.
After it resolves, use get_page_text to read the result rather than taking a screenshot.
For long-running server-side processes (e.g. a query job that may take minutes), set poll_interval
to 15 seconds so the page is checked gently rather than hammered every 500ms.

Pierces open shadow roots automatically — selectors for elements inside web components
(Outlier task UI, Lit/Stencil widgets) match without needing a shadow-DOM-aware caller.

Pass \`shadow_root: true\` when the matched element is itself a shadow host whose tree
hasn't attached yet — common after SPA route transitions where the host element appears
seconds before its shadow content hydrates. Without this, wait_for_selector("the-host")
resolves on the empty host and the next execute_script(host.shadowRoot) returns null.`,
    {
      selector: z
        .string()
        .describe(
          "CSS selector to wait for (e.g. '.deploy-ready', '[data-status=\"error\"]', '.toast-error')"
        ),
      timeout: z.number().optional().describe("Max seconds to wait (default 30)"),
      poll_interval: z
        .number()
        .optional()
        .describe(
          "How often to check for the selector, in seconds (default 0.5). Set to 15 when waiting for a slow server-side process."
        ),
      shadow_root: z
        .boolean()
        .optional()
        .describe(
          "If true, also require the matched element to have an attached shadowRoot (not null). Use after SPA navigations where the shadow host appears before its tree hydrates. Default false."
        ),
    },
    async ({ selector, timeout = 30, poll_interval, shadow_root }) => {
      const timeoutMs = timeout * 1000;
      const pollMs = poll_interval ? poll_interval * 1000 : undefined;
      await bridge.request(
        { type: "wait_for_selector", selector, timeout: timeoutMs, refresh: pollMs, shadow_root },
        timeoutMs + 5000
      );
      const suffix = shadow_root ? " (with attached shadowRoot)" : "";
      return {
        content: [{ type: "text", text: `Selector "${selector}" found on page${suffix}.` }],
      };
    }
  );

  server.tool(
    "wait_for_change",
    `Block until the element matching \`selector\` mutates, then return its text content.
Uses a MutationObserver — no polling, no screenshots. Ideal after an action where you expect
a specific UI region to update: click Save, then wait_for_change(".toast") to capture the
confirmation. wait_for_change(".chat-messages") after sending a message to get the reply.

The element must exist at call time (use wait_for_selector first if needed). After the first
mutation fires, waits a brief settle window (default 150ms) for the update to batch, then
returns the element's current text with secrets redacted.

Only observes changes within the matched element's subtree. Mutations in deeper shadow roots
or in sibling elements are not detected. For form inputs whose \`value\` changes without a
DOM mutation, this won't fire — use execute_script to read the value directly.`,
    {
      selector: z
        .string()
        .describe(
          "CSS selector of the element whose changes you want to observe (e.g. '.toast', '.chat-messages', '[role=\"alert\"]')"
        ),
      timeout: z.number().optional().describe("Max seconds to wait for a mutation (default 30)"),
      settle: z
        .number()
        .optional()
        .describe(
          "Milliseconds to wait AFTER the first mutation for subsequent mutations to batch (default 150). Increase to 500-1000 if the page renders in multiple rapid steps."
        ),
    },
    async ({ selector, timeout = 30, settle }) => {
      const timeoutMs = timeout * 1000;
      const settleMs = settle ?? 150;
      const response = await bridge.request(
        { type: "wait_for_change", selector, timeout: timeoutMs, settle: settleMs },
        timeoutMs + 5000
      );
      const r = response as unknown as { ok: boolean; reason: "mutation" | "timeout"; text?: string; message?: string };
      if (!r.ok) {
        return { content: [{ type: "text", text: r.message ?? `wait_for_change timed out on "${selector}"` }] };
      }
      const preview = (r.text ?? "").slice(0, 5000);
      return {
        content: [
          {
            type: "text",
            text: `Element "${selector}" changed.\n\n${preview}`,
          },
        ],
      };
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

  server.tool(
    "fill_form",
    `Fill multiple form fields in a single call by targeting each field by its label text.
Use this instead of calling fill_input repeatedly — it fills all fields in one round trip and returns a per-field success report.
Ideal for forms with many textareas or inputs where each fill would otherwise require a separate tool call.
fields is an array of {label, value} pairs. label should match the field's visible label, placeholder, or aria-label.

Each per-field result includes the matched element description (e.g. \`<input name="title" id="..." placeholder="...">\`) so Claude can spot when fill_form picked the wrong field.

Pass \`exact: true\` for forms with short generic labels (like "Rate" or "Amount") that may collide with similarly-labeled neighbours — fields without an exact aria-label/placeholder/name/id/label-text match will return success=false instead of silently filling the wrong field.`,
    {
      fields: z.array(
        z.object({
          label: z.string().describe("Visible label, placeholder, or aria-label of the field"),
          value: z.string().describe("Value to fill in"),
        })
      ).describe("List of fields to fill"),
      exact: z
        .boolean()
        .optional()
        .describe("If true, refuse fuzzy text-walk matches for every field. Default false."),
    },
    async ({ fields, exact }) => {
      const response = await bridge.request({ type: "fill_form", fields, exact });
      const r = response as { results: Array<{ label: string; success: boolean; message: string; matched?: string }>; succeeded: number; total: number };
      const lines = r.results.map(f => `${f.success ? "✓" : "✗"} "${f.label}": ${f.message}`);
      return {
        content: [{
          type: "text",
          text: `Filled ${r.succeeded}/${r.total} fields:\n${lines.join("\n")}`,
        }],
      };
    }
  );

}
