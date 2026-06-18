import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerExtractTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "get_page_text",
    `Get the visible text content of the current page without taking a screenshot.
Use this instead of take_screenshot whenever you need to read what's on the page — errors, build status, form labels, confirmation messages, etc.
Returns up to 10,000 characters per call (~3k tokens). If the response ends with "... (N more characters)", call again with startIndex to read the next chunk.
Use the selector parameter to scope extraction to a specific section and avoid pulling unnecessary content.
Never use take_screenshot just to read page content — paginate with startIndex instead.`,
    {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to scope the extraction (e.g. 'main', '.error-toast', '[data-testid=\"status\"]'). Omit to auto-extract from the main content area."
        ),
      startIndex: z
        .number()
        .optional()
        .describe(
          "Character offset to start from. Use this to read past the first 20,000 characters — the response will tell you the next startIndex when more content exists."
        ),
    },
    async ({ selector, startIndex }) => {
      const response = await bridge.request({ type: "get_page_text", selector, startIndex });
      if (response.type !== "page_text_response") throw new Error("Unexpected response");
      const r = response as {
        text: string;
        selector_missed?: boolean;
        selector_in_shadow?: boolean;
        shadow_hosts_seen?: number;
        viewport?: { width: number; height: number };
        page?: { width: number; height: number };
        scroll?: { x: number; y: number };
      };
      let text = r.text;
      // Surface selector_in_shadow as a structured prefix — the in-text warning
      // was easy to miss in a 10K char chunk. selector_missed (true selector
      // miss) already carries an inline warning from the content script.
      if (r.selector_in_shadow) {
        text = `[note: selector "${selector}" matched inside a closed shadow root — chromeflow tools that pierce (get_page_text, find_text, click_element, fill_input) see it, but execute_script cannot. Don't drop to screenshots.]\n\n` + text;
      }
      // Shadow-host signal — surface ONLY when no selector was passed (so the
      // agent thinking "what's on this page?" gets the diagnostic) AND we
      // detected shadow hosts. Keeps the message terse on the common case.
      if (!selector && r.shadow_hosts_seen && r.shadow_hosts_seen > 0) {
        text = `[note: ${r.shadow_hosts_seen} shadow host${r.shadow_hosts_seen === 1 ? "" : "s"} detected on this page — call list_frames to see them. If execute_script returns an empty document, switch to find_text / get_page_text / click_element / fill_input — those pierce closed shadow roots.]\n\n` + text;
      }
      // Viewport / scroll metadata appended once, as a footer the agent can
      // use to compute coordinates for click_at_coordinates without a
      // separate execute_script probe. Skipped on continuation pages
      // (startIndex > 0) so it doesn't repeat across chunks.
      if ((startIndex ?? 0) === 0 && r.viewport && r.page && r.scroll) {
        const footer = `\n\n---\nviewport: ${r.viewport.width}x${r.viewport.height}, page: ${r.page.width}x${r.page.height}, scroll: (${r.scroll.x}, ${r.scroll.y})`;
        text = text + footer;
      }
      return {
        content: [{ type: "text", text: text || "(no text found on page)" }],
      };
    }
  );

  server.tool(
    "get_page_html",
    `Get the raw HTML of the current page or a scoped element. Use when you need to parse structure (tables, attribute values, nested data) and \`get_page_text\` strips too much, or when you're extracting structured data from a page Claude can't easily reason about from text alone.

Pierces open AND closed shadow roots for the \`selector\` lookup (Radix portals, Stencil/Lit web components). \`<script>\`, \`<style>\`, \`<noscript>\` are stripped before returning.

Default \`max_chars\` is 50,000. If the page is bigger, the response carries \`truncated: true\` and \`total_chars\` so you can decide whether to scope further with \`selector\`.

When the goal is "is X on this page?" or "find clickable Y", use \`find_text\` instead — it returns a focused match list rather than a wall of HTML.`,
    {
      selector: z
        .string()
        .optional()
        .describe(
          "CSS selector to scope the HTML to. Pierces closed shadow roots. Omit to return the main content area (or body)."
        ),
      max_chars: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe("Truncate after this many chars (default 50000). The response includes total_chars so you know if you missed anything."),
    },
    async ({ selector, max_chars }) => {
      const response = await bridge.request({ type: "get_page_html", selector, max_chars });
      if (response.type !== "page_html_response") throw new Error("Unexpected response");
      const r = response as {
        html: string;
        total_chars: number;
        truncated: boolean;
        selector_missed?: boolean;
        selector_in_shadow?: boolean;
      };
      const notes: string[] = [];
      if (r.selector_missed) notes.push(`selector "${selector}" not found, returning full body HTML`);
      if (r.selector_in_shadow) notes.push(`selector matched inside a closed shadow root`);
      if (r.truncated) notes.push(`truncated at ${max_chars ?? 50000} of ${r.total_chars} chars; scope further with selector to see more`);
      const header = notes.length > 0 ? `[${notes.join("; ")}]\n` : "";
      return {
        content: [{ type: "text", text: header + r.html }],
      };
    }
  );

  server.tool(
    "get_console_logs",
    `Read the browser console output (log, warn, error, info) captured since the page loaded.
Returns the last 200 messages with their level and timestamp.
Use this to check for JavaScript errors, debug React issues, or verify that an action produced the expected console output.
Pass level="error" to see only errors, or omit to see all levels.`,
    {
      level: z
        .enum(["log", "warn", "error", "info"])
        .optional()
        .describe('Filter by log level (e.g. "error" to see only errors). Omit for all levels.'),
    },
    async ({ level }) => {
      const response = await bridge.request({ type: "execute_script", code: `JSON.stringify(window._consoleLogs || [])` });
      if (response.type !== "script_response") throw new Error("Unexpected response");
      let logs: Array<{ level: string; message: string; time: number }>;
      try {
        logs = JSON.parse((response as { result: string }).result);
      } catch {
        return { content: [{ type: "text", text: "No console logs captured (console capture may not be injected on this page yet — navigate first)." }] };
      }
      if (level) logs = logs.filter(l => l.level === level);
      if (logs.length === 0) {
        return { content: [{ type: "text", text: level ? `No ${level}-level console messages.` : "No console messages captured." }] };
      }
      const lines = logs.map(l => {
        const time = new Date(l.time).toISOString().slice(11, 23);
        return `[${time}] ${l.level.toUpperCase()}: ${l.message.slice(0, 500)}`;
      });
      return { content: [{ type: "text", text: `Console logs (${logs.length} entries):\n${lines.join("\n")}` }] };
    }
  );
}
