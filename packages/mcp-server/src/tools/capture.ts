import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { WsBridge } from "../ws-bridge.js";

const PAGE_STATE_FILE = join(tmpdir(), "chromeflow_page_state.json");

export function registerCaptureTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "fill_input",
    `Fill a form input field with a value automatically.
Use this for fields Claude knows the answer to (product name, price, description, tier name, URLs, etc.).
DO NOT use for: email address, password, payment/billing info, phone number — highlight those instead and tell the user what to enter.
After filling, call wait_for_click only if the user needs to review/confirm; otherwise proceed directly to the next step.`,
    {
      textHint: z
        .string()
        .describe("The label, placeholder, or nearby text identifying the input (e.g. 'Product name', 'Amount', 'Description')"),
      value: z
        .string()
        .describe("The value to fill in"),
      nth: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Which match to fill when multiple inputs share the same label (1 = first/topmost, default 1)"),
    },
    async ({ textHint, value, nth }) => {
      const response = await bridge.request({ type: "fill_input", textHint, value, nth });
      if (response.type !== "fill_response") throw new Error("Unexpected response");
      const r = response as { success: boolean; message: string };
      return {
        content: [{ type: "text", text: r.success ? `Filled "${textHint}": ${r.message}` : `Could not fill "${textHint}": ${r.message}` }],
      };
    }
  );

  server.tool(
    "read_element",
    "Read the text value of an element on the page, identified by nearby visible text. Use this to capture API keys, IDs, or other values shown on the page.",
    {
      textHint: z
        .string()
        .describe(
          "Visible text near or within the element whose value you want to read (e.g. 'Publishable key', 'sk-live')"
        ),
    },
    async ({ textHint }) => {
      const response = await bridge.request({ type: "read_element", textHint });
      if (response.type !== "read_response") {
        throw new Error("Unexpected response from extension");
      }
      if (response.value === null) {
        return {
          content: [
            {
              type: "text",
              text: `Could not find a value near "${textHint}". Try take_screenshot to locate it.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Value captured: ${response.value}`,
          },
        ],
      };
    }
  );

  server.tool(
    "get_page_text",
    `Get the visible text content of the current page without taking a screenshot.
Use this instead of take_screenshot whenever you need to read what's on the page — errors, build status, form labels, confirmation messages, etc.
Returns up to 20,000 characters at a time. If the response ends with "... (N more characters)", call again with startIndex to read the next chunk.
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
      const text = (response as { text: string }).text;
      return {
        content: [{ type: "text", text: text || "(no text found on page)" }],
      };
    }
  );

  server.tool(
    "save_page_state",
    `Snapshot the current values of all form fields (inputs, textareas, checkboxes, selects, CodeMirror editors) to a local file.
Use this before a context window runs out or any time you want a checkpoint mid-form.
A future session can call restore_page_state to pick up exactly where you left off.`,
    {},
    async () => {
      const response = await bridge.request({ type: "save_page_state" });
      if (response.type !== "save_state_response") throw new Error("Unexpected response");
      const state = (response as { state: unknown[] }).state;
      writeFileSync(PAGE_STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
      return {
        content: [{ type: "text", text: `Saved ${state.length} field values to ${PAGE_STATE_FILE}. Call restore_page_state in a future session to reload them.` }],
      };
    }
  );

  server.tool(
    "restore_page_state",
    `Restore form field values from a previously saved snapshot (created by save_page_state).
Use this at the start of a new session when resuming a long form-filling task.
The snapshot is read from the local temp file written by save_page_state.`,
    {},
    async () => {
      let state: import("../types.js").PageFieldState[];
      try {
        state = JSON.parse(readFileSync(PAGE_STATE_FILE, "utf-8")) as import("../types.js").PageFieldState[];
      } catch {
        return {
          content: [{ type: "text", text: `No saved page state found at ${PAGE_STATE_FILE}. Call save_page_state first.` }],
        };
      }
      const response = await bridge.request({ type: "restore_page_state", state });
      const msg = (response as { message?: string }).message ?? "Done";
      return {
        content: [{ type: "text", text: msg }],
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

  server.tool(
    "write_to_env",
    "Write a key=value pair to a .env file. Use this after capturing an API key or ID from the page.",
    {
      key: z.string().describe("Environment variable name (e.g. STRIPE_SECRET_KEY)"),
      value: z.string().describe("The value to write"),
      envPath: z
        .string()
        .describe(
          "Absolute path to the .env file (e.g. /Users/me/myproject/.env)"
        ),
    },
    async ({ key, value, envPath }) => {
      try {
        // Read existing content and update in-place if key exists, else append
        let existing = "";
        try {
          existing = readFileSync(envPath, "utf-8");
        } catch {
          // File doesn't exist yet, will create it
        }

        const lines = existing.split("\n");
        const keyPattern = new RegExp(`^${key}=`);
        const existingIndex = lines.findIndex((l) => keyPattern.test(l));

        if (existingIndex !== -1) {
          lines[existingIndex] = `${key}=${value}`;
          writeFileSync(envPath, lines.join("\n"), "utf-8");
        } else {
          // Append, ensuring file ends with newline
          const toAppend =
            (existing && !existing.endsWith("\n") ? "\n" : "") +
            `${key}=${value}\n`;
          appendFileSync(envPath, toAppend, "utf-8");
        }

        return {
          content: [
            {
              type: "text",
              text: `Written ${key}=<value> to ${envPath}`,
            },
          ],
        };
      } catch (err) {
        throw new Error(`Failed to write to .env: ${(err as Error).message}`);
      }
    }
  );
}
