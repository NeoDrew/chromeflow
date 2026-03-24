const dot = document.getElementById("dot")!;
const statusText = document.getElementById("status-text")!;
const windowStatus = document.getElementById("window-status")!;
const btnSet = document.getElementById("btn-set") as HTMLButtonElement;
const btnClear = document.getElementById("btn-clear") as HTMLButtonElement;

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

// ─── Window assignment ──────────────────────────────────────────────────────

async function refreshWindowStatus() {
  const { windowId } = await chrome.runtime.sendMessage({
    source: "chromeflow-popup",
    type: "get_claude_window",
  }) as { windowId: number | null };

  const currentWindow = await chrome.windows.getCurrent();

  if (windowId) {
    const isThisWindow = windowId === currentWindow.id;
    windowStatus.className = "window-status assigned";
    windowStatus.textContent = isThisWindow
      ? "✓ This window is assigned"
      : `Assigned to window #${windowId} (not this one)`;
    btnSet.textContent = isThisWindow ? "Reassign to this window" : "Use this window instead";
    btnClear.style.display = "block";
  } else {
    windowStatus.className = "window-status";
    windowStatus.textContent = "No window assigned — Claude uses whichever window is active";
    btnSet.textContent = "Use this window for Claude";
    btnClear.style.display = "none";
  }
}

btnSet.addEventListener("click", async () => {
  const currentWindow = await chrome.windows.getCurrent();
  await chrome.runtime.sendMessage({
    source: "chromeflow-popup",
    type: "set_claude_window",
    windowId: currentWindow.id,
  });
  await refreshWindowStatus();
});

btnClear.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({
    source: "chromeflow-popup",
    type: "clear_claude_window",
  });
  await refreshWindowStatus();
});

refreshWindowStatus();
