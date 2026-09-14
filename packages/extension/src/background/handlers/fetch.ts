// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab, getWindowId, connScope, guardPrivilegedFetch } from "../state";
import { withDebugger } from "../cdp";
import { detectAntiBot, httpHostname } from "../policy";
import { scopeBlocks } from "../../connections";
import { parseDoc, detectFormat, type SupportedFormat } from "../../lib/parse-doc";

export async function handleInspectRequestHeaders(msg: McpMsg, port: number): Promise<unknown> {
      const targetUrl = msg.url as string;
      // Captures the request's Cookie header for targetUrl — confine remotes to
      // scope, deny unscoped remotes (a hosted agent must not read arbitrary
      // origins' session cookies).
      guardPrivilegedFetch(port, targetUrl);
      const useNewTab = msg.new_tab !== false; // default true

      // Pick the tab we'll attach the debugger to. When useNewTab is true,
      // open a fresh tab in chromeflow's window (so the user's active tab keeps
      // its form/scroll state) and close it once headers are captured.
      let tabId: number;
      let cleanupTabId: number | null = null;
      if (useNewTab) {
        await getActiveTab(port); // ensure window assigned
        const wid = getWindowId(port)!;
        const newTab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: wid });
        if (!newTab.id) {
          throw new Error("Could not open a background tab for inspect_request_headers.");
        }
        tabId = newTab.id;
        cleanupTabId = newTab.id;
      } else {
        const tab = await getActiveTab(port);
        tabId = tab.id!;
      }

      try {
      const captured = await withDebugger(tabId, async () => {
        const dbg = chrome.debugger as unknown as {
          sendCommand: (target: { tabId: number }, method: string, params?: object) => Promise<unknown>;
        };

        await dbg.sendCommand({ tabId }, "Network.enable", {});

        // Buffer extraInfo events by requestId — per CDP spec they can arrive
        // before or after Network.requestWillBeSent.
        const extraInfoByReqId = new Map<string, Record<string, string>>();
        let pendingRequestId: string | null = null;
        let pendingMeta: { url: string; method: string } | null = null;

        const captureProm = new Promise<{ url: string; method: string; headers: Record<string, string> }>((resolve, reject) => {
          const finish = () => {
            if (!pendingRequestId || !pendingMeta) return;
            const headers = extraInfoByReqId.get(pendingRequestId);
            if (!headers) return;
            clearTimeout(timeout);
            chrome.debugger.onEvent.removeListener(listener);
            resolve({ ...pendingMeta, headers });
          };

          const listener = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
            if (source.tabId !== tabId) return;
            const p = (params ?? {}) as Record<string, unknown>;

            if (method === "Network.requestWillBeSent") {
              const req = p.request as { url: string; method: string } | undefined;
              if (!req) return;
              const type = p.type as string | undefined;
              // Match the main document request to targetUrl. Prefer type==="Document";
              // fall back to first URL-match if type is missing (edge cases).
              if ((req.url === targetUrl || req.url.startsWith(targetUrl)) && !pendingRequestId) {
                if (type === "Document" || !type) {
                  pendingRequestId = p.requestId as string;
                  pendingMeta = { url: req.url, method: req.method };
                  finish();
                }
              }
            }

            if (method === "Network.requestWillBeSentExtraInfo") {
              const reqId = p.requestId as string;
              const headers = p.headers as Record<string, string>;
              extraInfoByReqId.set(reqId, headers);
              finish();
            }
          };

          const timeout = setTimeout(() => {
            chrome.debugger.onEvent.removeListener(listener);
            if (pendingMeta && pendingRequestId) {
              // We saw the request but never got extra-info; return whatever we have.
              resolve({ ...pendingMeta, headers: extraInfoByReqId.get(pendingRequestId) ?? {} });
            } else {
              reject(new Error(`Timed out waiting for request to ${targetUrl}`));
            }
          }, 15000);

          chrome.debugger.onEvent.addListener(listener);
        });

        // Trigger navigation via CDP — works even when already on targetUrl,
        // unlike chrome.tabs.update which may silently no-op.
        await dbg.sendCommand({ tabId }, "Page.navigate", { url: targetUrl });

        return await captureProm;
      });

      const lines = [`${captured.method} ${captured.url}`, ""];
      const sortedKeys = Object.keys(captured.headers).sort();
      for (const k of sortedKeys) {
        lines.push(`${k}: ${captured.headers[k]}`);
      }
      if (sortedKeys.length === 0) {
        lines.push("(no headers captured — extra-info event never fired; try again)");
      }
      return { type: "action_done", requestId: msg.requestId, message: lines.join("\n") };
      } finally {
        // Close the side-tab we opened for inspection, regardless of success.
        if (cleanupTabId !== null) {
          try { await chrome.tabs.remove(cleanupTabId); } catch { /* tab may already be gone */ }
        }
      }
}

