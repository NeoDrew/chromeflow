import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

export function registerFlowTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "scroll_page",
    "Scroll the page or the focused panel up or down. Use this when a button (e.g. Save) is below the visible area of a panel or page. After scrolling, retry click_element.",
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
    "wait_for_navigation",
    "Wait for the browser to navigate to a new page (without requiring a prior click watch). Useful after calling open_page or after a form submission.",
    {
      urlPattern: z
        .string()
        .optional()
        .describe("Substring to match in the new URL — waits for any navigation if omitted"),
      timeout: z
        .number()
        .optional()
        .describe("Max seconds to wait (default 30)"),
    },
    async ({ urlPattern, timeout = 30 }) => {
      const response = await bridge.request({
        type: "start_click_watch",
        timeout: timeout * 1000,
      });
      const url = (response as { url?: string }).url ?? "";
      if (urlPattern && !url.includes(urlPattern)) {
        return {
          content: [
            { type: "text", text: `Navigation detected to ${url} (pattern "${urlPattern}" not matched — proceeding anyway).` },
          ],
        };
      }
      return {
        content: [{ type: "text", text: `Page navigated to: ${url}` }],
      };
    }
  );

  server.tool(
    "wait_for_selector",
    `Wait for a CSS selector to appear on the page. Use this instead of polling with take_screenshot.
Examples: wait for a build to finish, a success/error message to appear, a modal to open.
After it resolves, use get_page_text to read the result rather than taking a screenshot.`,
    {
      selector: z
        .string()
        .describe(
          "CSS selector to wait for (e.g. '.deploy-ready', '[data-status=\"error\"]', '.toast-error')"
        ),
      timeout: z.number().optional().describe("Max seconds to wait (default 30)"),
    },
    async ({ selector, timeout = 30 }) => {
      const timeoutMs = timeout * 1000;
      await bridge.request({ type: "wait_for_selector", selector, timeout: timeoutMs }, timeoutMs + 5000);
      return {
        content: [{ type: "text", text: `Selector "${selector}" found on page.` }],
      };
    }
  );

  server.tool(
    "mark_step_done",
    "Mark a step in the guide panel as completed (shows a green check). Call this after wait_for_click resolves.",
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
