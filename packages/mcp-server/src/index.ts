import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsBridge } from "./ws-bridge.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerHighlightTools } from "./tools/highlight.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerFlowTools } from "./tools/flow.js";
import { runSetup, runUpdate, runUninstall } from "./setup.js";

if (process.argv[2] === "setup") {
  runSetup().catch((err) => { console.error(err); process.exit(1); });
} else if (process.argv[2] === "update") {
  runUpdate().catch((err) => { console.error(err); process.exit(1); });
} else if (process.argv[2] === "uninstall") {
  runUninstall().catch((err) => { console.error(err); process.exit(1); });
} else {
  main().catch((err) => { console.error("[chromeflow] Fatal error:", err); process.exit(1); });
}

async function main() {
  const bridge = new WsBridge();

  const server = new McpServer({
    name: "chromeflow",
    version: "0.1.14",
  });

  registerBrowserTools(server, bridge);
  registerHighlightTools(server, bridge);
  registerCaptureTools(server, bridge);
  registerFlowTools(server, bridge);

  // MCP prompts — appear as slash commands in Claude Code
  server.prompt(
    "chromeflow-status",
    "Check if the chromeflow Chrome extension is connected and which tab is active",
    async () => {
      const connected = bridge.isConnected();
      if (!connected) {
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: "Check chromeflow status. The Chrome extension is NOT connected. Tell the user to reload the chromeflow extension in chrome://extensions.",
            },
          }],
        };
      }
      try {
        const response = await bridge.request({ type: "list_tabs" }, 3000);
        const tabs = (response as { tabs: Array<{ index: number; title: string; url: string; active: boolean }> }).tabs;
        const active = tabs.find((t) => t.active);
        const tabList = tabs.map((t) => `${t.index}. ${t.active ? "[active] " : ""}${t.title} — ${t.url}`).join("\n");
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: `Check chromeflow status.\n\nExtension: Connected\nActive tab: ${active?.title ?? "none"} — ${active?.url ?? ""}\nAll tabs:\n${tabList}`,
            },
          }],
        };
      } catch {
        return {
          messages: [{
            role: "user",
            content: {
              type: "text",
              text: "Check chromeflow status. Extension is connected but not responding. The user may need to reload it.",
            },
          }],
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[chromeflow] MCP server running. Waiting for Claude...");
}

