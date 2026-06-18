import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WsBridge } from "../../ws-bridge.js";

export function registerScriptingTools(server: McpServer, bridge: WsBridge) {
  server.tool(
    "execute_script",
    `Execute JavaScript in a tab's MAIN world (the page's own context, not the extension's isolated world). Use for reading framework state or DOM properties not visible in text — prefer get_page_text for visible content. Top-level \`return\` and \`await\` are supported.

**Object returns are auto-stringified** — return an object/array and the response carries its JSON. No need to wrap return values in JSON.stringify yourself.

**Shadow-piercing helpers are pre-injected** into every script:
- \`$deep(selector, root?)\` — querySelector that walks open shadow roots
- \`$deepAll(selector, root?)\` — querySelectorAll equivalent, returns an array
- \`shadowDocument\` — the open shadow root with the most interactive elements (buttons, inputs, links), or \`document\` if none. Useful when an SPA mounts ALL of its UI inside a single root shadow host (annotation-style dashboards that wrap the whole app in one web component): replace every \`document.querySelector*\` call with \`shadowDocument.querySelector*\` and the same code now reaches the SPA's content. On pages with multiple shadow roots (e.g. one for CSS theme vars, one for content), this picks the content root automatically.
- \`shadowDocuments\` — array of ALL open shadow roots on the page (in DOM order). Use when you need to search across multiple shadow roots or when the automatic pick is wrong.

The helpers pierce OPEN shadow roots only — MAIN world can't reach closed roots. For closed roots, use find_text / get_page_text / click_element / fill_input which pierce both kinds via chrome.dom.openOrClosedShadowRoot.

MAIN-world means the page's Content-Security-Policy applies: \`fetch()\` against authenticated APIs is often blocked by the page's connect-src directive. When that happens, switch to fetch_url — it runs in the extension's privileged context (full host_permissions, automatic cookie jar, no page CSP).

CSP-strict pages that disallow eval (Stripe, GitHub) silently fall through to a CDP eval path. Page alerts (alert/confirm/prompt) fired since the last script appear as PAGE ALERT in the result.

Pass \`tab_query\` to run the script against a specific tab without focus-switching (helpful for self-rescheduling loops where the active tab may have drifted while AFK). Accepts the same syntax as switch_to_tab: numeric index, URL substring, or title substring.

When the page navigates mid-script, the response carries \`navigated: true\` and result="[navigated]" instead of a thrown error — verify post-navigation state with get_page_text or wait_for. When host permission was lost (idle tab eviction), the handler reloads the tab once and retries; the response includes \`reauthorized: true\` so callers can see what happened.`,
    {
      code: z
        .string()
        .describe(
          "JavaScript expression or multi-statement script to evaluate in the page. Top-level `return` is supported."
        ),
      tab_query: z
        .string()
        .optional()
        .describe('Run against a specific tab without changing focus. Same syntax as switch_to_tab: numeric index, URL substring, or title substring. Omit to run against the active tab.'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe('Script execution timeout in milliseconds (default 30000). When the script exceeds this limit, execution is terminated via CDP Runtime.terminateExecution and the debugger is released cleanly. Without this, a hung script locks the debugger session indefinitely and every subsequent tool call fails with "Another debugger is already attached." Increase for large DOM traversals inside shadow roots; decrease when you want fast failure on scripts that might hang.'),
    },
    async ({ code, tab_query, timeout_ms }) => {
      const response = await bridge.request({ type: "execute_script", code, tab_query, timeout_ms });
      if (response.type !== "script_response") throw new Error("Unexpected response");
      const { result, alert, navigated, reauthorized } = response as { result: string; alert?: string | null; navigated?: boolean; reauthorized?: boolean };
      let text = `Result: ${result}`;
      const flags: string[] = ["context: main"];
      if (navigated) flags.push("navigated");
      if (reauthorized) flags.push("tab reauthorized (auto-reload)");
      text = `[${flags.join(", ")}]\n${text}`;
      if (alert) {
        text += `\n\nPAGE ALERT: "${alert}" — the page showed a dialog with this message. Read it and act on it before proceeding (e.g. fill a missing field, uncheck a checkbox).`;
      }
      return {
        content: [{ type: "text", text }],
      };
    }
  );
}
