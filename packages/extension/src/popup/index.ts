const dot = document.getElementById("dot")!;
const statusText = document.getElementById("status-text")!;

function setConnected(connected: boolean) {
  dot.className = "dot" + (connected ? " connected" : "");
  statusText.innerHTML = connected
    ? "<span>MCP server connected</span>"
    : "MCP server not found — start <code>chromeflow-mcp</code>";
}

// Try connecting to WS to check status
try {
  const ws = new WebSocket("ws://localhost:7878");
  ws.onopen = () => {
    setConnected(true);
    ws.close();
  };
  ws.onerror = () => setConnected(false);
  setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) setConnected(false);
  }, 2000);
} catch {
  setConnected(false);
}
