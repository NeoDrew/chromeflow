import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve, relative, isAbsolute } from "path";
import type { WsBridge } from "../ws-bridge.js";

const PAGE_STATE_FILE = join(tmpdir(), "chromeflow_page_state.json");

export function registerCaptureTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "fill_input",
    `Fill a form input field with a value automatically.
Use this for fields Claude knows the answer to (product name, price, description, tier name, URLs, etc.).
DO NOT use for: email address, password, payment/billing info, phone number — highlight those instead and tell the user what to enter.
After filling, call wait_for_click only if the user needs to review/confirm; otherwise proceed directly to the next step.

The response always includes the matched element's identifying attributes (e.g. \`<input name="title" id="..." placeholder="...">\`) and the match-strength (aria-eq, name-eq, fuzzy-text-walk, etc.). VERIFY this is the field you intended — fuzzy-text-walk matches are the lowest-confidence kind and have historically caused fill_input to land on the wrong field on dense forms.

Pass \`exact: true\` to refuse fuzzy text-walk matches entirely. Use this for short generic labels like "Rate", "Price", or "Amount" on dense forms with many similarly-labeled fields. If no exact match exists, fill_input returns success=false instead of silently filling the wrong field.`,
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
      exact: z
        .boolean()
        .optional()
        .describe("If true, only match aria-label/placeholder/name/id/label-text equal to the hint — refuse fuzzy text-walk matches. Default false."),
    },
    async ({ textHint, value, nth, exact }) => {
      const response = await bridge.request({ type: "fill_input", textHint, value, nth, exact });
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
        // Security: restrict writes to paths under the MCP server's working
        // directory (the Claude Code project root). Prevents accidental or
        // adversarial writes to sensitive locations like ~/.ssh/config,
        // ~/.zshrc, or other dotfiles outside the project.
        const cwd = process.cwd();
        const resolved = isAbsolute(envPath) ? envPath : resolve(cwd, envPath);
        const rel = relative(cwd, resolved);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error(
            `Refusing to write .env outside the project directory. Target "${resolved}" is not under "${cwd}". If this is intentional, move the project to include the target path.`
          );
        }
        // Additional safety: filename must look like a .env file (.env, .env.local, .env.production etc.)
        const filename = resolved.split("/").pop() ?? "";
        if (!/^\.env(\.[\w-]+)?$/.test(filename)) {
          throw new Error(
            `Refusing to write: "${filename}" doesn't look like an env file. Expected .env, .env.local, .env.<name>, etc.`
          );
        }
        envPath = resolved;

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

  server.tool(
    "read_attachment",
    `Fetch a file from a URL using the user's Chrome session and return its text content directly, with no intermediate save-to-disk step.

This is the "I just need the text" companion to download_file. It uses the same privileged fetch (Chrome cookie jar, page CSP doesn't apply), but parses the body inside the extension instead of writing to disk.

Supported formats:
- **docx** — parsed via in-browser ZIP extraction (no local CLI needed)
- **txt, md, csv, json** — decoded as UTF-8
- **html, xml** — UTF-8 decoded then tags stripped
- **pdf** — DEFERRED to chromeflow 0.9.4. For now, use \`download_file({url})\` then run \`pdftotext\` (poppler-utils) or \`textutil -convert txt\` (macOS) on the returned path. The error message includes this fallback recipe.

Pass \`format\` to override auto-detection (auto-detection looks at the Content-Type header and the URL extension).

The response is truncated to max_chars (default 50000); the response always reports total_chars and truncated so the caller can decide whether to call again with a larger budget or paginate.`,
    {
      url: z.string().describe("The full URL of the attachment (https://...). Uses Chrome's cookie jar — works on authenticated URLs."),
      format: z
        .enum(["txt", "md", "csv", "json", "xml", "html", "docx", "pdf"])
        .optional()
        .describe("Override format auto-detection. Useful when Content-Type is wrong or missing."),
      max_chars: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum characters to return (default 50000). Response reports total_chars + truncated so you can paginate or expand."),
    },
    async ({ url, format, max_chars }) => {
      const response = await bridge.request({ type: "read_attachment", url, format, max_chars });
      if (response.type !== "read_attachment_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as { text: string; format: string; total_chars: number; truncated: boolean; mime: string };
      const header = `${url}\nformat: ${r.format} | mime: ${r.mime || "unknown"} | total_chars: ${r.total_chars}${r.truncated ? ` (truncated to ${max_chars ?? 50_000})` : ""}\n${"─".repeat(40)}\n`;
      return {
        content: [{ type: "text", text: header + r.text }],
      };
    }
  );

  server.tool(
    "download_file",
    `Download a file from a URL to the user's local disk using Chrome's authenticated download flow.

Uses the user's existing Chrome session, so this works on authenticated URLs (Canvas attachments, Stripe document downloads, GitHub release tarballs behind SSO) without any auth setup on chromeflow's side. Returns the absolute path where the file landed, plus MIME type and byte size.

Use this when you need the BYTES of a file (binary parsing, large content, anything you'll process with another tool). For "I just need the text content of this attachment" use read_attachment instead — it downloads + parses in one call.

The file is saved to the user's default downloads directory (usually ~/Downloads). Pass filename to suggest a name; Chrome will add a numeric suffix if a file with that name already exists.`,
    {
      url: z.string().describe("The full URL to download (https://...). Chrome's cookie jar is automatically used."),
      filename: z.string().optional().describe("Suggested filename (Chrome will uniquify if it collides). Default: derived from URL or Content-Disposition header."),
      timeout_ms: z.number().int().min(1000).optional().describe("Abort if the download isn't complete in this many ms (default 60000)."),
    },
    async ({ url, filename, timeout_ms }) => {
      const response = await bridge.request({ type: "download_file", url, filename, timeout_ms }, Math.max(30_000, (timeout_ms ?? 60_000) + 5_000));
      if (response.type !== "download_file_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as { path: string; mime: string; size: number };
      return {
        content: [{
          type: "text",
          text: `Downloaded ${url} → ${r.path}\nMIME: ${r.mime || "unknown"}\nSize: ${r.size} bytes`,
        }],
      };
    }
  );

  server.tool(
    "fetch_url",
    `Make an HTTP request to a URL from the extension's privileged context, bypassing the page's Content-Security-Policy.

This is the "privileged context for network access" companion to execute_script. The mental model:
- **execute_script (page context):** DOM access, page CSP applies, fetch() blocked by connect-src.
- **fetch_url (privileged context):** no DOM, full extension host_permissions (<all_urls>), Chrome's cookie jar included automatically, page CSP does not apply.

Use this when:
- You need bytes from an authenticated URL the user is already signed into (Canvas attachments, Stripe document downloads, internal API JSON).
- fetch() inside execute_script returns "Failed to fetch" or hits a Content-Security-Policy connect-src error.
- You want a clean response object (status, headers, body) instead of having to wire up your own request handling in page-context JS.

Returns: { status, status_text, headers, content_type, body_text or body_base64 (when binary), truncated, total_bytes }.
Cookies and Origin headers are set by Chrome — pass any extra request headers via the headers param.
Set binary=true for non-text responses (PDFs, images, zips) — the body is returned base64-encoded.`,
    {
      url: z.string().describe("The full URL to fetch (https://...). Same-origin or cross-origin, both work."),
      method: z
        .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"])
        .optional()
        .describe("HTTP method (default GET)"),
      headers: z
        .record(z.string())
        .optional()
        .describe("Extra request headers (e.g. {'X-CSRF-Token': '...', 'Accept': 'application/json'}). Cookies are added automatically; do not set them here."),
      body: z
        .string()
        .optional()
        .describe("Request body for POST/PUT/PATCH/DELETE (ignored for GET/HEAD). Pass JSON as a string."),
      binary: z
        .boolean()
        .optional()
        .describe("If true, return body as base64 (body_base64). Use for PDFs, images, zips. Default false (UTF-8 text in body_text)."),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe("Abort the request after this many ms (default 30000)."),
      max_bytes: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Truncate body at this many bytes (default 2000000 ≈ 2MB). The response reports truncated:true and total_bytes for paginating."),
    },
    async ({ url, method, headers, body, binary, timeout_ms, max_bytes }) => {
      const response = await bridge.request({
        type: "fetch_url",
        url,
        method,
        headers,
        body,
        binary,
        timeout_ms,
        max_bytes,
      });
      if (response.type !== "fetch_url_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as {
        status: number;
        status_text: string;
        headers: Record<string, string>;
        content_type: string;
        body_text?: string;
        body_base64?: string;
        truncated: boolean;
        total_bytes: number;
      };
      const header = `HTTP ${r.status} ${r.status_text} — ${r.content_type || "no content-type"} — ${r.total_bytes} bytes${r.truncated ? ` (truncated to ${max_bytes ?? 2_000_000})` : ""}`;
      const bodyPart = r.body_base64
        ? `\n\n[base64, ${r.body_base64.length} chars]\n${r.body_base64}`
        : r.body_text !== undefined
          ? `\n\n${r.body_text}`
          : "";
      return {
        content: [{ type: "text", text: header + bodyPart }],
      };
    }
  );
}
