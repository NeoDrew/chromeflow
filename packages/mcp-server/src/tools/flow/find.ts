import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerFindTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "find_text",
    `Search the active page for text and return actionable matches (text, surrounding context, best-effort CSS selector, clickable flag). Use this instead of get_page_text when checking "is X on the page?" or locating a clickable target. Pierces open AND closed shadow roots. Pass \`frame: "iframe.selector"\` for same-origin iframe search.

When visible_only=true (the default) filters out all matches AND there were hidden matches, the response surfaces the hidden count so you can re-run with visible_only=false instead of guessing "is this on the page or not?"

Scope helpers: \`in_dialog: true\` restricts the search to the topmost open dialog; \`dialog_query: "Select"\` restricts it to a dialog whose heading or aria-label matches. Mirrors click_element's dialog scoping so the same flag works across discovery and action.`,
    {
      query: z.string().describe("Text to search for. Substring by default; regex=true → case-insensitive regex."),
      max: z.number().int().min(1).optional().describe("Maximum matches to return (default 5). total_matches is reported even when truncated."),
      scope_selector: z.string().optional().describe("Limit search to a CSS selector's subtree."),
      regex: z.boolean().optional().describe("Treat query as regex (case-insensitive). Default false."),
      visible_only: z.boolean().optional().describe("Skip display:none / visibility:hidden / aria-hidden=true. Default true."),
      context_chars: z.number().int().min(0).optional().describe("Surrounding context chars per match (default 40)."),
      frame: z.string().optional().describe("Same-origin iframe CSS selector to search inside."),
      in_dialog: z.boolean().optional().describe("Scope to the topmost open [role=dialog] / [role=alertdialog] / <dialog open>. Mirrors click_element."),
      dialog_query: z.string().optional().describe("Scope to the dialog whose heading or aria-label contains this substring. Mirrors click_element."),
      whole_word: z.boolean().optional().describe(`Gate matches on word boundaries. Use for common English words ("Live", "New", "Done", "Confirm") that would otherwise substring-match unrelated pre-rendered content (e.g. "Live" matching "delivery", "Done" matching "abandoned"). Default false to preserve the substring-by-default contract; flip on whenever your query is a single common word that may also appear inside larger words.`),
    },
    async ({ query, max, scope_selector, regex, visible_only, context_chars, frame, in_dialog, dialog_query, whole_word }) => {
      const response = await bridge.request({
        type: "find_text",
        query,
        max: max ?? 5,
        scope_selector,
        regex,
        visible_only,
        context_chars: context_chars ?? 40,
        frame,
        in_dialog,
        dialog_query,
        whole_word,
      });
      const r = response as unknown as {
        matches: Array<{
          text: string;
          context: string;
          selector: string;
          tag: string;
          role: string | null;
          clickable: boolean;
          position: { x: number; y: number; width: number; height: number } | null;
        }>;
        total_matches: number;
        hidden_count?: number;
        truncated: boolean;
        scope_missed?: boolean;
        frame_error?: string;
      };
      if (r.frame_error) {
        return { content: [{ type: "text", text: r.frame_error }] };
      }
      if (r.scope_missed) {
        return {
          content: [
            { type: "text", text: `Scope selector "${scope_selector}" did not match any element — no search performed.` },
          ],
        };
      }
      if (r.matches.length === 0) {
        // Distinguish "not on page" from "on page but hidden" so the agent
        // doesn't guess at visible_only=false unnecessarily.
        const hidden = r.hidden_count ?? 0;
        const hint = visible_only !== false && hidden > 0
          ? ` ${hidden} hidden match(es) skipped (display:none / visibility:hidden / aria-hidden / off-viewport). Set visible_only=false to include them.`
          : "";
        return {
          content: [
            { type: "text", text: `No visible matches found for "${query}".${hint}` },
          ],
        };
      }
      const lines = r.matches.map((m, i) => {
        const role = m.role ? `, role=${m.role}` : "";
        const click = m.clickable ? " — clickable" : "";
        const pos = m.position
          ? ` at (${m.position.x}, ${m.position.y}, ${m.position.width}×${m.position.height})`
          : "";
        return `  ${i + 1}. [${m.tag}${role}]${click}${pos} — selector: ${m.selector}\n     "${m.text}"\n     context: ${m.context}`;
      });
      const header = r.truncated
        ? `Found ${r.matches.length} of ${r.total_matches} matches for "${query}":`
        : `Found ${r.matches.length} match${r.matches.length === 1 ? "" : "es"} for "${query}":`;
      return {
        content: [{ type: "text", text: `${header}\n${lines.join("\n")}` }],
      };
    }
  );

  server.tool(
    "list_frames",
    `List every top-level iframe/frame on the active page, with its origin, whether its contentDocument is accessible (same-origin), and its on-screen position. Also reports shadow-host inventory so you can spot pages whose visible content is rendered inside closed shadow roots (Radix portals, Stencil/Lit, custom web components).

Use this BEFORE calling find_text({frame: "..."}) or other frame-targeted tools — it shows you which frames exist and which are reachable. Knowing a frame is cross-origin up front means you can route to fetch_url with parse: "auto" (for the frame's src URL) or take_screenshot instead of getting a "frame not accessible" error from another tool.

Also use this as a quick diagnostic when execute_script returns an empty document on a page you can clearly see — non-zero \`shadow_hosts\` (especially closed roots) means switch to find_text / get_page_text / click_element / fill_input, which pierce shadow DOM via the extension's privileged API.

Per-frame fields:
- selector: CSS selector you can pass to other tools' \`frame\` parameter
- src: the iframe's src attribute (may be empty for about:blank frames)
- origin: parsed origin (e.g. "https://canvadoc.instructure.com") — empty when src is data:/javascript:/empty
- accessible: true if contentDocument is reachable (same-origin), false otherwise
- title: the iframe's title attribute, often the most human-readable identifier
- x, y, width, height: bounding-box position in viewport CSS pixels

Per-shadow-host fields:
- selector: short CSS hint for the host element (tag, id, or .class)
- open: true if the shadow root is exposed via \`el.shadowRoot\` (most web components), false if it is closed (Radix portals, Stencil/Lit defaults) — closed roots are invisible to execute_script but pierced by chromeflow's other tools.
- depth: nesting depth (0 = top-level host attached directly to the document)

Note: this returns top-level frames only. Nested cross-origin frame trees are not enumerated. Shadow hosts are capped at 25 to keep the response compact.`,
    {},
    async () => {
      const response = await bridge.request({ type: "list_frames" });
      if (response.type !== "list_frames_response") throw new Error(`Unexpected response: ${response.type}`);
      const r = response as {
        frames: Array<{ index: number; selector: string; src: string; origin: string; title: string; accessible: boolean; x: number; y: number; width: number; height: number }>;
        shadow_hosts?: Array<{ selector: string; open: boolean; depth: number }>;
      };
      // Build a shadow-host section. Surfacing this here means the agent gets
      // the full "is this page using shadow DOM?" picture in one call —
      // matches the user's expectation that list_frames is the
      // discoverability tool for frame-like boundaries.
      const hosts = r.shadow_hosts ?? [];
      const closedCount = hosts.filter((h) => !h.open).length;
      const openCount = hosts.length - closedCount;
      let shadowSection = "";
      if (hosts.length > 0) {
        const hostLines = hosts.map((h) => {
          const kind = h.open ? "open" : "closed";
          const indent = "  ".repeat(h.depth);
          return `  ${indent}${h.selector} [${kind}]`;
        });
        shadowSection =
          `\n\nShadow hosts (${hosts.length}: ${openCount} open, ${closedCount} closed):` +
          (closedCount > 0
            ? "\n  (Closed roots are invisible to execute_script. Use find_text / get_page_text / click_element / fill_input — they pierce.)"
            : "") +
          "\n" + hostLines.join("\n");
      }
      if (r.frames.length === 0) {
        const noFrames = "No iframes or frames on this page.";
        return { content: [{ type: "text", text: hosts.length > 0 ? `${noFrames}${shadowSection}` : noFrames }] };
      }
      const lines = r.frames.map((f) => {
        const access = f.accessible ? "accessible" : "cross-origin";
        const titleBit = f.title ? ` "${f.title}"` : "";
        const originBit = f.origin || "(no origin)";
        return `${f.index}. ${f.selector}${titleBit} — ${originBit} [${access}] — ${f.width}×${f.height} @ (${f.x},${f.y})${f.src ? `\n   src: ${f.src}` : ""}`;
      });
      return { content: [{ type: "text", text: `Found ${r.frames.length} frame${r.frames.length === 1 ? "" : "s"}:\n${lines.join("\n")}${shadowSection}` }] };
    }
  );
}
