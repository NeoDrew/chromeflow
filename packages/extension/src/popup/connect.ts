/**
 * Standalone "Add a connection" page, opened in its own window from the popup.
 *
 * Why a separate window: a browser-action popup closes the instant you click the
 * page, which makes it impossible to tab away, copy a URL/token, and paste it
 * back. This page is a real extension window, so it stays open while you copy
 * the connection URL and token from another tab. It writes the same
 * ConnConfig[] list in chrome.storage.local that the popup reads, so the
 * background worker connects the socket as soon as you add one.
 *
 * It deliberately does NOT subscribe to live "status" pushes / storage changes
 * to re-render, so an inbound update can never wipe a half-typed input. It only
 * re-renders on the user's own submit/delete.
 */

import {
  CONNECTIONS_STORAGE_KEY,
  allocateConnId,
  isSafeRemoteUrl,
  parseDomainList,
  type ConnConfig,
} from "../connections";

const root = document.getElementById("root")!;

async function readConfigs(): Promise<ConnConfig[]> {
  const s = await chrome.storage.local.get(CONNECTIONS_STORAGE_KEY);
  return (s[CONNECTIONS_STORAGE_KEY] as ConnConfig[]) ?? [];
}
async function writeConfigs(configs: ConnConfig[]): Promise<void> {
  await chrome.storage.local.set({ [CONNECTIONS_STORAGE_KEY]: configs });
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function render(
  configs: ConnConfig[],
  message?: string,
  prefill?: { url?: string; label?: string; origin?: string },
): void {
  const remotes = configs
    .filter((c) => c.kind === "remote")
    .sort((a, b) => a.connId - b.connId);

  const list = remotes.length
    ? `<ul class="conn-list">${remotes
        .map(
          (c) => `
        <li class="conn-item">
          <div class="conn-item-main">
            <div class="conn-item-title">${esc(c.label || c.url)}</div>
            <div class="conn-item-url">${esc(c.url)}</div>
          </div>
          <button class="btn-del" data-del="${c.connId}">Remove</button>
        </li>`
        )
        .join("")}</ul>`
    : `<p class="muted">No connections yet. Add one above.</p>`;

  root.innerHTML = `
    <h1>Add a connection</h1>
    <p class="lead">${
      prefill?.url
        ? "Review the connection below and click Add to connect your browser."
        : "This window stays open while you copy your connection URL from the other tab. Paste it in, then click Add."
    }</p>
    ${prefill?.origin ? `<div class="origin">Requested by <strong>${esc(prefill.origin)}</strong></div>` : ""}
    ${message ? `<div class="ok">${esc(message)}</div>` : ""}
    <form id="form" autocomplete="off">
      <label>Label <span class="muted">(optional)</span>
        <input name="label" type="text" placeholder="e.g. JobDog" value="${esc(prefill?.label ?? "")}" />
      </label>
      <label>Connection URL
        <input name="url" type="text" spellcheck="false" placeholder="wss://...onrender.com/ws?token=..." value="${esc(prefill?.url ?? "")}" required />
      </label>
      <label>Token <span class="muted">(optional, only if the URL has no ?token=)</span>
        <input name="token" type="text" spellcheck="false" placeholder="paste token" />
      </label>
      <details>
        <summary>Advanced: restrict which sites this connection may drive</summary>
        <label>Allow domains <span class="muted">(comma-separated)</span>
          <input name="allow" type="text" spellcheck="false" placeholder="linkedin.com, *.greenhouse.io" />
        </label>
        <label>Deny domains
          <input name="deny" type="text" spellcheck="false" placeholder="admin.example.com" />
        </label>
      </details>
      <button type="submit" class="btn-add">Add connection</button>
    </form>
    <h2>Your connections</h2>
    ${list}
  `;
}

async function reload(message?: string): Promise<void> {
  render(await readConfigs(), message);
}

root.addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = document.getElementById("form") as HTMLFormElement | null;
  if (!form) return;
  const get = (n: string) =>
    (form.querySelector<HTMLInputElement>(`[name="${n}"]`)?.value ?? "").trim();

  const url = get("url");
  if (!url) return;
  const label = get("label");
  if (!isSafeRemoteUrl(url)) {
    render(
      await readConfigs(),
      "Not added: a remote connection must use a secure wss:// URL (plain ws:// is only allowed to localhost). An insecure URL would send your token in cleartext.",
      { url, label },
    );
    return;
  }
  const token = get("token");
  const allow = parseDomainList(get("allow"));
  const deny = parseDomainList(get("deny"));

  const configs = await readConfigs();
  // Dedup by URL: re-adding the same connection (which happens on every
  // reconnect from a dashboard's one-click connect) must REPLACE the existing
  // entry, not stack another duplicate. Collapse any prior remote configs with
  // this exact URL, reusing the first one's connId for stable routing.
  const sameUrl = configs.filter((c) => c.kind === "remote" && c.url === url);
  const others = configs.filter((c) => !(c.kind === "remote" && c.url === url));
  const connId = sameUrl.length
    ? sameUrl[0].connId
    : allocateConnId(configs.map((c) => c.connId));
  const next: ConnConfig = {
    connId,
    kind: "remote",
    url,
    enabled: true,
    ...(label ? { label } : {}),
    ...(token ? { token } : {}),
    ...(allow.length ? { allow } : {}),
    ...(deny.length ? { deny } : {}),
  };
  await writeConfigs([...others, next]);
  await reload(
    sameUrl.length
      ? "Connection updated (replaced the existing entry for this URL). It should go live within a few seconds."
      : "Connection added. It should go live within a few seconds. You can add another or close this window."
  );
});

root.addEventListener("click", async (e) => {
  const del = (e.target as HTMLElement).closest<HTMLElement>("[data-del]");
  if (!del) return;
  const id = Number(del.getAttribute("data-del"));
  const configs = await readConfigs();
  await writeConfigs(configs.filter((c) => c.connId !== id));
  await reload("Connection removed.");
});

// On open, pre-fill from query params when a page requested the connection
// (background passes ?url=&label=&origin=). After the first submit/delete,
// reload() re-renders with an empty form.
const params = new URLSearchParams(location.search);
const prefill = params.get("url")
  ? {
      url: params.get("url") ?? "",
      label: params.get("label") ?? "",
      origin: params.get("origin") ?? "",
    }
  : undefined;
readConfigs().then((configs) => render(configs, undefined, prefill));
