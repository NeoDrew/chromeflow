import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerFileInputTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "set_file_input",
    `Upload a file to a file input — works even when the input is hidden behind a custom drag-and-drop zone. Returns success=true only after an observable commit: file count goes up, verify_selector appears, OR the input is reset AND the filename shows up somewhere on the page. An input reset with NO filename ever appearing anywhere returns success=false with a "silent rejection" message (some drag-and-drop widgets read then discard a file on tenant-level rejection with zero visible error) — do not trust that case as landed even though the input accepted the file momentarily. If there is no input[type=file] anywhere on the page (light or shadow DOM, checked for ALL hints, not just yours), the widget likely opens the browser-native file picker via window.showOpenFilePicker() instead of a classic file input — chromeflow automatically tries a simulated drag-and-drop delivery onto a located drop-zone element instead (this fallback needs file_path, not file_content — it delivers a real on-disk file via a CDP-level drag simulation, not an in-page DataTransfer). If no drop-zone candidate can be found either, there is truly no automatable surface: stop retrying with different hints and report it back. See CLAUDE.md for batch-upload guidance.

Two ways to supply the file:
- file_path (CDP mode): an absolute path on the machine running this server. Reaches both open AND closed shadow roots.
- file_content + file_name (inline-content mode): base64 file bytes plus a filename, materialized into the input directly. Use this when the server has no local disk access (e.g. a remote endpoint that can't see your filesystem). Caveat: inline-content mode reaches OPEN shadow roots only — if the input lives in a closed shadow root, use file_path instead.

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
    },
    async ({ hint, file_path, file_content, file_name, mime_type, wait_ms, verify_selector }) => {
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
