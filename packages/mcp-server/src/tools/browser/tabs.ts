import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";
import { FlowStore } from "../../flow-store.js";

export function registerTabTools(server: McpServer, bridge: WsBridge, flowStore: FlowStore) {
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
      const response = await bridge.request({ type: "switch_to_tab", query: q });
      // Newer extension returns the landed URL/title; older extensions return
      // a bare action_done. Handle both so a fresh server keeps working with
      // a not-yet-reloaded extension.
      const r = response as { url?: string; title?: string };
      const echo = r.url
        ? ` → "${r.title ?? ""}" (${r.url})`
        : "";
      return {
        content: [{ type: "text", text: `Switched to tab matching "${q}"${echo}` }],
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
      // Flow memory: list_tabs is the agent's standard orientation call when a
      // page is ALREADY loaded (it then skips open_page), so recall must fire
      // here too or the known_flow hint is missed on revisits. Key on the
      // active tab; the once-per-origin gate keeps it from duplicating open_page.
      const activeUrl = tabs.find(t => t.active)?.url;
      flowStore.noteUrl(activeUrl);
      const recall = flowStore.recallHint(activeUrl);
      return {
        content: [{ type: "text", text: `Open tabs:\n${lines.join("\n")}${recall}` }],
      };
    }
  );

  server.tool(
    "close_tab",
    `Close tab(s) in the current window. Two mutually exclusive modes, matching switch_to_tab's matcher:
- \`query\` set (or both omitted): close ONE tab, the match (or the active tab if query is omitted). Use this to clean up after a single step.
- \`keep_query\` set: close EVERY OTHER tab, keeping only the match (or the active tab if keep_query is empty). Use this at the end of a session to tidy up the whole pile; do NOT use it mid-flow if you may need to return to one of the closed tabs.`,
    {
      query: z
        .union([z.string(), z.number()])
        .optional()
        .describe("Tab number (1-based), URL substring, or title substring to CLOSE. Omit (with keep_query also omitted) to close the active tab. Mutually exclusive with keep_query."),
      keep_query: z
        .string()
        .optional()
        .describe("URL substring or title substring. Switches to \"close every OTHER tab\" mode: tabs matching this are KEPT, all others are closed. Empty/omitted keeps just the active tab. Mutually exclusive with query."),
    },
    async ({ query, keep_query }) => {
      if (keep_query !== undefined) {
        const response = await bridge.request({ type: "close_other_tabs", keep_query });
        const r = response as { closed?: Array<{ index: number; title: string; url: string }>; kept?: Array<{ index: number; title: string; url: string }>; message?: string };
        if (r.message) return { content: [{ type: "text", text: r.message }] };
        const closedCount = (r.closed ?? []).length;
        const keptCount = (r.kept ?? []).length;
        const keptList = (r.kept ?? []).map(t => `  ${t.index}. ${t.title} — ${t.url}`).join("\n");
        return {
          content: [{ type: "text", text: `Closed ${closedCount} tab(s), kept ${keptCount}:\n${keptList}` }],
        };
      }
      const raw = query === undefined || query === null || query === "" ? undefined : String(query);
      const response = await bridge.request({ type: "close_tab", query: raw });
      const r = response as { closed?: Array<{ index: number; title: string; url: string }>; message?: string };
      if (r.message) return { content: [{ type: "text", text: r.message }] };
      const closedList = (r.closed ?? []).map(t => `${t.index}. ${t.title} — ${t.url}`).join("\n");
      return {
        content: [{ type: "text", text: `Closed ${(r.closed ?? []).length} tab(s):\n${closedList}` }],
      };
    }
  );
}
