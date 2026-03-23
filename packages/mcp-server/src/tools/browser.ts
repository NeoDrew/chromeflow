import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../ws-bridge.js";

export function registerBrowserTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "open_page",
    "Navigate to a URL. By default reuses the active tab. Set new_tab=true to open alongside the current tab without losing it.",
    {
      url: z.string().url().describe("The URL to navigate to"),
      new_tab: z.boolean().optional().describe("Open in a new tab instead of replacing the current one (default false)"),
    },
    async ({ url, new_tab }) => {
      await bridge.request({ type: "navigate", url, newTab: new_tab ?? false });
      return {
        content: [{ type: "text", text: `Navigated to ${url}${new_tab ? " (new tab)" : ""}` }],
      };
    }
  );

  server.tool(
    "switch_to_tab",
    `Switch the active tab to a different open tab. Use this after open_page(new_tab=true) to switch back to the original tab, or to jump between tabs.
Accepts: a tab number (1-based), a URL substring, or a title substring.
Example: switch_to_tab("1") to go to the first tab, switch_to_tab("form") to find a tab whose URL or title contains "form".`,
    {
      query: z.string().describe("Tab number (1-based), URL substring, or title substring to match"),
    },
    async ({ query }) => {
      await bridge.request({ type: "switch_to_tab", query });
      return {
        content: [{ type: "text", text: `Switched to tab matching "${query}"` }],
      };
    }
  );

  server.tool(
    "list_tabs",
    "List all open tabs in the current window with their index, title, and URL. Use this before switch_to_tab if you're not sure which tab to switch to.",
    {},
    async () => {
      const response = await bridge.request({ type: "list_tabs" });
      if (response.type !== "tabs_response") throw new Error("Unexpected response");
      const tabs = (response as { tabs: Array<{ index: number; title: string; url: string; active: boolean }> }).tabs;
      const lines = tabs.map(t => `${t.index}. ${t.active ? "[active] " : ""}${t.title} — ${t.url}`);
      return {
        content: [{ type: "text", text: `Open tabs:\n${lines.join("\n")}` }],
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
    "get_form_fields",
    `Get a full inventory of all form fields on the page: inputs, textareas, selects, and CodeMirror editors.
Run this once at the start of a complex form to understand what fields exist, their labels, current values, and vertical positions.
Returns fields sorted by their y-position on the page (top to bottom).
Unlike get_elements, this includes ALL fields (even far below the fold) and is not limited to 60 items.`,
    {},
    async () => {
      const response = await bridge.request({ type: "get_form_fields" });
      if (response.type !== "form_fields_response") throw new Error("Unexpected response");
      const fields = (response as { fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string }> }).fields;
      if (fields.length === 0) {
        return { content: [{ type: "text", text: "No form fields found on page." }] };
      }
      const lines = fields.map(f => {
        const val = f.value ? ` [currently: "${f.value}"]` : "";
        return `${f.index}. [${f.type}] "${f.label}"${val} — y:${f.y}`;
      });
      return {
        content: [{ type: "text", text: `Form fields (${fields.length} total, sorted top-to-bottom):\n${lines.join("\n")}` }],
      };
    }
  );

  server.tool(
    "execute_script",
    `Execute JavaScript in the current page's context and return the result as a string.
Use this to read framework state, check DOM properties, or interact with page APIs that aren't reachable via text.
Prefer get_page_text for reading visible content. Use this for programmatic DOM queries (e.g. checking an element's attribute, reading a value not visible in text).
Top-level return statements are supported (e.g. multi-statement scripts with \`return value;\`).
If the page called alert()/confirm()/prompt() since the last check, the message will appear as PAGE ALERT in the result — read it and act on it.
NOTE: Pages with strict Content Security Policy (e.g. Stripe, GitHub) will block eval and return a CSP error — do not retry, use get_page_text or fill_input instead.`,
    {
      code: z
        .string()
        .describe(
          "JavaScript expression or multi-statement script to evaluate in the page. Top-level `return` is supported."
        ),
    },
    async ({ code }) => {
      const response = await bridge.request({ type: "execute_script", code });
      if (response.type !== "script_response") throw new Error("Unexpected response");
      const { result, alert } = response as { result: string; alert?: string | null };
      let text = `Result: ${result}`;
      if (alert) {
        text += `\n\nPAGE ALERT: "${alert}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
      }
      return {
        content: [{ type: "text", text }],
      };
    }
  );
}
