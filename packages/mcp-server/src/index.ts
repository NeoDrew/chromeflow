import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WsBridge } from "./ws-bridge.js";
import { FlowStore } from "./flow-store.js";
import { registerBrowserTools } from "./tools/browser.js";
import { registerHighlightTools } from "./tools/highlight.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerFlowTools } from "./tools/flow.js";

declare const __CHROMEFLOW_VERSION__: string;
const PACKAGE_VERSION: string =
  typeof __CHROMEFLOW_VERSION__ !== "undefined" ? __CHROMEFLOW_VERSION__ : "dev";

main().catch((err) => { console.error("[chromeflow] Fatal error:", err); process.exit(1); });

async function main() {
  const bridge = new WsBridge();
  const flowStore = new FlowStore(PACKAGE_VERSION);

  const server = new McpServer({
    name: "chromeflow",
    version: PACKAGE_VERSION,
  });

  registerBrowserTools(server, bridge, flowStore);
  registerHighlightTools(server, bridge);
  registerCaptureTools(server, bridge);
  registerFlowTools(server, bridge, flowStore);

  const registered = (server as unknown as { _registeredTools?: Record<string, unknown> })._registeredTools ?? {};
  const toolNames = Object.keys(registered).sort();
  console.error(`[chromeflow] v${PACKAGE_VERSION} — registered ${toolNames.length} tools`);
  if (toolNames.length > 0) {
    console.error(`[chromeflow] tools: ${toolNames.join(", ")}`);
  } else {
    console.error(`[chromeflow] WARNING: no tools registered.`);
  }

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

  // Watchdog: exit when the host (Claude Code / Codex) disconnects.
  // Codex does not always SIGTERM its MCP subprocesses on session end, so
  // without this the WS server keeps listening and the popup accumulates
  // ghost instances on ports 7878-7888.
  //
  // Two complementary signals:
  //   1. stdin close — fires when the host closes its end of the stdio pipe
  //   2. PPID reparented to 1 — fires when the parent dies and we're
  //      reparented to init (orphaned). Polled every 5s.
  let exited = false;
  const exitClean = (reason: string) => {
    if (exited) return;       // every signal path converges here exactly once
    exited = true;
    console.error(`[chromeflow] host disconnected (${reason}), exiting.`);
    // Autosave any buffered hard-won steps before we go. A session whose
    // notable work never crossed an origin+path boundary (e.g. a type_text +
    // same-page submit) has its ONLY flush right here, so this must run on
    // every way the process can be told to stop — not just stdin close.
    try { flowStore.flushAll(); } catch { /* best-effort */ }
    process.exit(0);
  };
  process.stdin.on("end", () => exitClean("stdin end"));
  process.stdin.on("close", () => exitClean("stdin close"));
  process.on("SIGTERM", () => exitClean("SIGTERM"));
  process.on("SIGINT", () => exitClean("SIGINT"));
  process.on("SIGHUP", () => exitClean("SIGHUP"));
  process.on("beforeExit", () => { try { flowStore.flushAll(); } catch { /* best-effort */ } });
  const originalPpid = process.ppid;
  setInterval(() => {
    const ppid = process.ppid;
    if (ppid === 1 || (originalPpid !== 1 && ppid !== originalPpid)) {
      exitClean(`ppid changed ${originalPpid}→${ppid}`);
    }
  }, 5000).unref();

  console.error(`[chromeflow] v${PACKAGE_VERSION} MCP server running. Waiting for the agent...`);
}
