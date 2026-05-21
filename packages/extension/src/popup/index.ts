/**
 * Popup UI — shows all detected Claude Code instances grouped by:
 *   1. THIS WINDOW   — instances assigned to the currently-focused window
 *   2. OTHER WINDOWS — instances assigned to a different Chrome window (collapsible)
 *   3. UNASSIGNED    — live instances with no window yet (collapsible)
 *
 * Each instance card shows the project name (large), with port + window status (small).
 * Falls back to "Port 7878" if no project label has been received yet.
 */

const groupsEl = document.getElementById("groups")!;
const statusPill = document.getElementById("status-pill")!;

type Host = "claude" | "codex";
type PortInfo = { port: number; label?: string; host?: Host };

type State = {
  livePorts: PortInfo[];
  instances: Record<string, number>; // port → windowId
  currentWindowId: number;
  validWindowIds: Set<number>;
};

const HOST_ICONS: Record<Host, { src: string; label: string }> = {
  claude: { src: "icons/host-claude.png", label: "Claude" },
  codex: { src: "icons/host-codex.png", label: "Codex" },
};

const collapsedGroups = new Set<string>();

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

  return { livePorts, instances, currentWindowId: currentWindow.id!, validWindowIds };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderInstanceCard(
  port: number,
  label: string | undefined,
  host: Host | undefined,
  isLive: boolean,
  assignedWindowId: number | undefined,
  currentWindowId: number,
): string {
  const isThisWindow = assignedWindowId === currentWindowId;
  const cardClass = ["instance"];
  if (isThisWindow) cardClass.push("this-window");
  if (!isLive) cardClass.push("offline");

  const displayName = label ?? `Port ${port}`;
  const nameClass = label ? "instance-name" : "instance-name unlabeled";

  const metaPieces: string[] = [];
  if (label) metaPieces.push(`Port ${port}`);
  if (!isLive) metaPieces.push(`<span class="meta-tag unassigned">offline</span>`);
  if (assignedWindowId) {
    metaPieces.push(
      isThisWindow
        ? `<span class="meta-tag">✓ this window</span>`
        : `<span class="meta-tag elsewhere">window #${assignedWindowId}</span>`
    );
  } else {
    metaPieces.push(`<span class="meta-tag unassigned">unassigned</span>`);
  }
  const metaHtml = metaPieces.join('<span class="meta-sep">·</span>');

  const primaryBtn = isThisWindow
    ? "✓ Assigned to this window"
    : assignedWindowId
      ? "Use this window instead"
      : "Use this window";
  const primaryDisabled = isThisWindow;

  const buttons = `
    <div class="btn-row">
      <button class="btn btn-primary" data-action="set" data-port="${port}"${primaryDisabled ? " disabled" : ""}>${primaryBtn}</button>
      ${assignedWindowId ? `<button class="btn btn-secondary" data-action="clear" data-port="${port}">Clear</button>` : ""}
    </div>
  `;

  const hostBadge = host
    ? `<div class="host-badge" title="${HOST_ICONS[host].label} session"><span class="host-label">${HOST_ICONS[host].label}</span><img class="host-icon" src="${HOST_ICONS[host].src}" alt="" /></div>`
    : "";

  return `
    <div class="${cardClass.join(" ")}" style="view-transition-name: card-${port}">
      <div class="instance-row">
        <div class="dot ${isLive ? "connected" : ""}"></div>
        <div class="${nameClass}">${escapeHtml(displayName)}</div>
        ${hostBadge}
      </div>
      <div class="instance-meta">${metaHtml}</div>
      ${buttons}
    </div>
  `;
}

function renderGroup(
  key: string,
  title: string,
  cards: string[],
  collapsible: boolean,
  emptyMessage?: string,
): string {
  if (cards.length === 0 && !emptyMessage) return "";
  const collapsed = collapsible && collapsedGroups.has(key);
  const groupClass = ["group"];
  if (collapsed) groupClass.push("collapsed");
  const headerClass = collapsible ? "group-header" : "group-header static";

  const body = cards.length > 0
    ? `<div class="group-body">${cards.join("")}</div>`
    : `<div class="group-body"><div class="empty">${emptyMessage}</div></div>`;

  const countBadge = cards.length > 0 ? `<span class="group-count">${cards.length}</span>` : "";
  const toggle = collapsible ? `<span class="group-toggle">▾</span>` : "";

  return `
    <div class="${groupClass.join(" ")}" data-group="${key}">
      <div class="${headerClass}" data-toggle-group="${collapsible ? key : ""}">
        <span class="group-title">${title}</span>
        <span class="group-right">${countBadge}${toggle}</span>
      </div>
      ${body}
    </div>
  `;
}

