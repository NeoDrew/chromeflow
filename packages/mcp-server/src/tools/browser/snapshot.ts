import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerSnapshotTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "interactive_snapshot",
    `Compact, accessibility-style list of the page's ACTIONABLE elements — each as [role] name — selector. Use this INSTEAD of get_page_text or take_screenshot when your goal is to ACT (click / type / select), not to read prose: it is far cheaper in tokens than dumping page text, and every line gives a ready-to-use selector for click_element / type_text. Pierces open AND closed shadow roots (Reddit faceplate-*, Radix/Stencil/Lit), which a raw accessibility tree misses. Returns the top elements by document order; pass max to widen. For reading article/body text, still use get_page_text.`,
    {
      max: z.number().int().min(1).optional().describe("Max elements to return (default 60)."),
    },
    async ({ max }) => {
      let response;
      try {
        response = await bridge.request({ type: "interactive_snapshot", max });
      } catch {
        // Old extension without the handler — degrade instead of hard-failing.
        return { content: [{ type: "text", text: "interactive_snapshot is unavailable (reload/update the chromeflow extension). Fall back to get_page_text + find_text for now." }] };
      }
      const r = response as { items?: Array<{ role: string; name: string; selector: string; duplicate_id?: boolean }>; warning?: string };
      const items = r.items ?? [];
      if (items.length === 0) {
        return { content: [{ type: "text", text: "No actionable elements found (page may render inside a cross-origin iframe, or content is non-interactive)." }] };
      }
      const lines = items.map((it, i) => `${i + 1}. [${it.role}]${it.name ? " " + it.name : ""} — ${it.selector}${it.duplicate_id ? "  ⚠duplicate id" : ""}`);
      return { content: [{ type: "text", text: `Actionable elements (${items.length}):\n${lines.join("\n")}${r.warning ?? ""}` }] };
    }
  );
}
