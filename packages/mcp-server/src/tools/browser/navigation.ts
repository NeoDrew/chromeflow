import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";
import { isBlockedUrl } from "../../policy.js";
import { FlowStore } from "../../flow-store.js";

export function registerNavigationTools(server: McpServer, bridge: WsBridge, flowStore: FlowStore) {
  server.tool(
    "open_page",
    `Navigate to a URL. By default reuses the active tab. Set new_tab=true to open alongside the current tab without losing it. After navigating, call get_page_text to read the page — do NOT take a screenshot.

Set background=true (only with new_tab=true) to open the new tab WITHOUT switching focus to it. Use this when the current tab has a partially-filled form whose page auto-saves on focus loss (e.g. eBay seller listings) — switching away would trigger the auto-save and corrupt the in-progress draft.

After tabs.onUpdated fires status=complete, chromeflow also runs a 6s settle check (document.readyState=complete, no visible spinner element, 250ms of mutation quiet). If a spinner is still visible at the end of the window, the response carries \`stuck_spinner: true\` with the matching selector — the canonical case is an SPA route that left a permanent .spinner-wrapper because the API request died. Set expect_selector to wait for a known-good element to appear before considering the page settled — the response carries \`expect_selector_appeared: false\` if it never showed up.

When new_tab=true, the response also carries \`tab_count\` (total tabs now open in this window) and, once that count gets high, a \`tab_count_warning\` — a gentle nudge at 25+ tabs, a stronger one at 50+. Long sessions that keep opening tabs without closing old ones can quietly clutter the user's real browser; close tabs you no longer need with close_tab rather than leaving them open indefinitely.`,
    {
      url: z.string().url().describe("The URL to navigate to"),
      new_tab: z.boolean().optional().describe("Open in a new tab instead of replacing the current one (default false)"),
      background: z
        .boolean()
        .optional()
        .describe("If new_tab=true, do not switch focus to the new tab. Default false. Ignored when new_tab is false."),
      expect_selector: z
        .string()
        .optional()
        .describe("CSS selector for an element that must be present before the page is considered settled. The settle check waits up to 6s for it; if it never appears, the response carries expect_selector_appeared:false so you can detect dead-spinner routes (SPAs that leave a permanent spinner when the underlying API request dies)."),
    },
    async ({ url, new_tab, background, expect_selector }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `open_page refused: ${block.reason}` }] };
      }
      const response = await bridge.request({
        type: "navigate",
        url,
        newTab: new_tab ?? false,
        background: background ?? false,
        expect_selector,
      });
      const r = response as {
        stuck_spinner?: boolean;
        spinner_selector?: string | null;
        expect_selector_appeared?: boolean | null;
        current_url?: string;
        anti_bot_detected?: string | null;
        dismissed_beforeunload?: boolean;
        tab_count?: number;
        tab_count_warning?: string | null;
      };
      const newTabBit = new_tab ? (background ? " (new background tab)" : " (new tab)") : "";
      let text = `Navigated to ${url}${newTabBit}`;
      if (r.stuck_spinner) {
        text += `\n\n⚠ stuck_spinner: true — page settled with a visible spinner (${r.spinner_selector ?? "unknown selector"}) still on screen after 6s. Current URL: ${r.current_url ?? url}. The route may be dead (some SPAs leave a permanent spinner when the underlying API request fails) — navigate elsewhere instead of reloading, or wait and try get_page_text to see if it ever recovers.`;
      }
      if (expect_selector && r.expect_selector_appeared === false) {
        text += `\n\n⚠ expect_selector "${expect_selector}" never appeared within the 6s settle window. The page may be partially loaded or stuck.`;
      }
      if (r.anti_bot_detected) {
        text += `\n\n⚠ anti_bot_detected: "${r.anti_bot_detected}" — the page returned a known block / challenge response. Page content is unlikely to be the intended target. Don't try to interact with it; navigate elsewhere or surface to the user.`;
      }
      if (r.dismissed_beforeunload) {
        text += `\n\nℹ dismissed_beforeunload: true — the previous page had unsaved content (typed text in a composer, form draft, etc.) and Chrome's "Are you sure you want to leave?" dialog was auto-dismissed so navigation could proceed. If that draft was load-bearing, navigate back and re-capture before continuing.`;
      }
      if (r.tab_count_warning) {
        text += `\n\n${r.tab_count_warning}`;
      }
      // Flow memory: surface any known good flow for this destination so the
      // agent follows the proven steps instead of rediscovering them.
      flowStore.noteUrl(r.current_url ?? url);
      text += flowStore.recallHint(r.current_url ?? url);
      return { content: [{ type: "text", text }] };
    }
  );

  server.tool(
    "inspect_request_headers",
    `Capture the request headers Chrome sends to a URL — useful for diagnosing server-side bot detection. Returns method, URL, and all headers. Cookie values are redacted by default to avoid leaking session tokens into the agent context; pass redact_cookies: false to see them. By default opens a background tab for the inspection so your active tab keeps its scroll position and form state — set new_tab: false to use the active tab instead.`,
    {
      url: z.string().url().describe("URL to navigate to and capture headers for"),
      redact_cookies: z.boolean().optional().describe("Replace each cookie's value with [REDACTED]. Default true. Set false only when you genuinely need the cookie content for debugging."),
      new_tab: z.boolean().optional().describe("Open the inspection in a background tab and close it when done. Default true (preserves the active tab's state). Set false to use the active tab — the active tab WILL navigate."),
    },
    async ({ url, redact_cookies = true, new_tab = true }) => {
      const block = isBlockedUrl(url);
      if (block.blocked) {
        return { content: [{ type: "text", text: `inspect_request_headers refused: ${block.reason}` }] };
      }
      const response = await bridge.request({ type: "inspect_request_headers", url, new_tab }, 30_000);
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
