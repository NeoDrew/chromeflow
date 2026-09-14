import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync } from "fs";
import { resolve, relative, isAbsolute, dirname } from "path";
import type { WsBridge } from "../../ws-bridge.js";
import { isBlockedUrl } from "../../policy.js";

export function registerFetchTools(server: McpServer, bridge: WsBridge) {
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
Set binary=true for non-text responses (PDFs, images, zips) — the body is returned base64-encoded.

Pass \`parse\` for format-aware TEXT EXTRACTION instead of raw bytes/text (this absorbs what used to be a separate read_attachment tool): docx (in-extension ZIP+XML extraction), txt/md/csv/json (UTF-8), html/xml (tag-stripped). Runs on the full, untruncated response before max_bytes ever applies (a docx is a ZIP; truncating one mid-byte-stream would corrupt it), then truncates the resulting TEXT to max_chars. For PDF, the response is a structured error pointing at download_file + local pdftotext. \`parse: "auto"\` detects the format from content-type/URL.`,
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
        .describe("If true, return body as base64 (body_base64). Use for PDFs, images, zips. Default false (UTF-8 text in body_text). Ignored when parse is set."),
      parse: z
        .enum(["auto", "txt", "md", "csv", "json", "xml", "html", "docx", "pdf"])
        .optional()
        .describe('Extract text instead of returning raw bytes/text, for document attachments (Canvas/Drive/email-style URLs). "auto" detects format from content-type/URL; otherwise pass the format explicitly. Response carries {text, format, total_chars, truncated} instead of body_text/body_base64.'),
      max_chars: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Maximum characters to return when parse is set (default 50000). Ignored without parse."),
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
        .describe("Truncate body at this many bytes (default 100000 ≈ 25K tokens, the MCP transport ceiling). Bumped down from 2MB in 0.9.4 because larger responses overflow the agent's context. For larger payloads, set `to_file` to write to disk instead. Ignored when parse is set (see max_chars)."),
      to_file: z
        .string()
        .optional()
        .describe("Absolute path on disk under the agent's working directory. When set, the FULL response body is written to this path (no max_bytes truncation) and the response carries only {path, size, content_type, status, headers}. Parent directories are created if missing. Use this for anything you'd otherwise have to paginate through max_bytes. Ignored when parse is set."),
    },
    async ({ url, method, headers, body, binary, parse, max_chars, timeout_ms, max_bytes, to_file }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `fetch_url refused: ${block.reason}` }] };
      }
      // When to_file is set, request the full body — no truncation. The body
      // is written to disk on this side; the MCP response carries only metadata.
      // binary=true on the WS request ensures we get raw bytes (base64) so
      // non-text responses (PDF, zip, image) round-trip correctly.
      const effectiveMaxBytes = to_file ? Number.MAX_SAFE_INTEGER : (max_bytes ?? 100_000);
      const effectiveBinary = to_file ? true : binary;
      // Bump WS timeout for to_file path — large downloads may exceed 30s.
      const wsTimeout = to_file ? Math.max(120_000, (timeout_ms ?? 30_000) + 30_000) : Math.max(30_000, (timeout_ms ?? 30_000) + 5_000);

      const response = await bridge.request({
        type: "fetch_url",
        url,
        method,
        headers,
        body,
        binary: effectiveBinary,
        parse,
        max_chars,
        timeout_ms,
        max_bytes: effectiveMaxBytes,
      }, wsTimeout);
      if (response.type !== "fetch_url_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as {
        status: number;
        status_text: string;
        headers: Record<string, string>;
        content_type: string;
        body_text?: string;
        body_base64?: string;
        text?: string;
        format?: string;
        total_chars?: number;
        truncated: boolean;
        total_bytes?: number;
        anti_bot_detected?: string | null;
      };

      // parse mode: extracted-text response, distinct shape from the raw-fetch
      // path below (no total_bytes/body_text/body_base64; see handleFetchUrl).
      if (parse) {
        const header = `${url}\nformat: ${r.format} | content-type: ${r.content_type || "unknown"} | total_chars: ${r.total_chars}${r.truncated ? ` (truncated to ${max_chars ?? 50_000})` : ""}\n${"─".repeat(40)}\n`;
        return { content: [{ type: "text", text: header + (r.text ?? "") }] };
      }

      const antiBotLine = r.anti_bot_detected
        ? `\n⚠ anti_bot_detected: "${r.anti_bot_detected}" — response body matches a known block / challenge page. Don't parse as the expected JSON/HTML; the user's IP may be challenged or the endpoint may require a real browser context.`
        : "";

      // to_file path: write bytes to disk, return metadata only.
      if (to_file) {
        const cwd = process.cwd();
        const resolved = isAbsolute(to_file) ? to_file : resolve(cwd, to_file);
        const rel = relative(cwd, resolved);
        if (rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error(
            `Refusing to write fetch_url body outside the project directory. Target "${resolved}" is not under "${cwd}".`
          );
        }
        mkdirSync(dirname(resolved), { recursive: true });
        const buf = r.body_base64
          ? Buffer.from(r.body_base64, "base64")
          : Buffer.from(r.body_text ?? "", "utf-8");
        writeFileSync(resolved, buf);
        const hdrLines = Object.keys(r.headers).sort().map((k) => `  ${k}: ${r.headers[k]}`).join("\n");
        return {
          content: [{
            type: "text",
            text: `HTTP ${r.status} ${r.status_text} — ${r.content_type || "no content-type"} — ${r.total_bytes} bytes\nWritten to: ${resolved}\nSize on disk: ${buf.byteLength}${antiBotLine}\n\nHeaders:\n${hdrLines}`,
          }],
        };
      }

      const header = `HTTP ${r.status} ${r.status_text} — ${r.content_type || "no content-type"} — ${r.total_bytes} bytes${r.truncated ? ` (truncated to ${max_bytes ?? 100_000}; set to_file=<path> to capture the full ${r.total_bytes} bytes)` : ""}${antiBotLine}`;
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
