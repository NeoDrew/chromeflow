// Shared shape for every MCP message a handler receives. Identical to the
// inline parameter type the original handleMcpMessage switch used.
export type McpMsg = {
  type: string;
  requestId: string;
  [key: string]: unknown;
};
