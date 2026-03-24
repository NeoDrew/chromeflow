import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

export function registerHighlightTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "find_and_highlight",
    "Find an element on the page by its visible text and highlight it with an instructional callout. Try this before using highlight_region. Returns whether the element was found.",
    {
      text: z
        .string()
        .describe(
          "Visible text of the element or text near it (e.g. 'API Keys', 'Create account')"
        ),
      message: z
        .string()
        .describe(
          "Instruction to show the user in the callout (e.g. 'Click here to create your API key'). When the user needs to type something, use a short instruction like 'Type this in the field:' and pass the text as valueToType."
        ),
      valueToType: z
        .string()
        .optional()
        .describe(
          "Only use when the user must personally type the value (password, email, personal data). Do NOT use when Claude will auto-fill after the click — in that case, omit this and use message: 'Click here — I'll fill it in'."
        ),
    },
    async ({ text, message, valueToType }) => {
      const response = await bridge.request({
        type: "find_highlight",
        text,
        message,
        valueToType,
      });
      if (response.type !== "find_highlight_response") {
        throw new Error("Unexpected response from extension");
      }
      return {
        content: [
          {
            type: "text",
            text: response.found
              ? `Element containing "${text}" highlighted.`
              : `Element containing "${text}" not found. Try get_elements() to get exact DOM coordinates, or take_screenshot() only if you need to see the visual layout.`,
          },
        ],
      };
    }
  );

  server.tool(
    "highlight_region",
    `Highlight a region on the page with an instructional callout.
Prefer passing a CSS selector — the extension will find the element, scroll it into view, and highlight its exact bounds automatically. This is more robust than pixel coordinates, which go stale if the user scrolls.
Only pass x/y/width/height when you have no selector and already have fresh coordinates from get_elements.`,
    {
      selector: z.string().optional().describe("CSS selector of the element to highlight (e.g. '#upload-zone', '.drop-area'). Preferred over raw coordinates."),
      x: z.number().optional().describe("Left edge in CSS pixels — only needed if no selector"),
      y: z.number().optional().describe("Top edge in CSS pixels — only needed if no selector"),
      width: z.number().optional().describe("Width in CSS pixels — only needed if no selector"),
      height: z.number().optional().describe("Height in CSS pixels — only needed if no selector"),
      message: z
        .string()
        .describe(
          "Instruction to show the user in the callout. When the user needs to type something, use a short instruction like 'Type this in the field:' and pass the text as valueToType."
        ),
      valueToType: z
        .string()
        .optional()
        .describe(
          "Only use when the user must personally type the value (password, email, personal data). Do NOT use when Claude will auto-fill after the click — in that case, omit this and use message: \"Click here — I'll fill it in\"."
        ),
    },
    async ({ selector, x, y, width, height, message, valueToType }) => {
      await bridge.request({ type: "highlight_region", selector, x, y, width, height, message, valueToType });
      return {
        content: [
          {
            type: "text",
            text: selector
              ? `Highlighted element matching "${selector}".`
              : `Region highlighted at (${x ?? 0}, ${y ?? 0}) ${width ?? 0}×${height ?? 0}.`,
          },
        ],
      };
    }
  );

  server.tool(
    "show_guide_panel",
    "Show a floating step-by-step guide panel on the page to help the user understand what they need to do",
    {
      title: z.string().describe("Title of the guide (e.g. 'Set up Stripe API keys')"),
      steps: z
        .array(
          z.object({
            text: z.string().describe("Step instruction text"),
            done: z
              .boolean()
              .optional()
              .describe("Whether this step is already completed"),
          })
        )
        .describe("Ordered list of steps"),
    },
    async ({ title, steps }) => {
      await bridge.request({ type: "show_panel", title, steps });
      return {
        content: [
          {
            type: "text",
            text: `Guide panel shown: "${title}" with ${steps.length} steps.`,
          },
        ],
      };
    }
  );
}
