import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerFillFormTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "fill_form",
    `Fill multiple form fields in a single call by targeting each field by its label text.
Use this instead of calling fill_input repeatedly — it fills all fields in one round trip and returns a per-field success report.
Ideal for forms with many textareas or inputs where each fill would otherwise require a separate tool call.
fields is an array of {label, value} pairs. label should match the field's visible label, placeholder, or aria-label.

Each per-field result includes the matched element description (e.g. \`<input name="title" id="..." placeholder="...">\`) so Claude can spot when fill_form picked the wrong field.

Pass \`exact: true\` for forms with short generic labels (like "Rate" or "Amount") that may collide with similarly-labeled neighbours — fields without an exact aria-label/placeholder/name/id/label-text match will return success=false instead of silently filling the wrong field.`,
    {
      fields: z.array(
        z.object({
          label: z.string().describe("Visible label, placeholder, or aria-label of the field"),
          value: z.string().describe("Value to fill in"),
        })
      ).describe("List of fields to fill"),
      exact: z
        .boolean()
        .optional()
        .describe("If true, refuse fuzzy text-walk matches for every field. Default false."),
    },
    async ({ fields, exact }) => {
      const response = await bridge.request({ type: "fill_form", fields, exact });
      const r = response as { results: Array<{ label: string; success: boolean; message: string; matched?: string }>; succeeded: number; total: number };
      const lines = r.results.map(f => `${f.success ? "✓" : "✗"} "${f.label}": ${f.message}`);
      return {
        content: [{
          type: "text",
          text: `Filled ${r.succeeded}/${r.total} fields:\n${lines.join("\n")}`,
        }],
      };
    }
  );
}
