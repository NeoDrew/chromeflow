import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { resolve, relative, isAbsolute } from "path";
import type { WsBridge } from "../../ws-bridge.js";
import { isBlockedUrl } from "../../policy.js";

export function registerFileTools(server: McpServer, bridge: WsBridge) {
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
    "download_file",
    `Download a file from a URL to the user's local disk using Chrome's authenticated download flow.

Uses the user's existing Chrome session, so this works on authenticated URLs (Canvas attachments, Stripe document downloads, GitHub release tarballs behind SSO) without any auth setup on chromeflow's side. Returns the absolute path where the file landed, plus MIME type and byte size.

Use this when you need the BYTES of a file (binary parsing, large content, anything you'll process with another tool). For "I just need the text content of this attachment" use fetch_url with parse: "auto" instead, which downloads and parses in one call.

The file is saved to the user's default downloads directory (usually ~/Downloads). Pass filename to suggest a name; Chrome will add a numeric suffix if a file with that name already exists.`,
    {
      url: z.string().describe("The full URL to download (https://...). Chrome's cookie jar is automatically used."),
      filename: z.string().optional().describe("Suggested filename (Chrome will uniquify if it collides). Default: derived from URL or Content-Disposition header."),
      timeout_ms: z.number().int().min(1000).optional().describe("Abort if the download isn't complete in this many ms (default 60000)."),
    },
    async ({ url, filename, timeout_ms }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `download_file refused: ${block.reason}` }] };
      }
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
}
