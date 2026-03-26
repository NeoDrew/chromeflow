import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, copyFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import type { WsBridge } from "../ws-bridge.js";

export function registerBrowserTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "open_page",
    "Navigate to a URL. By default reuses the active tab. Set new_tab=true to open alongside the current tab without losing it. After navigating, call get_page_text to read the page — do NOT take a screenshot.",
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
    "Capture a screenshot of the current page. IMPORTANT: Do NOT use this to read page content or check what is on the page — call get_page_text instead, which is faster and returns searchable text. Screenshots are ONLY for locating a specific element's pixel coordinates when get_elements has already failed. Never take a screenshot immediately after open_page, scroll_page, or click_element — always use get_page_text after those actions. Never take more than 1-2 screenshots in a row. To also save or copy the image, use take_and_copy_screenshot instead.",
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
    "take_and_copy_screenshot",
    `Take a screenshot, return it to Claude, copy it to the system clipboard, and save it as a PNG file.
Use this instead of take_screenshot when you need the image outside of Claude — to paste into a chat, upload to a form, or keep as a file.
Unlike take_screenshot (Claude-only), this also puts the image on the clipboard and saves it to disk.
save_to controls where the PNG is saved: "downloads" (default) saves to ~/Downloads, "cwd" saves to Claude's current working directory.`,
    {
      save_to: z
        .enum(["downloads", "cwd"])
        .optional()
        .describe('Where to save the PNG file: "downloads" (~/Downloads, default) or "cwd" (Claude\'s current working directory)'),
    },
    async ({ save_to = "downloads" }) => {
      const response = await bridge.request({ type: "screenshot" });
      if (response.type !== "screenshot_response") throw new Error("Unexpected response from extension");

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `chromeflow-${timestamp}.png`;
      const imageBuffer = Buffer.from((response as { image: string }).image, "base64");

      // Write to temp file first (needed for osascript clipboard copy)
      const tmpPath = join(tmpdir(), filename);
      writeFileSync(tmpPath, imageBuffer);

      // Save to final destination
      const savePath = save_to === "cwd"
        ? join(process.cwd(), filename)
        : join(homedir(), "Downloads", filename);
      copyFileSync(tmpPath, savePath);

      // Copy to clipboard (macOS via osascript; silent fail on other platforms)
      let clipboardNote = "";
      try {
        execSync(`osascript -e 'set the clipboard to (read (POSIX file "${tmpPath}") as «class PNGf»)'`);
        clipboardNote = "Copied to clipboard. ";
      } catch {
        clipboardNote = "";
      }

      return {
        content: [
          { type: "image", data: (response as { image: string }).image, mimeType: "image/png" },
          { type: "text", text: `${clipboardNote}Saved to ${savePath}` },
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
      const r = response as { fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string; context?: string }>; warning?: string };
      const fields = r.fields;
      if (fields.length === 0) {
        return { content: [{ type: "text", text: "No form fields found on page." + (r.warning ?? "") }] };
      }
      const lines = fields.map(f => {
        const val = f.value ? ` [currently: "${f.value}"]` : "";
        const ctx = f.context ? ` [under: "${f.context}"]` : "";
        return `${f.index}. [${f.type}] "${f.label}"${val}${ctx} — y:${f.y}`;
      });
      return {
        content: [{ type: "text", text: `Form fields (${fields.length} total, sorted top-to-bottom):\n${lines.join("\n")}${r.warning ?? ""}` }],
      };
    }
  );

  server.tool(
    "set_file_input",
    `Upload a file to a file input field. Works even when the input is visually hidden behind a custom drag-and-drop zone.
Uses Chrome DevTools Protocol to set the file — the only way to bypass the browser's file-input script restriction.
hint: label text or name of the file input (or empty string to target the first file input on the page).
file_path: absolute path to the file on the local filesystem (e.g. /Users/you/Downloads/task.zip).
After calling this, call get_page_text to confirm the file was accepted.`,
    {
      hint: z.string().describe("Label text, name, or surrounding text of the file input. Use empty string to target the first file input on the page."),
      file_path: z.string().describe("Absolute path to the file to upload (e.g. /Users/you/Downloads/task.zip)"),
    },
    async ({ hint, file_path }) => {
      const response = await bridge.request({ type: "set_file_input", hint, filePath: file_path });
      const r = response as { success?: boolean; message?: string };
      return {
        content: [{ type: "text", text: r.message ?? (r.success ? "File set successfully" : "Failed to set file") }],
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
