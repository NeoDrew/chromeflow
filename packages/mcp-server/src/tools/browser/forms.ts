import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerFormFieldTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "get_form_fields",
    `Inventory form fields on the active page (inputs, textareas, selects, CodeMirror editors). Sorted top-to-bottom by y-position; includes fields below the fold.

Pass \`query\` to filter+rank by label/placeholder/aria-label/name/id (the old find_input behavior — match strength reported as aria-eq / placeholder-eq / label-text-eq / name-eq / id-eq / *-includes / fuzzy-text-walk). Pass \`exact: true\` to refuse fuzzy text-walk matches.

Pass \`only_empty: true\` to filter the inventory to required-but-empty fields. This is the "why is Submit disabled" diagnostic: it returns just the required fields that haven't been filled yet (or radios/checkboxes still unchecked) and skips everything that's already populated. Required-ness is detected via the \`required\` attribute, \`aria-required\`, or a trailing \`*\` in the associated label text.`,
    {
      query: z.string().optional().describe("If set, filter+rank fields by hint matching label/placeholder/aria-label/name/id."),
      max: z.number().int().min(1).optional().describe("Maximum fields to return when query is set (default 5). Ignored without query (full inventory)."),
      type_filter: z.string().optional().describe('Restrict to a specific input type (e.g. "email", "checkbox", "file"). Only with query.'),
      exact: z.boolean().optional().describe("Refuse fuzzy text-walk and *-includes matches. Only with query."),
      frame: z.string().optional().describe("Same-origin iframe CSS selector to search inside. Cross-origin iframes are not supported."),
      only_empty: z.boolean().optional().describe("Filter inventory to required-but-empty fields only. Use as a Submit-disabled diagnostic. Ignored when query is set."),
    },
    async ({ query, max, type_filter, exact, frame, only_empty }) => {
      if (query !== undefined) {
        // Filtered mode — route to find_input bridge message.
        const response = await bridge.request({ type: "find_input", query, type_filter, max, exact, frame });
        if (response.type !== "find_input_response") throw new Error("Unexpected response");
        const r = response as { fields: Array<{ label: string; placeholder: string; type: string; value: string; under?: string; position: unknown; match_kind: string }>; total_matches: number; truncated: boolean; frame_error?: string };
        if (r.frame_error) return { content: [{ type: "text", text: r.frame_error }] };
        if (r.fields.length === 0) return { content: [{ type: "text", text: `No form fields matched "${query}".` }] };
        const header = `Found ${r.fields.length}${r.truncated ? ` of ${r.total_matches}` : ""} input(s) for "${query}":`;
        const lines = r.fields.map((f, i) => {
          const ph = f.placeholder ? ` placeholder="${f.placeholder}"` : "";
          const val = f.value ? ` value="${f.value}"` : "";
          const under = f.under ? ` [under: "${f.under}"]` : "";
          return `  ${i + 1}. "${f.label}" type=${f.type}${ph}${val}${under} — match: ${f.match_kind}`;
        });
        return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}\n\nTo fill: fill_input("${r.fields[0].label}", "<value>")` }] };
      }
      // Inventory mode.
      const response = await bridge.request({ type: "get_form_fields", only_empty });
      if (response.type !== "form_fields_response") throw new Error("Unexpected response");
      const r = response as {
        fields: Array<{ index: number; type: string; label: string; value: string; y: number; selector: string; context?: string; required?: boolean; empty?: boolean }>;
        warning?: string;
        captcha?: { kind: string; sitekey: string | null } | null;
        oauthIndicators?: string[];
      };
      const fields = r.fields;
      const captchaLine = r.captcha
        ? `\n\n⚠ CAPTCHA detected: ${r.captcha.kind}${r.captcha.sitekey ? ` (sitekey: ${r.captcha.sitekey})` : ""}. Synthetic submits will be silently rejected. Pre-fill, then highlight the submit button and call wait_for_click.`
        : "";
      const oauthLine = r.oauthIndicators && r.oauthIndicators.length > 0
        ? `\n\nℹ OAuth providers detected on this form: ${r.oauthIndicators.join(", ")}. If the user wants to sign in via one of these, click it instead of filling email/password.`
        : "";
      if (fields.length === 0) {
        const empty = only_empty
          ? "No required-but-empty fields detected."
          : "No form fields found on page.";
        return { content: [{ type: "text", text: empty + (r.warning ?? "") + captchaLine + oauthLine }] };
      }
      const lines = fields.map(f => {
        const val = f.value ? ` [currently: "${f.value}"]` : "";
        const ctx = f.context ? ` [under: "${f.context}"]` : "";
        const req = f.required ? " *required" : "";
        return `${f.index}. [${f.type}] "${f.label}"${req}${val}${ctx} — y:${f.y}`;
      });
      const header = only_empty
        ? `Required-but-empty fields (${fields.length}):`
        : `Form fields (${fields.length} total, sorted top-to-bottom):`;
      return { content: [{ type: "text", text: `${header}\n${lines.join("\n")}${r.warning ?? ""}${captchaLine}${oauthLine}` }] };
    }
  );
}
