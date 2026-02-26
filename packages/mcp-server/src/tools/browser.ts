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
    "Capture a screenshot of the current browser tab so you can see what is on the page. Use this to identify element positions before highlighting.",
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
    "Remove all Keyclaw highlights, callouts, and guide panels from the current page",
    {},
    async () => {
      await bridge.request({ type: "clear" });
      return {
        content: [{ type: "text", text: "All overlays cleared." }],
      };
    }
  );
}
