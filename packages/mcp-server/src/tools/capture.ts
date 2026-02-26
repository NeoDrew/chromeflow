import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import type { WsBridge } from "../ws-bridge.js";

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
    },
    async ({ textHint, value }) => {
      const response = await bridge.request({ type: "fill_input", textHint, value });
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
