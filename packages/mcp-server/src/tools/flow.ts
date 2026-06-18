import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WsBridge } from "../ws-bridge.js";
import { FlowStore } from "../flow-store.js";
import { registerClickTools } from "./flow/click.js";
import { registerSaveFlowTools } from "./flow/save.js";
import { registerWaitTools } from "./flow/wait.js";
import { registerFindTools } from "./flow/find.js";
import { registerFillFormTools } from "./flow/forms.js";

export function registerFlowTools(server: McpServer, bridge: WsBridge, flowStore: FlowStore) {
  registerClickTools(server, bridge, flowStore);
  registerSaveFlowTools(server, flowStore);
  registerWaitTools(server, bridge);
  registerFindTools(server, bridge);
  registerFillFormTools(server, bridge);
}
