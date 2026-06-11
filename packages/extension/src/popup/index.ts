/**
 * Popup UI with two stacked surfaces:
 *
 *   A. SESSIONS: every detected connection (default-port Claude Code / MCP
 *      instances plus configured remote endpoints), grouped by:
 *        1. THIS WINDOW   : instances assigned to the currently-focused window
 *        2. OTHER WINDOWS : instances assigned to a different Chrome window
 *        3. UNASSIGNED    : live instances with no window yet
 *      Each card shows label (large), port/url + window status (small), a kind
 *      badge (local/remote), a live dot, and pause / disconnect controls.
 *
 *   B. CONNECTIONS: a collapsible config panel for adding, editing, and
 *      deleting remote endpoints, each scopeable to a set of allow/deny domains
 *      that restrict which sites the connection may act on.
 *
 * Both surfaces read/write the same ConnConfig[] list in chrome.storage.local
 * under CONNECTIONS_STORAGE_KEY. The background worker watches storage.onChanged
 * and reconciles the offscreen sockets, so persisting is all the popup does;
 * it never talks to offscreen directly.
 */

import {
  CONNECTIONS_STORAGE_KEY,
  allocateConnId,
  isDefaultPort,
  parseDomainList,
  type ConnConfig,
} from "../connections";

const groupsEl = document.getElementById("groups")!;
const statusPill = document.getElementById("status-pill"); // removed from the header; may be absent
const connectionsEl = document.getElementById("connections")!;

// True while the user is typing in the add/edit connection form. Background
// "status" pushes (frequent during reconnects) must NOT re-render then, or they
// blow away the form and the half-typed/pasted URL. See the listeners at boot.
function formIsOpen(): boolean {
  return addFormOpen || editingConnId !== null;
}

type Host = "claude" | "codex";
type ConnKind = "local" | "remote";
type PortInfo = { port: number; label?: string; host?: Host; kind?: ConnKind };

type State = {
  livePorts: PortInfo[];
  configs: ConnConfig[];
  instances: Record<string, number>; // port → windowId
  currentWindowId: number;
  validWindowIds: Set<number>;
};

const HOST_ICONS: Record<Host, { src: string; label: string }> = {
  claude: { src: "icons/host-claude.png", label: "Claude" },
  codex: { src: "icons/host-codex.png", label: "Codex" },
};

const collapsedGroups = new Set<string>();
// The Connections config panel is its own collapsible; track its open state and
// whether the add form (vs. an inline row edit) is showing.
let connectionsOpen = false;
let addFormOpen = false;
let editingConnId: number | null = null;

function resizePopup() {
  document.body.style.height = "auto";
  document.body.style.height = document.body.scrollHeight + "px";
}

