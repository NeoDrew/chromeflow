import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WsBridge } from "../ws-bridge.js";
import { FlowStore } from "../flow-store.js";
import { registerNavigationTools } from "./browser/navigation.js";
import { registerTabTools } from "./browser/tabs.js";
import { registerSnapshotTools } from "./browser/snapshot.js";
import { registerScreenshotTools } from "./browser/screenshot.js";
import { registerFormFieldTools } from "./browser/forms.js";
import { registerTypingTools } from "./browser/typing.js";
import { registerFileInputTools } from "./browser/files.js";
import { registerScriptingTools } from "./browser/scripting.js";

export function registerBrowserTools(server: McpServer, bridge: WsBridge, flowStore: FlowStore) {
  registerNavigationTools(server, bridge, flowStore);
  registerTabTools(server, bridge, flowStore);
  registerSnapshotTools(server, bridge);
  registerScreenshotTools(server, bridge);
  registerFormFieldTools(server, bridge);
  registerTypingTools(server, bridge, flowStore);
  registerFileInputTools(server, bridge);
  registerScriptingTools(server, bridge);
}
