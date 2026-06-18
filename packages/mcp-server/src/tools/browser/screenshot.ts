import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, copyFileSync, readFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import type { WsBridge } from "../../ws-bridge.js";

export function registerScreenshotTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "take_screenshot",
    `Capture a screenshot of the active tab. By default the image is returned to the agent inline UNLESS it exceeds ~500KB base64, in which case it's saved to a temp file and the path is returned instead (preserves the agent's context window). Set inline="always" to force inline regardless of size, or inline="never" to always write to a file. Set save_to or copy_to_clipboard to also share the image with the user. Reserved for cases where DOM lookup has already failed — use get_page_text and find_text for reading content.

Refuses fast on pages that are in fullscreen mode (captureVisibleTab hangs there). Exit fullscreen first with execute_script("document.exitFullscreen()") or pass allow_fullscreen: true if you really must try anyway.`,
    {
      copy_to_clipboard: z
        .boolean()
        .optional()
        .describe("Copy the PNG to the system clipboard (macOS only). Default false."),
      save_to: z
        .enum(["downloads", "cwd", "none"])
        .optional()
        .describe('Save the PNG to disk: "downloads" (~/Downloads), "cwd" (the agent\'s working directory), or "none" (default — image returned only to the agent, no disk artifact).'),
      inline: z
        .enum(["auto", "always", "never"])
        .optional()
        .describe('Whether to return the image base64 inline to the agent. "auto" (default): inline if under 500KB base64, otherwise write to a temp file and return the path. "always": inline regardless of size — large images may exceed the MCP token ceiling. "never": always return the path, never inline.'),
      allow_fullscreen: z
        .boolean()
        .optional()
        .describe("Bypass the fullscreen fast-fail. Default false. captureVisibleTab usually hangs in fullscreen mode and the request times out — set this only when you've confirmed the page can produce a screenshot in fullscreen."),
    },
    async ({ copy_to_clipboard = false, save_to = "none", inline = "auto", allow_fullscreen }) => {
      const sharing = copy_to_clipboard || save_to !== "none";
      // grid:false when sharing — coord grid is noise when the image is for
      // pasting into chats / uploading to forms.
      const response = await bridge.request({ type: "screenshot", grid: !sharing, allow_fullscreen });
      if (response.type !== "screenshot_response") {
        throw new Error("Unexpected response from extension");
      }

      const base64Len = response.image.length;
      const INLINE_CAP = 500_000; // ~375KB image
      const shouldInline = inline === "always" || (inline === "auto" && base64Len <= INLINE_CAP);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const filename = `chromeflow-${timestamp}.png`;
      const imageBuffer = Buffer.from(response.image, "base64");
      const tmpPath = join(tmpdir(), filename);
      // Always write the temp file when not inlining OR when sharing — used by
      // both the auto-file return path and the clipboard/copy paths.
      const needTmp = !shouldInline || sharing;
      if (needTmp) writeFileSync(tmpPath, imageBuffer);

      const notes: string[] = [];
      let landedPath = tmpPath;
      if (save_to !== "none") {
        const savePath = save_to === "cwd"
          ? join(process.cwd(), filename)
          : join(homedir(), "Downloads", filename);
        copyFileSync(tmpPath, savePath);
        notes.push(`Saved to ${savePath}`);
        landedPath = savePath;
      }
      if (copy_to_clipboard) {
        try {
          execSync(`osascript -e 'set the clipboard to (read (POSIX file "${tmpPath}") as «class PNGf»)'`);
          notes.push("Copied to clipboard");
        } catch {
          // Surface the failure explicitly rather than silently dropping it, so
          // the caller never assumes a clipboard copy that didn't happen
          // (clipboard copy is macOS-only; other platforms land here).
          notes.push("Clipboard copy failed (macOS-only feature)");
        }
      }

      // Viewport / page / scroll metadata footer — lets agents map pixel
      // positions in the image directly to CSS coordinates for
      // click_at_coordinates without a separate execute_script probe.
      const r = response as { viewport?: { width: number; height: number }; page?: { width: number; height: number }; scroll?: { x: number; y: number } };
      const meta = r.viewport && r.page && r.scroll
        ? ` viewport=${r.viewport.width}x${r.viewport.height}, page=${r.page.width}x${r.page.height}, scroll=(${r.scroll.x},${r.scroll.y}).`
        : "";

      if (shouldInline) {
        const msg = notes.length
          ? notes.join(". ") + "." + meta
          : `Screenshot captured (${response.width}x${response.height}, ${base64Len} base64 chars).${meta} Analyze the image to identify element positions for highlighting.`;
        return {
          content: [
            { type: "image", data: response.image, mimeType: "image/png" },
            { type: "text", text: msg },
          ],
        };
      }

      // Path-only return — image is too large for inline.
      notes.push(`Image saved to ${landedPath} (${response.width}x${response.height}, ~${Math.round(imageBuffer.byteLength / 1024)}KB).${meta} Read the file or use OS image viewer. To force inline despite size, pass inline="always".`);
      return {
        content: [{ type: "text", text: notes.join(". ") + "." }],
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
}
