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
    `Capture a screenshot of the current page. By default returns the image to Claude only; pass copy_to_clipboard or save_to to also share the image outside Claude (paste into a chat, upload to a form, keep as a file).

IMPORTANT: Do NOT use this to read page content — call get_page_text instead, which is faster and returns searchable text. Screenshots are ONLY for locating an element's pixel coordinates when DOM queries have already failed. Never take a screenshot immediately after open_page, scroll_page, or click_element. Never take more than 1-2 screenshots in a row.`,
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
    "record_window",
    `Record a video of the active tab as a WebM file. Use when the user wants to share a recording (bug repro, flow demo, hand-off to a teammate) — drag into Slack, paste into Messages, attach to an issue.

The video is NOT returned inline to Claude (WebM can't be rendered in chat, and the bytes would blow context). The response is text-only: saved path, file size, duration. Pass copy_to_clipboard=true to also put the file on the macOS clipboard so it pastes as an upload in Slack/Messages/Notion or as a Finder alias.

The tool blocks for duration_ms while recording. Tab audio is captured only when include_audio=true (default off); when on, the tab continues to play audibly during recording.`,
    {
      duration_ms: z
        .number()
        .int()
        .min(500)
        .max(120_000)
        .describe("Recording length in milliseconds. Range 500-120000 (0.5s to 2min)."),
      include_audio: z
        .boolean()
        .optional()
        .describe("Capture the tab's audio in addition to video. Default false."),
      save_to: z
        .enum(["downloads", "cwd", "none"])
        .optional()
        .describe('Where to save the WebM: "downloads" (~/Downloads, default), "cwd" (Claude\'s working directory), or "none" (only written to /tmp).'),
      copy_to_clipboard: z
        .boolean()
        .optional()
        .describe("Copy a file reference to the system clipboard so it pastes as an upload (macOS only). Default false."),
    },
    async ({ duration_ms, include_audio = false, save_to = "downloads", copy_to_clipboard = false }) => {
      const wsTimeoutMs = duration_ms + 15_000;
      const response = await bridge.request(
        { type: "record_window", durationMs: duration_ms, includeAudio: include_audio },
        wsTimeoutMs
      );
      if (response.type !== "record_window_response") {
        throw new Error("Unexpected response from extension");
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `chromeflow-${timestamp}.webm`;
      const videoBuffer = Buffer.from(response.video, "base64");
      const tmpPath = join(tmpdir(), filename);
      writeFileSync(tmpPath, videoBuffer);

      let savedPath = tmpPath;
      const notes: string[] = [];
      if (save_to !== "none") {
        savedPath = save_to === "cwd"
          ? join(process.cwd(), filename)
          : join(homedir(), "Downloads", filename);
        copyFileSync(tmpPath, savedPath);
      }

      let clipboardNote = "";
      if (copy_to_clipboard) {
        try {
          execSync(`osascript -e 'set the clipboard to (POSIX file "${savedPath}")'`);
          clipboardNote = " Clipboard: file reference copied (paste into Slack/Messages/Finder).";
        } catch {
          // best effort — non-mac platforms silently skip
        }
      }

      const sizeKb = response.sizeBytes / 1024;
      const sizeStr = sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb.toFixed(0)} KB`;
      const durationStr = `${(response.durationMs / 1000).toFixed(1)}s`;
      const summary = save_to === "none"
        ? `Recorded ${durationStr} (${sizeStr}). Written to ${tmpPath} (no save_to set).${clipboardNote}`
        : `Recorded ${durationStr} (${sizeStr}) → ${savedPath}.${clipboardNote}`;

      return {
        content: [{ type: "text", text: summary }],
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
    "set_dialog_response",
    `Pre-set the return value for the next window.prompt() or window.confirm() dialog.
Call this BEFORE triggering an action that will show a dialog (e.g. a "Save As" button that calls prompt()).
The response is consumed once — after the dialog fires, it resets to default behavior.
For prompt: the value string is returned to the page. For confirm: true/false is returned.`,
    {
      type: z.enum(["prompt", "confirm"]).describe('Which dialog type to pre-fill: "prompt" or "confirm"'),
      value: z.string().describe('For prompt: the string to return. For confirm: "true" or "false"'),
    },
    async ({ type, value }) => {
      const jsValue = type === "confirm" ? (value === "true") : value;
      const code = `window._chromeflowDialogResponse = window._chromeflowDialogResponse || {}; window._chromeflowDialogResponse.${type} = ${JSON.stringify(jsValue)}; "set"`;
      await bridge.request({ type: "execute_script", code });
      return {
        content: [{ type: "text", text: `Next ${type}() will return ${JSON.stringify(jsValue)}. Now trigger the action that shows the dialog.` }],
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
    "get_elements",
    `Get the exact pixel positions of all visible interactive elements on the page (inputs, buttons, links, selects).
Use this INSTEAD OF take_screenshot when you need coordinates for highlight_region — the coordinates are exact DOM values, not estimates.
Returns a numbered list with element type, label, and precise x/y/width/height in CSS pixels.
IMPORTANT: x/y are VIEWPORT-relative (0,0 = top-left of the visible area). Use these exact values directly in highlight_region — do not add window.scrollY.
Use get_form_fields instead if you need document y positions or fields below the fold.`,
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
    "type_text",
    `Type text into the currently focused element using trusted keyboard events via Chrome DevTools Protocol.
Unlike fill_input (which sets .value programmatically), this produces real keystrokes that pass isTrusted checks. Use this when:
- fill_input fails because the site validates event.isTrusted (e.g. Outlier, DataAnnotation code editors)
- The target is a shadow DOM input, custom web component, or heavily guarded editor
- You need to type into a CodeMirror/Monaco/Ace editor that rejects programmatic value changes
- The target lives inside a same-origin iframe (e.g. eBay's "se-rte" rich-text description editor) — pass the iframe's CSS selector via the \`frame\` parameter

Usage: first click_element or execute_script to focus the target field, then call type_text with the content.
To clear existing content before typing, use execute_script("document.execCommand('selectAll')") first.

For iframe contenteditables: pass \`frame\` (a CSS selector for the iframe). type_text descends into the iframe, focuses its first editable element, types via CDP, then dispatches input/change in the iframe's context so React picks up the change. Same-origin iframes only — cross-origin iframes will return an error.`,
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
    "react_set_input",
    `Set the value of a React-controlled input via the native value-setter, dispatching the input/change events that React's onChange handler listens for.

Use this instead of writing your own \`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set\` script — this helper handles the prototype-from-instance gotcha automatically (inputs inside iframes have their own HTMLInputElement constructor, and using the outer-window prototype throws "Illegal invocation").

Common cases:
- A standard input that fill_input fails on because the page validates event.isTrusted or uses an exotic React Hook Form setup.
- An input inside a same-origin iframe (pass frame="iframe.selector").
- A hidden React-Select combobox input (selector='input[id*="react-select-3-input"]').

Returns the matched element's tag/name/id/type so you can verify it was the right field, and the read-back value so you can spot when React rejected the new value.`,
    {
      selector: z.string().describe("CSS selector of the input to set (e.g. 'input[name=email]', '#promoted-rate-input')"),
      value: z.string().describe("The value to set"),
      frame: z
        .string()
        .optional()
        .describe('Optional CSS selector for a same-origin iframe whose contents contain the input (e.g. "iframe.se-rte-frame"). Cross-origin iframes are not supported.'),
    },
    async ({ selector, value, frame }) => {
      const response = await bridge.request({ type: "react_set_input", selector, value, frame });
      const r = response as { success?: boolean; message?: string };
      return {
        content: [{ type: "text", text: r.message ?? (r.success ? "Set" : "Failed to set") }],
      };
    }
  );

  server.tool(
    "react_call_prop",
    `Walk up the React fiber from a DOM element and call a named prop on the nearest component that has it. Use this as an escape hatch when the UI swallows clicks or a modal never renders — e.g. calling handleForceSubmitConfirmation directly to bypass a stuck submit modal.

Common cases:
- A submit button whose onClick opens a modal that never appears (validation thinks the form is incomplete because the form-level state is stale, even though the inputs look filled). Walk up to the page-level component and call the bypass handler directly.
- An onChange handler that the synthetic-event path didn't reach (when click_element fired but React's form-level store wasn't updated).

args MUST be JSON-serializable (primitives, arrays, plain objects). Functions, DOM nodes, and Promises cannot be passed in.

Returns the component name (when available), the fiber depth where the prop was found, and a stringified version of the return value. If the prop function returned a Promise, react_call_prop awaits it before returning.`,
    {
      selector: z.string().describe("CSS selector of any element inside the target component's subtree (e.g. 'input[name=\"justification\"]', '#submit-button')"),
      prop_name: z.string().describe("Name of the prop function to call (e.g. 'handleForceSubmitConfirmation', 'onChange', 'onSubmit')"),
      args: z.array(z.any()).optional().describe("Arguments to pass; must be JSON-serializable (primitives, arrays, plain objects). Default: empty."),
      max_depth: z.number().int().min(1).optional().describe("How many fiber levels to walk up before giving up (default 30)"),
      frame: z.string().optional().describe('Optional CSS selector for a same-origin iframe whose contents contain the element (e.g. "iframe.se-rte-frame"). Cross-origin iframes are not supported.'),
    },
    async ({ selector, prop_name, args = [], max_depth = 30, frame }) => {
      const response = await bridge.request({
        type: "react_call_prop",
        selector,
        prop_name,
        args,
        max_depth,
        frame,
      }, 30_000);
      const r = response as { success?: boolean; message?: string };
      return {
        content: [{ type: "text", text: r.message ?? (r.success ? "Called" : "Failed to call prop") }],
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
    `Navigate to a URL and capture the exact HTTP request headers Chrome sends for the main document request.
Use this to diagnose server-side bot detection — e.g. when a site returns a "mobile" or "switch devices" page despite the client reporting desktop.
Returns the request method, URL, and all headers including Sec-CH-UA-* client hints.
This tool DOES navigate the active tab to the URL.`,
    {
      url: z.string().url().describe("URL to navigate to and capture headers for"),
    },
    async ({ url }) => {
      const response = await bridge.request({ type: "inspect_request_headers", url }, 20_000);
      const r = response as { message?: string };
      return {
        content: [{ type: "text", text: r.message ?? "(no headers captured)" }],
      };
    }
  );
}
