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
          "Instruction to show the user in the callout (e.g. 'Click here to create your API key')"
        ),
    },
    async ({ text, message }) => {
      const response = await bridge.request({
        type: "find_highlight",
        text,
        message,
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
              : `Element containing "${text}" not found. Try take_screenshot to identify the element visually.`,
          },
        ],
      };
    }
  );

  server.tool(
    "highlight_region",
    "Highlight a specific pixel region on the page with an instructional callout. Use this after take_screenshot when you can see the element's position.",
    {
      x: z.number().describe("Left edge of the region in CSS pixels"),
      y: z.number().describe("Top edge of the region in CSS pixels"),
      width: z.number().describe("Width of the region in CSS pixels"),
      height: z.number().describe("Height of the region in CSS pixels"),
      message: z
        .string()
        .describe(
          "Instruction to show the user in the callout (e.g. 'Click here to reveal your API key')"
        ),
    },
    async ({ x, y, width, height, message }) => {
      await bridge.request({ type: "highlight_region", x, y, width, height, message });
      return {
        content: [
          {
            type: "text",
            text: `Region highlighted at (${x}, ${y}) ${width}×${height}.`,
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