function render(state: State) {
  // Build label and host maps
  const labelMap = new Map<number, string>();
  const hostMap = new Map<number, Host>();
  for (const p of state.livePorts) {
    if (p.label) labelMap.set(p.port, p.label);
    if (p.host) hostMap.set(p.port, p.host);
  }

  // All known ports = live + assigned (even if offline)
  const allPorts = new Set<number>([
    ...state.livePorts.map((p) => p.port),
    ...Object.keys(state.instances).map(Number),
  ]);
  const sortedPorts = Array.from(allPorts).sort((a, b) => a - b);

  if (sortedPorts.length === 0) {
    groupsEl.innerHTML = `
      <div class="empty empty-onboard">
        <div class="empty-title">No Claude Code sessions yet</div>
        <div class="empty-subtitle">Get connected in two steps:</div>
        <div class="empty-steps">
          <div class="empty-step">
            <div class="step-num">1</div>
            <div class="step-body">
              Add &amp; install the Chromeflow plugin in Claude Code:
              <code>/plugin marketplace add https://gitlab.com/NeoDrew/chromeflow.git</code>
              <code>/plugin install chromeflow</code>
            </div>
          </div>
          <div class="empty-step">
            <div class="step-num">2</div>
            <div class="step-body">
              Open Claude Code in your project — sessions show up here automatically.
            </div>
          </div>
        </div>
      </div>
    `;
    return;
  }

  const thisWindow: string[] = [];
  const otherWindows: string[] = [];
  const unassigned: string[] = [];

  for (const port of sortedPorts) {
    const isLive = state.livePorts.some((p) => p.port === port);
    const label = labelMap.get(port);
    const host = hostMap.get(port);
    const assignedWindowId = state.instances[String(port)];
    const card = renderInstanceCard(port, label, host, isLive, assignedWindowId, state.currentWindowId);
    if (assignedWindowId === state.currentWindowId) {
      thisWindow.push(card);
    } else if (assignedWindowId) {
      otherWindows.push(card);
    } else {
      unassigned.push(card);
    }
  }

  const groups: string[] = [];
  groups.push(
    renderGroup(
      "this",
      "This window",
      thisWindow,
      false,
      "No session assigned to this window yet — use a card below."
    )
  );
  if (otherWindows.length > 0) {
    groups.push(renderGroup("others", "Other windows", otherWindows, true));
  }
  if (unassigned.length > 0) {
    groups.push(renderGroup("unassigned", "Unassigned", unassigned, true));
  }

  groupsEl.innerHTML = groups.join("");

  const activeCount = state.livePorts.length;
  const pillText = statusPill.querySelector(".pill-text")!;
  if (activeCount > 0) {
    statusPill.classList.remove("idle");
    pillText.textContent = `${activeCount} active`;
  } else {
    statusPill.classList.add("idle");
    pillText.textContent = "No active sessions";
  }
}

type DocumentWithViewTransitions = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => unknown;
};

function renderAnimated(state: State) {
  const doc = document as DocumentWithViewTransitions;
  if (typeof doc.startViewTransition === "function") {
    doc.startViewTransition(() => {
      render(state);
    });
  } else {
    render(state);
  }
}

groupsEl.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;

  // Group toggle — pure CSS transition on .group-body (grid-template-rows + opacity)
  // handles the slide; no view transition needed for collapse/expand.
  const toggleKey = target.closest<HTMLElement>("[data-toggle-group]")?.getAttribute("data-toggle-group");
  if (toggleKey) {
    if (collapsedGroups.has(toggleKey)) collapsedGroups.delete(toggleKey);
    else collapsedGroups.add(toggleKey);
    render(await loadState());
    return;
  }

  // Card buttons — re-render through View Transitions API so each card's
  // view-transition-name lets the browser interpolate its old → new position
  // when it moves between groups (slides instead of pops).
  const action = target.getAttribute("data-action");
  const portStr = target.getAttribute("data-port");
  if (!action || !portStr) return;

  const { claudeInstances } = await chrome.storage.local.get("claudeInstances");
  const instances = (claudeInstances as Record<string, number>) ?? {};

  if (action === "set") {
    const currentWindow = await chrome.windows.getCurrent();
    instances[portStr] = currentWindow.id!;
  } else if (action === "clear") {
    delete instances[portStr];
  }

  await chrome.storage.local.set({ claudeInstances: instances });
  renderAnimated(await loadState());
});

// Default: collapse the bigger groups so "this window" stands out
collapsedGroups.add("others");
collapsedGroups.add("unassigned");

// Listen for live-port changes from the offscreen document
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.source === "chromeflow-offscreen" && msg.type === "status") {
    loadState().then(render);
  }
});

loadState().then(render);
