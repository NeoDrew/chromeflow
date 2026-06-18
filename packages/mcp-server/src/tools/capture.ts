import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WsBridge } from "../ws-bridge.js";
import { registerInputTools } from "./capture/input.js";
import { registerExtractTools } from "./capture/extract.js";
import { registerFileTools } from "./capture/files.js";
import { registerFetchTools } from "./capture/fetch.js";

export function registerCaptureTools(server: McpServer, bridge: WsBridge) {
  registerInputTools(server, bridge);
  registerExtractTools(server, bridge);
  registerFileTools(server, bridge);
  registerFetchTools(server, bridge);
}
