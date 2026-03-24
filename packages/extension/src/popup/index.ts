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
// Read/write chrome.storage.local directly — no background roundtrip needed.

async function refreshWindowStatus() {
  const currentWindow = await chrome.windows.getCurrent();
  const { claudeWindowId } = await chrome.storage.local.get("claudeWindowId");

  // Validate stored windowId is still open
  let assignedId: number | null = claudeWindowId ?? null;
  if (assignedId) {
    try { await chrome.windows.get(assignedId); }
    catch { await chrome.storage.local.remove("claudeWindowId"); assignedId = null; }
  }

  if (assignedId) {
    const isThisWindow = assignedId === currentWindow.id;
    windowStatus.className = "window-status assigned";
    windowStatus.textContent = isThisWindow
      ? "✓ This window is assigned"
      : `Assigned to window #${assignedId} (not this one)`;
    btnSet.textContent = isThisWindow ? "Reassign to this window" : "Use this window instead";
    btnClear.style.display = "block";
  } else {
    windowStatus.className = "window-status";
    windowStatus.textContent = "No window assigned";
    btnSet.textContent = "Use this window for Claude";
    btnClear.style.display = "none";
  }
}

btnSet.addEventListener("click", async () => {
  const currentWindow = await chrome.windows.getCurrent();
  await chrome.storage.local.set({ claudeWindowId: currentWindow.id });
  await refreshWindowStatus();
});

btnClear.addEventListener("click", async () => {
  await chrome.storage.local.remove("claudeWindowId");
  await refreshWindowStatus();
});

refreshWindowStatus();
