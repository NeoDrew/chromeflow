import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { FlowStore } from "../../flow-store.js";

export function registerSaveFlowTools(server: McpServer, flowStore: FlowStore) {
  server.tool(
    "save_flow",
    `Trust the hard-won interaction steps chromeflow buffered for the current site, immediately, as a named flow. chromeflow auto-buffers only NOTABLE resolutions (a click that needed a fallback, a verified submit, a field that needed real keystrokes), and AUTOSAVES them as a provisional flow when you leave the site — so memory works even if you never call this. Provisional flows are not recalled until they have been independently re-observed, or until you vouch for them here. Calling save_flow promotes the buffered steps to TRUSTED right away (an explicit "I confirm this worked"), so they are recalled next session instead of waiting to earn it.

Call this when a response shows \`flow_capturable\` and you are confident the task genuinely succeeded. Stored locally only (~/.chromeflow/flows.json), selectors/signals only — never typed text. Guidance, not autopilot: recalled steps are still verified on replay.`,
    {
      task_label: z.string().describe('Short human label for what this flow accomplishes, e.g. "submit text post", "set flair and submit", "log report time".'),
    },
    async ({ task_label }) => {
      const res = flowStore.commit(task_label);
      return { content: [{ type: "text", text: res.message }] };
    }
  );
}