async function loadState(): Promise<State> {
  const [storage, currentWindow, allWindows] = await Promise.all([
    chrome.storage.local.get([
      "chromeflowLivePorts",
      "claudeInstances",
      CONNECTIONS_STORAGE_KEY,
    ]),
    chrome.windows.getCurrent(),
    chrome.windows.getAll(),
  ]);

  // Support both old format (number[]) and new format ({port, label, ...}[])
  const rawPorts = (storage.chromeflowLivePorts as (number | PortInfo)[]) ?? [];
  const livePorts: PortInfo[] = rawPorts.map((p) =>
    typeof p === "number" ? { port: p } : p
  );
  const configs = (storage[CONNECTIONS_STORAGE_KEY] as ConnConfig[]) ?? [];
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
    configs,
    instances,
    currentWindowId: currentWindow.id!,
    validWindowIds,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// ─── ConnConfig persistence helpers ──────────────────────────────────────────
// All mutations follow the same shape: read the current list, transform it,
// write it back. The background worker's storage.onChanged listener does the
// rest, so the popup just re-renders from a fresh loadState() afterwards.

async function readConfigs(): Promise<ConnConfig[]> {
  const storage = await chrome.storage.local.get(CONNECTIONS_STORAGE_KEY);
  return (storage[CONNECTIONS_STORAGE_KEY] as ConnConfig[]) ?? [];
}

async function writeConfigs(configs: ConnConfig[]): Promise<void> {
  await chrome.storage.local.set({ [CONNECTIONS_STORAGE_KEY]: configs });
}

async function mutateConfigs(
  fn: (configs: ConnConfig[]) => ConnConfig[]
): Promise<void> {
  const configs = await readConfigs();
  await writeConfigs(fn(configs));
}

function scopeArrays(allow: string[], deny: string[]): Pick<ConnConfig, "allow" | "deny"> {
  // Omit empty arrays entirely so scopeBlocks() treats them as "unrestricted"
  // (absent/empty allow = no allow-restriction).
  const out: Pick<ConnConfig, "allow" | "deny"> = {};
  if (allow.length) out.allow = allow;
  if (deny.length) out.deny = deny;
  return out;
}

// ─── Card rendering (Sessions surface) ───────────────────────────────────────

function kindBadge(kind: ConnKind): string {
  return `<span class="kind-badge kind-${kind}">${kind}</span>`;
}

function renderInstanceCard(
  port: number,
  label: string | undefined,
  host: Host | undefined,
  kind: ConnKind,
  url: string | undefined,
  isLive: boolean,
  isPaused: boolean,
  assignedWindowId: number | undefined,
  currentWindowId: number,
): string {
  const isThisWindow = assignedWindowId === currentWindowId;
  const cardClass = ["instance"];
  if (isThisWindow) cardClass.push("this-window");
  if (!isLive) cardClass.push("offline");
  if (isPaused) cardClass.push("paused");

  const displayName = label ?? `Port ${port}`;
  const nameClass = label ? "instance-name" : "instance-name unlabeled";

  // For remotes, the URL is more meaningful than the synthetic connId; for the
  // default range the port number is the identity.
  const locator = kind === "remote" && url ? url : `Port ${port}`;

  const metaPieces: string[] = [];
  if (label) metaPieces.push(escapeHtml(locator));
  if (isPaused) metaPieces.push(`<span class="meta-tag unassigned">paused</span>`);
  else if (!isLive) metaPieces.push(`<span class="meta-tag unassigned">offline</span>`);
  if (assignedWindowId) {
    metaPieces.push(
      isThisWindow
        ? `<span class="meta-tag">✓ this window</span>`
        : `<a class="meta-tag elsewhere go-to-window" href="#" data-window-id="${assignedWindowId}">go to window →</a>`
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

  // Pause toggles ConnConfig.enabled; disconnect removes a remote / pauses a
  // local. Both are keyed by port (== connId) so the click handler can resolve
  // the kind without another lookup.
  const pauseLabel = isPaused ? "Resume" : "Pause";
  const disconnectLabel = kind === "remote" ? "Disconnect" : "Pause";

  const buttons = `
    <div class="btn-row">
      <button class="btn btn-primary" data-action="set" data-port="${port}"${primaryDisabled ? " disabled" : ""}>${primaryBtn}</button>
      ${assignedWindowId ? `<button class="btn btn-secondary" data-action="clear" data-port="${port}">Clear</button>` : ""}
    </div>
    <div class="btn-row btn-row-conn">
      <button class="btn btn-ghost" data-action="pause" data-port="${port}" data-kind="${kind}">${pauseLabel}</button>
      ${kind === "remote" ? `<button class="btn btn-ghost btn-danger" data-action="disconnect" data-port="${port}" data-kind="${kind}">${disconnectLabel}</button>` : ""}
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
        ${kindBadge(kind)}
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

// ─── Unified connection model (live sockets ∪ configured entries) ────────────

type UnifiedConn = {
  port: number; // == connId
  kind: ConnKind;
  label?: string;
  host?: Host;
  url?: string;
  isLive: boolean;
  isPaused: boolean;
  assignedWindowId?: number;
};

/**
 * Merge live sockets and configured ConnConfig rows, keyed by connId/port. A
 * connection can exist as: only-live (a fresh auto-discovered local port with no
 * config yet), only-config (a paused or never-connected remote), or both.
 */
function buildUnified(state: State, displayLabelMap: Map<number, string>): UnifiedConn[] {
  const byPort = new Map<number, UnifiedConn>();

  const configByPort = new Map<number, ConnConfig>();
  for (const c of state.configs) configByPort.set(c.connId, c);

  // Seed from live sockets.
  for (const lp of state.livePorts) {
    const cfg = configByPort.get(lp.port);
    byPort.set(lp.port, {
      port: lp.port,
      kind: lp.kind ?? cfg?.kind ?? (isDefaultPort(lp.port) ? "local" : "remote"),
      label: displayLabelMap.get(lp.port) ?? lp.label ?? cfg?.label,
      host: lp.host,
      url: cfg?.url,
      isLive: true,
      isPaused: cfg ? !cfg.enabled : false,
      assignedWindowId: state.instances[String(lp.port)],
    });
  }

  // Fold in configured rows that aren't currently live.
  for (const cfg of state.configs) {
    const existing = byPort.get(cfg.connId);
    if (existing) {
      existing.url = existing.url ?? cfg.url;
      existing.label = existing.label ?? cfg.label;
      existing.isPaused = !cfg.enabled;
      continue;
    }
    byPort.set(cfg.connId, {
      port: cfg.connId,
      kind: cfg.kind,
      label: cfg.label,
      url: cfg.url,
      isLive: false,
      isPaused: !cfg.enabled,
      assignedWindowId: state.instances[String(cfg.connId)],
    });
  }

  // Also fold in window-assigned ports that are neither live nor configured
  // (offline default instances that retain a window assignment).
  for (const portStr of Object.keys(state.instances)) {
    const port = Number(portStr);
    if (byPort.has(port)) continue;
    byPort.set(port, {
      port,
      kind: isDefaultPort(port) ? "local" : "remote",
      isLive: false,
      isPaused: false,
      assignedWindowId: state.instances[portStr],
    });
  }

  return Array.from(byPort.values()).sort((a, b) => a.port - b.port);
}

function buildDisplayLabelMap(livePorts: PortInfo[]): Map<number, string> {
  const labelMap = new Map<number, string>();
  for (const p of livePorts) if (p.label) labelMap.set(p.port, p.label);

  // Deduplicate labels: if multiple ports share the same project name,
  // append (1), (2), etc. like duplicate filenames.
  const labelCounts = new Map<string, number>();
  const displayLabelMap = new Map<number, string>();
  for (const [port, label] of labelMap) {
    const n = (labelCounts.get(label) ?? 0) + 1;
    labelCounts.set(label, n);
    displayLabelMap.set(port, n > 1 ? `${label} (${n - 1})` : label);
  }
  for (const [port, label] of labelMap) {
    if ((labelCounts.get(label) ?? 0) > 1 && displayLabelMap.get(port) === label) {
      let idx = 0;
      for (const [p] of labelMap) {
        if (labelMap.get(p) === label) {
          idx++;
          displayLabelMap.set(p, idx === 1 ? label : `${label} (${idx - 1})`);
        }
      }
    }
  }
  return displayLabelMap;
}

// ─── Connections config panel rendering ──────────────────────────────────────

function domainListValue(arr: string[] | undefined): string {
  return (arr ?? []).join(", ");
}

function renderConnForm(existing?: ConnConfig): string {
  // Shared markup for both "add new remote" and "edit existing row". When
  // editing, fields are prefilled and the connId is carried on the form so the
  // submit handler updates in place instead of allocating a new one.
  const isEdit = !!existing;
  const connIdAttr = isEdit ? ` data-conn-id="${existing!.connId}"` : "";
  return `
    <form class="conn-form"${connIdAttr}>
      <label class="conn-field">
        <span class="conn-field-label">Label</span>
        <input class="conn-input" name="label" type="text" placeholder="My remote endpoint" value="${escapeHtml(existing?.label ?? "")}" />
      </label>
      <label class="conn-field">
        <span class="conn-field-label">URL</span>
        <input class="conn-input" name="url" type="text" placeholder="wss://example.com/mcp" value="${escapeHtml(existing?.url ?? "")}" required />
      </label>
      <label class="conn-field">
        <span class="conn-field-label">Token <span class="conn-field-hint">(optional)</span></span>
        <input class="conn-input" name="token" type="password" placeholder="bearer token" value="${escapeHtml(existing?.token ?? "")}" />
      </label>
      <label class="conn-field">
        <span class="conn-field-label">Allow domains <span class="conn-field-hint">(restrict which sites this connection may act on)</span></span>
        <input class="conn-input" name="allow" type="text" placeholder="example.com, *.acme.io" value="${escapeHtml(domainListValue(existing?.allow))}" />
      </label>
      <label class="conn-field">
        <span class="conn-field-label">Deny domains <span class="conn-field-hint">(sites this connection may never act on)</span></span>
        <input class="conn-input" name="deny" type="text" placeholder="admin.example.com" value="${escapeHtml(domainListValue(existing?.deny))}" />
      </label>
      <div class="btn-row">
        <button class="btn btn-primary" type="submit">${isEdit ? "Save" : "Add connection"}</button>
        <button class="btn btn-secondary" type="button" data-conn-action="cancel-form">Cancel</button>
      </div>
    </form>
  `;
}

function renderConfigRow(cfg: ConnConfig): string {
  if (editingConnId === cfg.connId) {
    return `<div class="conn-row editing">${renderConnForm(cfg)}</div>`;
  }
  const scopeBits: string[] = [];
  if (cfg.allow?.length) scopeBits.push(`allow: ${escapeHtml(cfg.allow.join(", "))}`);
  if (cfg.deny?.length) scopeBits.push(`deny: ${escapeHtml(cfg.deny.join(", "))}`);
  const scopeHtml = scopeBits.length
    ? `<div class="conn-row-scope">${scopeBits.join('<span class="meta-sep">·</span>')}</div>`
    : "";
  const title = cfg.label ? escapeHtml(cfg.label) : escapeHtml(cfg.url);
  return `
    <div class="conn-row" data-conn-id="${cfg.connId}">
      <div class="conn-row-main">
        <div class="conn-row-text">
          <div class="conn-row-title">${title} ${kindBadge(cfg.kind)}</div>
          <div class="conn-row-url">${escapeHtml(cfg.url)}</div>
          ${scopeHtml}
        </div>
        <div class="conn-row-actions">
          <button class="btn btn-ghost" data-conn-action="edit" data-conn-id="${cfg.connId}">Edit</button>
          <button class="btn btn-ghost btn-danger" data-conn-action="delete" data-conn-id="${cfg.connId}">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function renderConnectionsPanel(state: State) {
  // Only remotes are user-managed config rows here; default local ports are
  // discovered automatically and managed from their session card (pause/resume).
  const remotes = state.configs
    .filter((c) => c.kind === "remote")
    .sort((a, b) => a.connId - b.connId);

  const rows = remotes.map(renderConfigRow).join("");
  const listHtml = remotes.length
    ? `<div class="conn-list">${rows}</div>`
    : `<div class="empty">No remote endpoints configured. Add one to drive the browser on behalf of a remote MCP server.</div>`;

  const formHtml = addFormOpen ? renderConnForm() : "";
  const addBtn = addFormOpen
    ? ""
    : `<button class="btn btn-secondary conn-add-btn" data-conn-action="show-add-form">+ Add connection</button>`;

  const panelClass = ["group", "conn-panel"];
  if (!connectionsOpen) panelClass.push("collapsed");

  connectionsEl.innerHTML = `
    <div class="${panelClass.join(" ")}" data-group="connections">
      <div class="group-header" data-toggle-connections="1">
        <span class="group-title">Connections</span>
        <span class="group-right">
          ${remotes.length ? `<span class="group-count">${remotes.length}</span>` : ""}
          <span class="group-toggle">▾</span>
        </span>
      </div>
      <div class="group-body">
        <div class="conn-panel-body">
          ${listHtml}
          ${formHtml}
          ${addBtn}
        </div>
      </div>
    </div>
  `;

  // Match the Sessions groups: expanded bodies need an explicit pixel height so
  // the max-height transition animates.
  for (const body of Array.from(connectionsEl.querySelectorAll<HTMLElement>(".group:not(.collapsed) .group-body"))) {
    body.style.maxHeight = body.scrollHeight + "px";
  }
}

// ─── Top-level render ────────────────────────────────────────────────────────

function render(state: State) {
  const displayLabelMap = buildDisplayLabelMap(state.livePorts);
  const unified = buildUnified(state, displayLabelMap);

  renderConnectionsPanel(state);

  if (unified.length === 0) {
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
    resizePopup();
    updateStatusPill(state);
    return;
  }

  const thisWindow: string[] = [];
  const otherWindows: string[] = [];
  const unassigned: string[] = [];

  for (const c of unified) {
    const card = renderInstanceCard(
      c.port,
      c.label,
      c.host,
      c.kind,
      c.url,
      c.isLive,
      c.isPaused,
      c.assignedWindowId,
      state.currentWindowId,
    );
    if (c.assignedWindowId === state.currentWindowId) {
      thisWindow.push(card);
    } else if (c.assignedWindowId) {
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

  // Set max-height on each expanded group body so CSS transitions work.
  for (const body of Array.from(groupsEl.querySelectorAll<HTMLElement>(".group:not(.collapsed) .group-body"))) {
    body.style.maxHeight = body.scrollHeight + "px";
  }

  resizePopup();
  updateStatusPill(state);
}

function updateStatusPill(state: State) {
  if (!statusPill) return; // pill removed from the header
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

async function reload() {
  render(await loadState());
}

// ─── Sessions surface: window-assignment + pause/disconnect handlers ─────────

groupsEl.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;

  // "go to window" link — focus that Chrome window
  const goToWindow = target.closest<HTMLElement>(".go-to-window");
  if (goToWindow) {
    e.preventDefault();
    const wid = Number(goToWindow.getAttribute("data-window-id"));
    if (wid) chrome.windows.update(wid, { focused: true });
    return;
  }

  const toggleKey = target.closest<HTMLElement>("[data-toggle-group]")?.getAttribute("data-toggle-group");
  if (toggleKey) {
    animateGroupToggle(groupsEl, toggleKey);
    return;
  }

  const action = target.getAttribute("data-action");
  const portStr = target.getAttribute("data-port");
  if (!action || !portStr) return;
  const port = Number(portStr);
  const kind = (target.getAttribute("data-kind") as ConnKind | null) ?? "local";

  if (action === "set" || action === "clear") {
    const { claudeInstances } = await chrome.storage.local.get("claudeInstances");
    const instances = (claudeInstances as Record<string, number>) ?? {};
    if (action === "set") {
      const currentWindow = await chrome.windows.getCurrent();
      instances[portStr] = currentWindow.id!;
    } else {
      delete instances[portStr];
    }
    await chrome.storage.local.set({ claudeInstances: instances });
    renderAnimated(await loadState());
    return;
  }

  if (action === "pause") {
    await togglePause(port, kind);
    renderAnimated(await loadState());
    return;
  }

  if (action === "disconnect") {
    await disconnect(port, kind);
    renderAnimated(await loadState());
    return;
  }
});

/**
 * PAUSE toggle = flip ConnConfig.enabled. A bare auto-discovered local port has
 * no ConnConfig row; pausing materializes one with enabled:false so offscreen
 * stops reconnecting it. Resuming a local port removes the materialized row
 * (back to default unrestricted behaviour) rather than leaving a dead record.
 */
async function togglePause(port: number, kind: ConnKind) {
  await mutateConfigs((configs) => {
    const idx = configs.findIndex((c) => c.connId === port);
    if (idx === -1) {
      // No row yet; only locals reach here (remotes always have a row).
      return [
        ...configs,
        {
          connId: port,
          kind: "local",
          url: `ws://localhost:${port}`,
          enabled: false,
        } satisfies ConnConfig,
      ];
    }
    const existing = configs[idx];
    const resuming = !existing.enabled;
    if (resuming && existing.kind === "local" && isDefaultPort(existing.connId)) {
      // Un-pausing a default local: drop the record so it reverts to the
      // implicit "default, unrestricted" state.
      return configs.filter((_, i) => i !== idx);
    }
    const next = configs.slice();
    next[idx] = { ...existing, enabled: resuming };
    return next;
  });
}

/**
 * DISCONNECT: a remote is removed from the config entirely. A local port has no
 * "remove" (it would just be rediscovered), so disconnecting it is the same as
 * pausing (enabled:false, materializing a row if needed).
 */
async function disconnect(port: number, kind: ConnKind) {
  if (kind === "remote") {
    await mutateConfigs((configs) => configs.filter((c) => c.connId !== port));
    return;
  }
  await mutateConfigs((configs) => {
    const idx = configs.findIndex((c) => c.connId === port);
    if (idx === -1) {
      return [
        ...configs,
        {
          connId: port,
          kind: "local",
          url: `ws://localhost:${port}`,
          enabled: false,
        } satisfies ConnConfig,
      ];
    }
    const next = configs.slice();
    next[idx] = { ...next[idx], enabled: false };
    return next;
  });
}

// ─── Connections panel: toggle, add-form, edit, delete handlers ──────────────

connectionsEl.addEventListener("click", async (e) => {
  const target = e.target as HTMLElement;

  if (target.closest<HTMLElement>("[data-toggle-connections]")) {
    connectionsOpen = !connectionsOpen;
    if (!connectionsOpen) {
      // Collapsing the panel also closes any open form so it doesn't reappear.
      addFormOpen = false;
      editingConnId = null;
    }
    void persistUiState();
    animateGroupToggle(connectionsEl, "connections", () => reload());
    return;
  }

  const connAction = target.getAttribute("data-conn-action");
  if (!connAction) return;

  if (connAction === "show-add-form") {
    addFormOpen = true;
    editingConnId = null;
    void persistUiState();
    await reload();
    return;
  }
  if (connAction === "cancel-form") {
    addFormOpen = false;
    editingConnId = null;
    void persistUiState();
    await reload();
    return;
  }
  if (connAction === "edit") {
    editingConnId = Number(target.getAttribute("data-conn-id"));
    addFormOpen = false;
    await reload();
    return;
  }
  if (connAction === "delete") {
    const id = Number(target.getAttribute("data-conn-id"));
    await mutateConfigs((configs) => configs.filter((c) => c.connId !== id));
    if (editingConnId === id) editingConnId = null;
    await reload();
    return;
  }
});

connectionsEl.addEventListener("submit", async (e) => {
  const form = (e.target as HTMLElement).closest<HTMLFormElement>(".conn-form");
  if (!form) return;
  e.preventDefault();

  const get = (name: string) =>
    (form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? "").trim();
  const url = get("url");
  if (!url) return; // required; the browser also enforces via the required attr

  const label = get("label");
  const token = get("token");
  const allow = parseDomainList(get("allow"));
  const deny = parseDomainList(get("deny"));
  const editId = form.getAttribute("data-conn-id");

  await mutateConfigs((configs) => {
    if (editId !== null) {
      // Edit in place, keeping the connId stable (routing key must not change).
      const id = Number(editId);
      return configs.map((c) =>
        c.connId === id
          ? {
              ...c,
              label: label || undefined,
              url,
              token: token || undefined,
              ...{ allow: undefined, deny: undefined }, // clear first so removed scopes drop
              ...scopeArrays(allow, deny),
            }
          : c
      );
    }
    // New remote: allocate a stable connId clear of the live port range.
    const connId = allocateConnId(configs.map((c) => c.connId));
    const next: ConnConfig = {
      connId,
      kind: "remote",
      label: label || undefined,
      url,
      token: token || undefined,
      enabled: true,
      ...scopeArrays(allow, deny),
    };
    return [...configs, next];
  });

  addFormOpen = false;
  editingConnId = null;
  void persistUiState();
  await reload();
});

// ─── Shared collapse/expand animation (reused by both surfaces) ──────────────

function animateGroupToggle(
  rootEl: HTMLElement,
  key: string,
  fallbackRender?: () => void,
) {
  // The Connections panel tracks its own open flag rather than collapsedGroups.
  const isConnections = key === "connections";
  const group = rootEl.querySelector<HTMLElement>(`[data-group="${key}"]`);
  const body = group?.querySelector<HTMLElement>(".group-body");
  const expanding = isConnections
    ? connectionsOpen // already flipped by caller
    : collapsedGroups.has(key);

  if (!isConnections) {
    if (expanding) collapsedGroups.delete(key);
    else collapsedGroups.add(key);
  }

  if (!group || !body) {
    if (fallbackRender) fallbackRender();
    else reload();
    return;
  }

  if (expanding) {
    group.classList.remove("collapsed");
    body.style.maxHeight = "0";
    requestAnimationFrame(() => {
      body.style.maxHeight = body.scrollHeight + "px";
      const onEnd = () => { body.removeEventListener("transitionend", onEnd); resizePopup(); };
      body.addEventListener("transitionend", onEnd);
      resizePopup();
    });
    group.querySelector(".group-toggle")?.removeAttribute("style");
  } else {
    body.style.maxHeight = body.scrollHeight + "px";
    requestAnimationFrame(() => {
      group.classList.add("collapsed");
      const onEnd = () => { body.removeEventListener("transitionend", onEnd); resizePopup(); };
      body.addEventListener("transitionend", onEnd);
      const shrink = () => {
        if (!group.classList.contains("collapsed")) return;
        resizePopup();
        if (body.offsetHeight > 0) requestAnimationFrame(shrink);
      };
      requestAnimationFrame(shrink);
    });
  }
}

// ─── Boot ────────────────────────────────────────────────────────────────────

// Default: collapse the bigger groups so "this window" stands out
collapsedGroups.add("others");
collapsedGroups.add("unassigned");

// Remember the Connections panel / add-form open state across popup opens, so
// configuring a remote endpoint does not reset every time the popup closes
// (Chrome closes a browser-action popup whenever you click the page). Stored in
// session storage so it clears when the browser restarts.
const UI_STATE_KEY = "chromeflowPopupUi";
async function persistUiState(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [UI_STATE_KEY]: { connectionsOpen, addFormOpen },
    });
  } catch {
    // session storage may be unavailable; non-fatal
  }
}
async function restoreUiState(): Promise<void> {
  try {
    const { [UI_STATE_KEY]: ui } = await chrome.storage.session.get(UI_STATE_KEY);
    if (ui && typeof ui === "object") {
      connectionsOpen = !!(ui as { connectionsOpen?: boolean }).connectionsOpen;
      addFormOpen = !!(ui as { addFormOpen?: boolean }).addFormOpen;
    }
  } catch {
    // non-fatal
  }
}

// Listen for live-port + config changes and re-render. CRUCIAL: while the
// add/edit connection form is open, skip these re-renders. They rebuild the
// form's markup and would wipe the URL/token the user is mid-typing or pasting,
// which is the "the box keeps clearing" bug.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.source === "chromeflow-offscreen" && msg.type === "status") {
    if (formIsOpen()) return;
    loadState().then((s) => { render(s); resizePopup(); });
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CONNECTIONS_STORAGE_KEY]) {
    if (formIsOpen()) return;
    loadState().then((s) => { render(s); resizePopup(); });
  }
});

restoreUiState()
  .then(() => loadState())
  .then((s) => {
    render(s);
    requestAnimationFrame(() => document.body.classList.add("ready"));
  });
