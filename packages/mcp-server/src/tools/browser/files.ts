import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { promises as fs } from "node:fs";
import type { WsBridge } from "../../ws-bridge.js";

export function registerFileInputTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "set_file_input",
    `Upload a file to a file input — works even when the input is hidden behind a custom drag-and-drop zone. Returns success=true only after an observable commit: file count goes up, verify_selector appears, OR the input is reset AND the filename shows up somewhere on the page. An input reset with NO filename ever appearing anywhere returns success=false with a "silent rejection" message (some drag-and-drop widgets read then discard a file on tenant-level rejection with zero visible error) — do not trust that case as landed even though the input accepted the file momentarily. If there is no input[type=file] anywhere on the page (light or shadow DOM, checked for ALL hints, not just yours), the widget likely opens the browser-native file picker via window.showOpenFilePicker() instead of a classic file input — chromeflow automatically tries a simulated drag-and-drop delivery onto a located drop-zone element instead (this fallback needs file_path, not file_content — it delivers a real on-disk file via a CDP-level drag simulation, not an in-page DataTransfer). If no drop-zone candidate can be found either, there is truly no automatable surface: stop retrying with different hints and report it back. See CLAUDE.md for batch-upload guidance.

Two ways to supply the file:
- file_path (CDP mode): an absolute path on the machine running this server. Reaches both open AND closed shadow roots.
- file_content + file_name (inline-content mode): base64 file bytes plus a filename, materialized into the input directly. Use this when the server has no local disk access (e.g. a remote endpoint that can't see your filesystem). Caveat: inline-content mode reaches OPEN shadow roots only — if the input lives in a closed shadow root, use file_path instead.

Pass \`frame\` (a same-origin iframe CSS selector, same param as fill_input/find_text/click_element) to target a file input rendered inside that iframe instead of the top-level document — e.g. an application form rendered inside \`#content_iframe\`. Without it, a file input that only exists inside a same-origin iframe looks identical to a genuine window.showOpenFilePicker() widget with no automatable surface at all — it isn't, it just wasn't being searched for in the right place. Cross-origin iframes still aren't reachable this way.

Provide file_path OR file_content, not both.`,
    {
      hint: z.string().describe("Label text, name, or surrounding text of the file input. Use empty string to target the first file input on the page."),
      file_path: z
        .string()
        .optional()
        .describe("Absolute path to the file to upload (e.g. /Users/you/Downloads/task.zip). CDP mode — reaches closed shadow roots. Provide this OR file_content."),
      file_content: z
        .string()
        .optional()
        .describe("Base64-encoded file bytes (no data: prefix) for inline-content mode. Use when the server has no local disk access. Requires file_name. Reaches OPEN shadow roots only. Provide this OR file_path."),
      file_name: z
        .string()
        .optional()
        .describe("Filename to present to the page in inline-content mode (e.g. \"report.pdf\"). Required when file_content is set."),
      mime_type: z
        .string()
        .optional()
        .describe("Optional MIME type for inline-content mode (e.g. \"application/pdf\"). Inferred from file_name when omitted."),
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
      frame: z
        .string()
        .optional()
        .describe("Same-origin iframe CSS selector to search inside for the file input. Cross-origin iframes are not supported."),
    },
    async ({ hint, file_path, file_content, file_name, mime_type, wait_ms, verify_selector, frame }) => {
      // file_path XOR file_content: one source is required, both is ambiguous.
      if (!file_path && !file_content) {
        return {
          content: [{ type: "text", text: "Failed to set file: provide either file_path or file_content." }],
        };
      }
      if (file_path && file_content) {
        return {
          content: [{ type: "text", text: "Failed to set file: provide file_path OR file_content, not both." }],
        };
      }
      if (file_content && !file_name) {
        return {
          content: [{ type: "text", text: "Failed to set file: file_content requires file_name." }],
        };
      }
      // file_path mode hands a bare path string to the extension, which has
      // no filesystem access of its own — it can only see whatever CDP's
      // DOM.setFileInputFiles / Input.dispatchDragEvent report back, and a
      // page's own upload widget may not validate the delivered file's
      // readability before showing a "file selected" UI state (some read the
      // File object's metadata only at final submit time, possibly well
      // after this session ends). A nonexistent or empty path can therefore
      // read as a genuine success with no signal anything was ever wrong —
      // confirmed as a live concern when a job-search automation pointed at
      // a resume path that had never existed for an entire session. Fail
      // fast, deterministically, and BEFORE any CDP call, using the one
      // thing only this Node-side server can actually check: the real
      // filesystem.
      if (file_path) {
        let stat;
        try {
          stat = await fs.stat(file_path);
        } catch {
          return {
            content: [{ type: "text", text: `Failed to set file: "${file_path}" does not exist or is not readable on the machine running this MCP server. Refusing to attempt delivery — a page's own upload widget may not validate file readability itself, so a bad path here would otherwise silently pass as a successful upload with no file actually delivered.` }],
          };
        }
        if (!stat.isFile()) {
          return {
            content: [{ type: "text", text: `Failed to set file: "${file_path}" exists but is not a regular file (directory or special file). Refusing to attempt delivery.` }],
          };
        }
        if (stat.size === 0) {
          return {
            content: [{ type: "text", text: `Failed to set file: "${file_path}" exists but is empty (0 bytes). Refusing to attempt delivery — an empty file would deliver successfully at the DOM level while being useless content (e.g. a resume upload with nothing in it).` }],
          };
        }
      }
      // The WS request must outlive the upload-poll, with margin for CDP attach.
      const wsTimeout = Math.max(30_000, (wait_ms ?? 3000) + 10_000);
      const response = await bridge.request(
        {
          type: "set_file_input",
          hint,
          // snake -> camel, mirroring the existing file_path -> filePath mapping.
          filePath: file_path,
          fileContent: file_content,
          fileName: file_name,
          mimeType: mime_type,
          waitMs: wait_ms,
          verifySelector: verify_selector,
          frame,
        },
        wsTimeout
      );
      const r = response as { success?: boolean; message?: string };
      return {
        content: [{ type: "text", text: r.message ?? (r.success ? "File set successfully" : "Failed to set file") }],
      };
    }
  );
}
