import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

export function registerFlowTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "scroll_page",
    "Scroll the page or the focused panel up or down. Use this when the target location is unknown. If you know which field or element you need, use scroll_to_element instead — it scrolls precisely without guessing. After scrolling, retry click_element or fill_input.",
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
Do NOT use for: elements that require the user to make a personal choice, consent to terms, or enter sensitive data.`,
    {
      textHint: z
        .string()
        .describe(
          "The visible label of the button or link (e.g. 'Save product', 'Continue', 'Add a product', 'Create')"
        ),
    },
    async ({ textHint }) => {
      const response = await bridge.request({ type: "click_element", textHint });
      const r = response as { success: boolean; message: string };
      if (!r.success) {
        return {
          content: [
            {
              type: "text",
              text: `Could not click "${textHint}": ${r.message}. Call take_screenshot() to locate the element visually.`,
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
to 15 seconds so the page is checked gently rather than hammered every 500ms.`,
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
    },
    async ({ selector, timeout = 30, poll_interval }) => {
      const timeoutMs = timeout * 1000;
      const pollMs = poll_interval ? poll_interval * 1000 : undefined;
      await bridge.request({ type: "wait_for_selector", selector, timeout: timeoutMs, refresh: pollMs }, timeoutMs + 5000);
      return {
        content: [{ type: "text", text: `Selector "${selector}" found on page.` }],
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
      await bridge.request({ type: "scroll_to_element", query });
      return { content: [{ type: "text", text: `Scrolled to element matching "${query}".` }] };
    }
  );

  server.tool(
    "mark_step_done",
    "Mark a step in the guide panel as completed (shows a green check). Call this after any step finishes — whether Claude acted autonomously or the user completed a highlighted step via wait_for_click.",
    {
      stepIndex: z.number().int().describe("0-based index of the step to mark done"),
    },
    async ({ stepIndex }) => {
      await bridge.request({ type: "mark_step_done", stepIndex });
      return {
        content: [{ type: "text", text: `Step ${stepIndex + 1} marked as done.` }],
      };
    }
  );
}
