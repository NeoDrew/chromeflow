import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

export function registerBrowserTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "open_page",
    "Navigate the user's active Chrome tab to a URL",
    { url: z.string().url().describe("The URL to navigate to") },
    async ({ url }) => {
      await bridge.request({ type: "navigate", url });
      return {
        content: [{ type: "text", text: `Navigated to ${url}` }],
      };
    }
  );

  server.tool(
    "take_screenshot",
    "Capture a screenshot ONLY when click_element or fill_input has failed and you need pixel coordinates to call highlight_region. DO NOT use this to check page state, confirm actions, or see what loaded — use get_page_text for all of that.",
    {},
    async () => {
      const response = await bridge.request({ type: "screenshot" });
      if (response.type !== "screenshot_response") {
        throw new Error("Unexpected response from extension");
      }
      return {
        content: [
          {
            type: "image",
            data: response.image,
            mimeType: "image/png",
          },
          {
            type: "text",
            text: `Screenshot captured (${response.width}x${response.height}). Analyze the image to identify element positions for highlighting.`,
          },
        ],
      };
    }
  );

  server.tool(
    "clear_overlays",
    "Remove all highlights and callout annotations from the current page. Does NOT remove the guide panel — the guide panel persists until the next flow starts.",
    {},
    async () => {
      await bridge.request({ type: "clear" });
      return {
        content: [{ type: "text", text: "All overlays cleared." }],
      };
    }
  );

  server.tool(
    "get_elements",
    `Get the exact pixel positions of all visible interactive elements on the page (inputs, buttons, links, selects).
Use this INSTEAD OF take_screenshot when you need coordinates for highlight_region — the coordinates are exact DOM values, not estimates.
Returns a numbered list with element type, label, and precise x/y/width/height in CSS pixels.
After calling this, use those exact coordinates in highlight_region — do NOT adjust them.`,
    {},
    async () => {
      const response = await bridge.request({ type: "get_elements" });
      if (response.type !== "elements_response") throw new Error("Unexpected response");
      const els = (response as { elements: Array<{ index: number; type: string; label: string; value: string; x: number; y: number; width: number; height: number }> }).elements;
      if (els.length === 0) {
        return { content: [{ type: "text", text: "No visible interactive elements found on page." }] };
      }
      const lines = els.map(e => {
        const val = e.value ? ` [currently: "${e.value}"]` : "";
        return `${e.index}. ${e.type} "${e.label}"${val} — x:${e.x} y:${e.y} w:${e.width} h:${e.height}`;
      });
      return {
        content: [{ type: "text", text: `Visible interactive elements:\n${lines.join("\n")}\n\nUse these exact x/y values in highlight_region.` }],
      };
    }
  );

  server.tool(
    "execute_script",
    `Execute JavaScript in the current page's context and return the result as a string.
Use this to read framework state, check DOM properties, or interact with page APIs that aren't reachable via text.
Prefer get_page_text for reading visible content. Use this for programmatic DOM queries (e.g. checking an element's attribute, reading a value not visible in text).
NOTE: Pages with strict Content Security Policy (e.g. Stripe, GitHub) will block eval and return a CSP error — do not retry, use get_page_text or fill_input instead.`,
    {
      code: z
        .string()
        .describe(
          "JavaScript expression to evaluate in the page (e.g. 'document.title', 'document.querySelector(\".price\")?.textContent')"
        ),
    },
    async ({ code }) => {
      const response = await bridge.request({ type: "execute_script", code });
      if (response.type !== "script_response") throw new Error("Unexpected response");
      return {
        content: [{ type: "text", text: `Result: ${(response as { result: string }).result}` }],
      };
    }
  );
}