export async function handleDownloadFile(msg: McpMsg, port: number): Promise<unknown> {
      const url = msg.url as string;
      guardPrivilegedFetch(port, url);
      const filename = msg.filename as string | undefined;
      const timeoutMs = (msg.timeout_ms as number | undefined) ?? 60000;

      // chrome.downloads goes through the extension's privileged network stack,
      // so it picks up the user's existing cookies for the URL's origin.
      // That's what makes authenticated downloads (Canvas docx, Stripe receipts,
      // GitHub release tarballs behind SSO) work without re-auth.
      const id = await chrome.downloads.download({
        url,
        filename,
        conflictAction: "uniquify",
      });

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          chrome.downloads.onChanged.removeListener(onChanged);
          reject(new Error(`download timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        const onChanged = (delta: chrome.downloads.DownloadDelta) => {
          if (delta.id !== id) return;
          const state = delta.state?.current;
          if (state === "complete") {
            chrome.downloads.onChanged.removeListener(onChanged);
            clearTimeout(timer);
            resolve();
          } else if (state === "interrupted") {
            chrome.downloads.onChanged.removeListener(onChanged);
            clearTimeout(timer);
            reject(new Error(`download interrupted: ${delta.error?.current ?? "unknown"}`));
          }
        };
        chrome.downloads.onChanged.addListener(onChanged);
      });

      const [item] = await chrome.downloads.search({ id });
      if (!item) throw new Error("download record vanished after completion");
      return {
        type: "download_file_response",
        requestId: msg.requestId,
        path: item.filename,
        mime: item.mime ?? "",
        size: item.fileSize ?? 0,
      };
}

export async function handleFetchUrl(msg: McpMsg, port: number): Promise<unknown> {
      const url = msg.url as string;
      // Privileged fetch (extension authority + cookie jar, no tab): confine
      // remotes to scope, deny unscoped remotes. The top-of-handler guard only
      // covers the active tab, not this arbitrary target url.
      guardPrivilegedFetch(port, url);
      const method = (msg.method as string | undefined) ?? "GET";
      const reqHeaders = (msg.headers as Record<string, string> | undefined) ?? {};
      const body = msg.body as string | undefined;
      const binary = !!msg.binary;
      const timeoutMs = (msg.timeout_ms as number | undefined) ?? 30000;
      const maxBytes = (msg.max_bytes as number | undefined) ?? 2_000_000;

      // Privileged fetch: runs in the extension service-worker context, so:
      //  - extension's host_permissions (<all_urls>) apply; no page CSP
      //  - Chrome's cookie jar is included automatically for any origin
      //  - page's connect-src directive does not apply
      // This is what unblocks Canvas-style "page CSP says no" workflows.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: reqHeaders,
          body: body !== undefined && method !== "GET" && method !== "HEAD" ? body : undefined,
          signal: ctl.signal,
          credentials: "include",
        });
      } finally {
        clearTimeout(timer);
      }

      // Redirect re-check: fetch() follows 3xx by default, so an in-scope target
      // can land on an out-of-scope origin. Re-validate the FINAL url before
      // exposing any response data.
      if (connScope.has(port)) {
        const landedHost = httpHostname(resp.url);
        if (landedHost) {
          const v = scopeBlocks(connScope.get(port), landedHost);
          if (v.blocked) throw new Error("chromeflow: fetch redirected out of scope — " + v.reason);
        }
      }

      const headers: Record<string, string> = {};
      resp.headers.forEach((v, k) => { headers[k] = v; });
      const contentType = resp.headers.get("content-type") ?? "";

      const buf = await resp.arrayBuffer();

      // parse (formerly the standalone read_attachment tool): format-aware text
      // extraction instead of raw bytes/text. Runs on the FULL buffer, before
      // any max_bytes clipping below — a docx is a ZIP file, and truncating one
      // mid-byte-stream would corrupt it before parseDoc ever sees it. Only the
      // resulting extracted TEXT is truncated, by character count.
      const parseParam = msg.parse as string | undefined;
      if (parseParam) {
        const format = (parseParam === "auto" ? undefined : (parseParam as SupportedFormat)) ?? detectFormat(contentType, url);
        if (!format) {
          throw new Error(
            `Could not detect format for ${url} (content-type: "${contentType}"). Pass parse: "txt" | "md" | "csv" | "json" | "xml" | "html" | "docx" | "pdf" explicitly instead of "auto".`
          );
        }
        const fullText = await parseDoc(buf, format);
        const maxChars = (msg.max_chars as number | undefined) ?? 50_000;
        const textTruncated = fullText.length > maxChars;
        const text = textTruncated ? fullText.slice(0, maxChars) : fullText;
        return {
          type: "fetch_url_response",
          requestId: msg.requestId,
          status: resp.status,
          status_text: resp.statusText,
          headers,
          content_type: contentType,
          format,
          text,
          total_chars: fullText.length,
          truncated: textTruncated,
        };
      }

      const totalBytes = buf.byteLength;
      const truncated = totalBytes > maxBytes;
      const clipped = truncated ? buf.slice(0, maxBytes) : buf;

      if (binary) {
        // Chunked base64 encode to avoid blowing the call stack on large bodies.
        const bytes = new Uint8Array(clipped);
        const CHUNK = 0x8000;
        const parts: string[] = [];
        for (let i = 0; i < bytes.length; i += CHUNK) {
          parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
        }
        const body_base64 = btoa(parts.join(""));
        return {
          type: "fetch_url_response",
          requestId: msg.requestId,
          status: resp.status,
          status_text: resp.statusText,
          headers,
          content_type: contentType,
          body_base64,
          truncated,
          total_bytes: totalBytes,
        };
      }
      const body_text = new TextDecoder("utf-8", { fatal: false }).decode(clipped);
      // Anti-bot detection on text/html responses only (skip for json/xml/etc).
      // Useful when fetch_url lands on a Cloudflare challenge page instead of
      // the expected JSON body — surfaces the block as a structured signal so
      // the caller doesn't waste a debugging cycle on "why is my parse failing".
      const antiBotDetected = /text\/html/i.test(contentType)
        ? detectAntiBot(body_text)
        : null;
      return {
        type: "fetch_url_response",
        requestId: msg.requestId,
        status: resp.status,
        status_text: resp.statusText,
        headers,
        content_type: contentType,
        body_text,
        truncated,
        total_bytes: totalBytes,
        anti_bot_detected: antiBotDetected,
      };
}
