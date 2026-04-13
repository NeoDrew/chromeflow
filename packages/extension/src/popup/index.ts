/**
 * Popup UI — shows all detected Claude Code instances (one per WS port)
 * and lets the user assign a Chrome window to each.
 */

const instancesEl = document.getElementById("instances")!;

type PortInfo = { port: number; label?: string };

type State = {
  livePorts: PortInfo[];
  instances: Record<string, number>; // port → windowId
  currentWindowId: number;
  validWindowIds: Set<number>;
};

async function loadState(): Promise<State> {
  const [storage, currentWindow, allWindows] = await Promise.all([
    chrome.storage.local.get(["chromeflowLivePorts", "claudeInstances"]),
    chrome.windows.getCurrent(),
    chrome.windows.getAll(),
  ]);

  // Support both old format (number[]) and new format ({port, label}[])
  const rawPorts = (storage.chromeflowLivePorts as (number | PortInfo)[]) ?? [];
  const livePorts: PortInfo[] = rawPorts.map((p) =>
    typeof p === "number" ? { port: p } : p
  );
  const instances = (storage.claudeInstances as Record<string, number>) ?? {};
  const validWindowIds = new Set(allWindows.map((w) => w.id!).filter(Boolean));

  // Clear assignments to closed windows
  let dirty = false;
  for (const port of Object.keys(instances)) {
    if (!validWindowIds.has(instances[port])) {
      delete instances[port];
      dirty = true;
    }
  }
  if (dirty) {
    await chrome.storage.local.set({ claudeInstances: instances });
  }

  return {
    livePorts,
    instances,
    currentWindowId: currentWindow.id!,
    validWindowIds,
  };
}

function render(state: State) {
  // Show all live ports plus any ports that have assignments (even if disconnected)
  // Build a map of port → label from live data
  const labelMap = new Map<number, string>();
  for (const p of state.livePorts) {
    if (p.label) labelMap.set(p.port, p.label);
  }

  const allPorts = new Set<number>([
    ...state.livePorts.map((p) => p.port),
    ...Object.keys(state.instances).map(Number),
  ]);
  const sortedPorts = Array.from(allPorts).sort((a, b) => a - b);

  if (sortedPorts.length === 0) {
    instancesEl.innerHTML = `
      <div class="empty">
        No Claude Code instances detected.<br>
        Start chromeflow MCP in your project to begin.
      </div>
    `;
    return;
  }

  instancesEl.innerHTML = "";
  for (const port of sortedPorts) {
    const isLive = state.livePorts.some((p) => p.port === port);
    const label = labelMap.get(port);
    const assignedWindowId = state.instances[String(port)];
    const isThisWindow = assignedWindowId === state.currentWindowId;

    const div = document.createElement("div");
    div.className = "instance";

    let statusText: string;
    let statusClass = "instance-status";
    let primaryBtnText: string;
    let showClearBtn = false;

    if (assignedWindowId) {
      statusClass += " assigned";
      statusText = isThisWindow
        ? "✓ This window assigned"
        : `Window #${assignedWindowId} (not this one)`;
      primaryBtnText = isThisWindow ? "Reassign to this window" : "Use this window instead";
      showClearBtn = true;
    } else {
      statusText = "No window assigned";
      primaryBtnText = "Use this window";
    }

    div.innerHTML = `
      <div class="instance-header">
        <div class="dot ${isLive ? "connected" : ""}"></div>
        <div class="instance-port">${label ? `${label} ` : ""}(Port ${port})${isLive ? "" : " — offline"}</div>
      </div>
      <div class="${statusClass}">${statusText}</div>
      <button class="btn btn-primary" data-action="set" data-port="${port}">${primaryBtnText}</button>
      ${showClearBtn ? `<button class="btn btn-secondary" data-action="clear" data-port="${port}">Clear assignment</button>` : ""}
    `;
    instancesEl.appendChild(div);
  }
}

instancesEl.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;
  const action = target.getAttribute("data-action");
  const portStr = target.getAttribute("data-port");
  if (!action || !portStr) return;

  const port = portStr;
  const { claudeInstances } = await chrome.storage.local.get("claudeInstances");
  const instances = (claudeInstances as Record<string, number>) ?? {};

  if (action === "set") {
    const currentWindow = await chrome.windows.getCurrent();
    instances[port] = currentWindow.id!;
  } else if (action === "clear") {
    delete instances[port];
  }

  await chrome.storage.local.set({ claudeInstances: instances });
  render(await loadState());
});

// Listen for live-port changes from the offscreen document
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.source === "chromeflow-offscreen" && msg.type === "status") {
    loadState().then(render);
  }
});

loadState().then(render);
