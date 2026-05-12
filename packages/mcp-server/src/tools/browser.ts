import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, copyFileSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import type { WsBridge } from "../ws-bridge.js";

export function registerBrowserTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "open_page",
    `Navigate to a URL. By default reuses the active tab. Set new_tab=true to open alongside the current tab without losing it. After navigating, call get_page_text to read the page — do NOT take a screenshot.

Set background=true (only with new_tab=true) to open the new tab WITHOUT switching focus to it. Use this when the current tab has a partially-filled form whose page auto-saves on focus loss (e.g. eBay seller listings) — switching away would trigger the auto-save and corrupt the in-progress draft.`,
    {
      url: z.string().url().describe("The URL to navigate to"),
      new_tab: z.boolean().optional().describe("Open in a new tab instead of replacing the current one (default false)"),
      background: z
        .boolean()
        .optional()
        .describe("If new_tab=true, do not switch focus to the new tab. Default false. Ignored when new_tab is false."),
    },
    async ({ url, new_tab, background }) => {
      await bridge.request({ type: "navigate", url, newTab: new_tab ?? false, background: background ?? false });
      return {
        content: [{ type: "text", text: `Navigated to ${url}${new_tab ? (background ? " (new background tab)" : " (new tab)") : ""}` }],
      };
    }
  );

  server.tool(
    "switch_to_tab",
    `Switch the active tab to a different open tab. Use this after open_page(new_tab=true) to switch back to the original tab, or to jump between tabs.
Accepts: a tab number (1-based), a URL substring, or a title substring.
Pass it as either \`tab\` (mirrors the verb in the tool name — natural when targeting by index) or \`query\` (clearer when matching by URL/title substring). Both work identically.
Examples: switch_to_tab({tab: 1}) for the first tab, switch_to_tab({tab: "form"}) or switch_to_tab({query: "form"}) for a tab whose URL or title contains "form".`,
    {
      query: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Tab number (1-based), URL substring, or title substring to match. Alias for `tab`."),
      tab: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Tab number (1-based), URL substring, or title substring to match. Alias for `query`."),
    },
    async ({ query, tab }) => {
      const raw = query ?? tab;
      if (raw === undefined || raw === null || raw === "") {
        return {
          content: [
            { type: "text", text: "switch_to_tab requires either `tab` or `query` — a 1-based index, URL substring, or title substring." },
          ],
        };
      }
      const q = String(raw);
      await bridge.request({ type: "switch_to_tab", query: q });
      return {
        content: [{ type: "text", text: `Switched to tab matching "${q}"` }],
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
    `Capture a screenshot of the active tab. By default returns the PNG to the agent only; set save_to or copy_to_clipboard to also share it. Reserved for cases where DOM lookup has already failed — use get_page_text and find_text for reading content.`,
    {
      copy_to_clipboard: z
        .boolean()
        .optional()
        .describe("Copy the PNG to the system clipboard (macOS only). Default false."),
      save_to: z
        .enum(["downloads", "cwd", "none"])
        .optional()
        .describe('Save the PNG to disk: "downloads" (~/Downloads), "cwd" (Claude\'s working directory), or "none" (default — image returned only to Claude).'),
    },
    async ({ copy_to_clipboard = false, save_to = "none" }) => {
      const sharing = copy_to_clipboard || save_to !== "none";
      // grid:false when sharing — coord grid is noise when the image is for
      // pasting into chats / uploading to forms.
      const response = await bridge.request({ type: "screenshot", grid: !sharing });
      if (response.type !== "screenshot_response") {
        throw new Error("Unexpected response from extension");
      }

      if (!sharing) {
        return {
          content: [
            { type: "image", data: response.image, mimeType: "image/png" },
            {
              type: "text",
              text: `Screenshot captured (${response.width}x${response.height}). Analyze the image to identify element positions for highlighting.`,
            },
          ],
        };
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `chromeflow-${timestamp}.png`;
      const imageBuffer = Buffer.from(response.image, "base64");

      // Write to temp file first (needed for osascript clipboard copy)
      const tmpPath = join(tmpdir(), filename);
      writeFileSync(tmpPath, imageBuffer);

      const notes: string[] = [];
      if (save_to !== "none") {
        const savePath = save_to === "cwd"
          ? join(process.cwd(), filename)
          : join(homedir(), "Downloads", filename);
        copyFileSync(tmpPath, savePath);
        notes.push(`Saved to ${savePath}`);
      }
      if (copy_to_clipboard) {
        try {
          execSync(`osascript -e 'set the clipboard to (read (POSIX file "${tmpPath}") as «class PNGf»)'`);
          notes.push("Copied to clipboard");
        } catch {
          // best effort — non-mac platforms silently skip
        }
      }

      return {
        content: [
          { type: "image", data: response.image, mimeType: "image/png" },
          { type: "text", text: notes.length ? notes.join(". ") + "." : `Screenshot captured (${response.width}x${response.height}).` },
        ],
      };
    }
  );

  server.tool(
    "capture_terminal",
    `Capture a screenshot of the terminal window (Terminal, iTerm2, Warp, VS Code, Ghostty, etc.) and save it as a PNG.
Use this when you need a screenshot of terminal output — e.g. test results, build logs, or command output — to upload to a form via set_file_input.
Auto-detects the terminal app. Returns the image to Claude AND saves the PNG file.
The saved file path can be passed directly to set_file_input(hint, file_path) to upload it.`,
    {
      save_to: z
        .enum(["downloads", "cwd"])
        .optional()
        .describe('Where to save the PNG: "downloads" (~/Downloads, default) or "cwd" (working directory)'),
    },
    async ({ save_to = "downloads" }) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `terminal-${timestamp}.png`;
      const savePath = save_to === "cwd"
        ? join(process.cwd(), filename)
        : join(homedir(), "Downloads", filename);

      // Try to find a terminal window and capture just that window's bounds
      let captured = false;
      try {
        const bounds = execSync(`osascript -e '
          tell application "System Events"
            set termApps to {"Terminal", "iTerm2", "Warp", "kitty", "Alacritty", "Ghostty", "Code", "Cursor", "Windsurf"}
            repeat with appName in termApps
              if exists process (contents of appName) then
                tell process (contents of appName)
                  if (count of windows) > 0 then
                    set win to window 1
                    set pos to position of win
                    set sz to size of win
                    return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)
                  end if
                end tell
              end if
            end repeat
            error "No terminal window found"
          end tell
        '`, { timeout: 5000 }).toString().trim();

        execSync(`screencapture -x -R${bounds} "${savePath}"`, { timeout: 5000 });
        captured = true;
      } catch {
        // Fallback: capture entire screen
        try {
          execSync(`screencapture -x "${savePath}"`, { timeout: 5000 });
          captured = true;
        } catch { /* screencapture requires screen recording permission */ }
      }

      if (!captured) {
        return {
          content: [{ type: "text", text: "Failed to capture terminal. Ensure Screen Recording permission is granted to your terminal app in System Settings > Privacy & Security > Screen Recording." }],
        };
      }

      // Read the captured image for returning to Claude
      const imageBuffer = readFileSync(savePath);
      const base64 = imageBuffer.toString("base64");

      // Copy to clipboard
      let clipboardNote = "";
      try {
        execSync(`osascript -e 'set the clipboard to (read (POSIX file "${savePath}") as «class PNGf»)'`);
        clipboardNote = "Copied to clipboard. ";
      } catch { /* ignore */ }

      return {
        content: [
          { type: "image", data: base64, mimeType: "image/png" },
          { type: "text", text: `${clipboardNote}Saved to ${savePath}` },
        ],
      };
    }
  );

  server.tool(
    "clear_overlays",
    "Remove all highlights and callout annotations from the current page.",
    {},
    async () => {
      await bridge.request({ type: "clear" });
      return {
        content: [{ type: "text", text: "All overlays cleared." }],
      };
    }
  );

  server.tool(
    "get_form_fields",
    `Inventory form fields on the active page (inputs, textareas, selects, CodeMirror editors). Sorted top-to-bottom by y-position; includes fields below the fold.

Pass \`query\` to filter+rank by label/placeholder/aria-label/name/id (the old find_input behavior — match strength reported as aria-eq / placeholder-eq / label-text-eq / name-eq / id-eq / *-includes / fuzzy-text-walk). Pass \`exact: true\` to refuse fuzzy text-walk matches.`,
    {
      query: z.string().optional().describe("If set, filter+rank fields by hint matching label/placeholder/aria-label/name/id."),
      max: z.number().int().min(1).optional().describe("Maximum fields to return when query is set (default 5). Ignored without query (full inventory)."),
      type_filter: z.string().optional().describe('Restrict to a specific input type (e.g. "email", "checkbox", "file"). Only with query.'),
      exact: z.boolean().optional().describe("Refuse fuzzy text-walk and *-includes matches. Only with query."),
      frame: z.string().optional().describe("Same-origin iframe CSS selector to search inside. Cross-origin iframes are not supported."),
    },
    async ({ query, max, type_filter, exact, frame }) => {
      if (query !== undefined) {
        // Filtered mode — route to find_input bridge message.
        const response = await bridge.request({ type: "find_input", query, type_filter, max, exact, frame });
        if (response.type !== "find_input_response") throw new Error("Unexpected response");
        const r = response as { fields: Array<{ label: string; placeholder: string; type: string; value: string; under?: string; position: unknown; match_kind: string }>; total_matches: number; truncated: boolean; frame_error?: string };
        if (r.frame_error) return { content: [{ type: "text", text: r.frame_error }] };
        if (r.fields.length === 0) return { content: [{ type: "text", text: `No form fields matched "${query}".` }] };
        const header = `Found ${r.fields.length}${r.truncated ? ` of ${r.total_matches}` : ""} input(s) for "${query}":`;
        const lines = r.fields.map((f, i) => {
          const ph = f.placeholder ? ` placeholder="${f.placeholder}"` : "";
          const val = f.value ? ` value="${f.value}"` : "";
          const under = f.under ? ` [under: "${f.under}"]` : "";
          return `  ${i + 1}. "${f.label}" type=${f.type}${ph}${val}${under} — match: ${f.match_kind}`;
        });
        return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}\n\nTo fill: fill_input("${r.fields[0].label}", "<value>")` }] };
      }
      // Inventory mode.
      const response = await bridge.request({ type: "get_form_fields" });
      if (response.type !== "form_fields_response") throw new Error("Unexpected response");
      const r = response as { fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string; context?: string }>; warning?: string };
      const fields = r.fields;
      if (fields.length === 0) return { content: [{ type: "text", text: "No form fields found on page." + (r.warning ?? "") }] };
      const lines = fields.map(f => {
        const val = f.value ? ` [currently: "${f.value}"]` : "";
        const ctx = f.context ? ` [under: "${f.context}"]` : "";
        return `${f.index}. [${f.type}] "${f.label}"${val}${ctx} — y:${f.y}`;
      });
      return { content: [{ type: "text", text: `Form fields (${fields.length} total, sorted top-to-bottom):\n${lines.join("\n")}${r.warning ?? ""}` }] };
    }
  );

  server.tool(
    "type_text",
    `Type text into the currently focused element via CDP keystrokes (produces isTrusted=true events). Use when fill_input fails because the page validates isTrusted (CodeMirror/Monaco/Ace editors, shadow DOM inputs, isTrusted-gated forms). The caller is responsible for focusing the target first (via click_element or execute_script). Pass \`frame: "iframe.selector"\` to type into a same-origin iframe's first editable element.`,
    {
      text: z.string().describe("The text to type into the focused element"),
      frame: z
        .string()
        .optional()
        .describe(
          "CSS selector for an iframe whose contents you want to type into (e.g. 'iframe.se-rte-frame__summary'). Same-origin only. Before typing, the first contenteditable/input inside the iframe is focused; after typing, input/change events are dispatched in the iframe's context."
        ),
    },
    async ({ text, frame }) => {
      // Average ~90ms per char (60ms avg delay + overhead) + 15s buffer for
      // debugger attach/detach and the post-typing input event dispatch.
      const timeoutMs = Math.max(30_000, text.length * 90 + 15_000);
      const response = await bridge.request({ type: "type_text", text, frame }, timeoutMs);
      const r = response as { success?: boolean; message?: string };
      return {
        content: [{ type: "text", text: r.message ?? (r.success ? "Text typed successfully" : "Failed to type text") }],
      };
    }
  );

  server.tool(
    "set_file_input",
    "Upload a file to a file input — works even when the input is hidden behind a custom drag-and-drop zone. Returns success=true only after an observable commit (file count goes up, input gets reset, or verify_selector appears within wait_ms). See CLAUDE.md for batch-upload guidance.",
    {
      hint: z.string().describe("Label text, name, or surrounding text of the file input. Use empty string to target the first file input on the page."),
      file_path: z.string().describe("Absolute path to the file to upload (e.g. /Users/you/Downloads/task.zip)"),
      wait_ms: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("How long to wait for an observable change after setting the file (default 3000). Increase for slow uploaders that take a moment to render thumbnails."),
      verify_selector: z
        .string()
        .optional()
        .describe('Optional CSS selector that should appear after a successful upload (e.g. ".photo-thumbnail", "[data-uploaded=true]"). When matched, set_file_input returns success immediately.'),
    },
    async ({ hint, file_path, wait_ms, verify_selector }) => {
      // The WS request must outlive the upload-poll, with margin for CDP attach.
      const wsTimeout = Math.max(30_000, (wait_ms ?? 3000) + 10_000);
      const response = await bridge.request(
        { type: "set_file_input", hint, filePath: file_path, waitMs: wait_ms, verifySelector: verify_selector },
        wsTimeout
      );
      const r = response as { success?: boolean; message?: string };
      return {
        content: [{ type: "text", text: r.message ?? (r.success ? "File set successfully" : "Failed to set file") }],
      };
    }
  );

  server.tool(
    "execute_script",
    `Execute JavaScript in the current page's context and return the result. Use for reading framework state or DOM properties not visible in text — prefer get_page_text for visible content. Top-level \`return\` and \`await\` are supported.

CSP-strict pages (Stripe, GitHub) silently fall through to a CDP eval path. Page alerts (alert/confirm/prompt) fired since the last script appear as PAGE ALERT in the result.`,
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

  server.tool(
    "inspect_request_headers",
    `Navigate to a URL and capture the request headers Chrome sends for the main document — useful for diagnosing server-side bot detection. Returns method, URL, and all headers. Cookie values are redacted by default to avoid leaking session tokens into the agent context; pass redact_cookies: false to see them. This tool DOES navigate the active tab.`,
    {
      url: z.string().url().describe("URL to navigate to and capture headers for"),
      redact_cookies: z.boolean().optional().describe("Replace each cookie's value with [REDACTED]. Default true. Set false only when you genuinely need the cookie content for debugging."),
    },
    async ({ url, redact_cookies = true }) => {
      const response = await bridge.request({ type: "inspect_request_headers", url }, 20_000);
      const r = response as { message?: string };
      let text = r.message ?? "(no headers captured)";
      if (redact_cookies) {
        // Redact the `cookie:` header value. Format from the extension is
        // "cookie: name1=val1; name2=val2" — replace each value with [REDACTED].
        text = text.replace(/^(cookie:\s*)(.+)$/gim, (_m, prefix, body) => {
          const pairs = String(body).split(";").map(s => s.trim()).filter(Boolean);
          const names = pairs.map(p => p.split("=")[0]);
          return `${prefix}[REDACTED — ${pairs.length} cookies: ${names.join(", ")}]`;
        });
      }
      return {
        content: [{ type: "text", text }],
      };
    }
  );
}
