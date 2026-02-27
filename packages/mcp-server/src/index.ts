import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsBridge } from "./ws-bridge.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerHighlightTools } from "./tools/highlight.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerFlowTools } from "./tools/flow.js";
import { runSetup, runUpdate } from "./setup.js";

if (process.argv[2] === "setup") {
  runSetup().catch((err) => { console.error(err); process.exit(1); });
} else if (process.argv[2] === "update") {
  runUpdate().catch((err) => { console.error(err); process.exit(1); });
} else {
  main().catch((err) => { console.error("[chromeflow] Fatal error:", err); process.exit(1); });
}

async function main() {
  const bridge = new WsBridge();

  const server = new McpServer({
    name: "chromeflow",
    version: "0.1.7",
  });

  registerBrowserTools(server, bridge);
  registerHighlightTools(server, bridge);
  registerCaptureTools(server, bridge);
  registerFlowTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[chromeflow] MCP server running. Waiting for Claude...");
}

