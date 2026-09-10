// Message handlers extracted verbatim from background.ts's handleMcpMessage
// switch. Each function IS the original case body, unchanged.
import type { McpMsg } from "./types";
import { getActiveTab } from "../state";

export async function handleInteractiveSnapshot(msg: McpMsg, port: number): Promise<unknown> {
      // Compact, accessibility-style list of ACTIONABLE elements (role, name,
      // stable selector) — a token-cheap alternative to get_page_text when the
      // agent needs to act rather than read prose. Pierces open AND closed
      // shadow roots (chrome.dom), which a raw CDP a11y tree misses.
      const tab = await getActiveTab(port);
      const max = (msg.max as number | undefined) ?? 60;
      const r = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: (cap: number) => {
          function getShadowRoot(el: Element): ShadowRoot | null {
            const cd = (chrome as unknown as { dom?: { openOrClosedShadowRoot?: (e: Element) => ShadowRoot | null } }).dom;
            if (cd?.openOrClosedShadowRoot) { try { const sr = cd.openOrClosedShadowRoot(el); if (sr) return sr; } catch { /* */ } }
            return (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot ?? null;
          }
          const INTER_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio", "switch", "tab", "combobox", "textbox", "searchbox", "option", "slider"]);
          function interactive(el: Element): boolean {
            const tag = el.tagName.toLowerCase();
            if (tag === "a") return el.hasAttribute("href");
            if (["button", "input", "textarea", "select", "summary"].includes(tag)) return true;
            const role = el.getAttribute("role"); if (role && INTER_ROLES.has(role)) return true;
            if ((el as HTMLElement).isContentEditable) return true;
            if (el.hasAttribute("onclick")) return true;
            const ti = el.getAttribute("tabindex"); if (ti && ti !== "-1") return true;
            return false;
          }
          function visible(el: Element): boolean {
            const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false;
            const cs = getComputedStyle(el as HTMLElement);
            if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") return false;
            if (el.getAttribute("aria-hidden") === "true") return false;
            return true;
          }
          function nm(el: Element): string {
            const a = el.getAttribute("aria-label"); if (a) return a.trim().slice(0, 80);
            const p = el.getAttribute("placeholder"); if (p) return p.trim().slice(0, 80);
            if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { if (el.value) return ("value:" + el.value).slice(0, 80); }
            const t = (el.textContent || "").trim().replace(/\s+/g, " "); if (t) return t.slice(0, 80);
            const ti = el.getAttribute("title") || el.getAttribute("alt"); if (ti) return ti.trim().slice(0, 80);
            const n = el.getAttribute("name"); if (n) return "name=" + n;
            return "";
          }
          // Ids duplicated anywhere on the page (shadow-piercing) — a page
          // rendering two full copies of the same form at once (Workday's
          // Create Account step, see ISSUE-2026-09-10-workday-duplicate-id-
          // colliding-create-account-form.md) leaves colliding ids behind.
          // canonical() below must not hand out an ambiguous "#id" for one of
          // these, and the dedupe-by-key step further down would otherwise
          // silently collapse two genuinely different duplicate elements into
          // one row (same id -> same canonical() selector -> same key) with
          // no sign a duplicate ever existed.
          const idCounts = new Map<string, number>();
          {
            const idStack: ParentNode[] = [document];
            while (idStack.length) {
              const root = idStack.pop()!;
              for (const el of Array.from(root.querySelectorAll("[id]"))) {
                const id = el.getAttribute("id"); if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
                const sr = getShadowRoot(el); if (sr) idStack.push(sr);
              }
            }
          }
          const duplicatedIds = new Set([...idCounts.entries()].filter(([, c]) => c > 1).map(([id]) => id));
          function canonical(el: Element): string {
            const tag = el.tagName.toLowerCase();
            const hashed = (s: string) => s.length > 12 && /\d/.test(s) && /[a-z]/i.test(s) && !/[\s_-]/.test(s);
            const id = el.getAttribute("id"); if (id && !hashed(id) && !duplicatedIds.has(id)) { try { return "#" + CSS.escape(id); } catch { return "#" + id; } }
            const n = el.getAttribute("name"); if (n) return `${tag}[name="${n}"]`;
            const a = el.getAttribute("aria-label"); if (a) return `${tag}[aria-label="${a.replace(/"/g, '\\"').slice(0, 40)}"]`;
            const p = el.getAttribute("placeholder"); if (p) return `${tag}[placeholder="${p.replace(/"/g, '\\"').slice(0, 40)}"]`;
            const tid = el.getAttribute("data-testid"); if (tid) return `[data-testid="${tid}"]`;
            return tag;
          }
          // Split into CONTROLS (buttons, inputs, search boxes, menu items — the
          // things you usually act on) vs plain navigation LINKS. Controls are
          // kept in full; links are capped, so a content/article page (mostly
          // links) yields a small focused snapshot instead of a giant link dump.
          const controls: Array<{ role: string; name: string; selector: string; duplicate_id?: boolean }> = [];
          const links: Array<{ role: string; name: string; selector: string; duplicate_id?: boolean }> = [];
          const LINK_CAP = 15;
          const seen = new Set<string>();
          let walked = 0;
          let duplicateIdHits = 0;
          const stack: ParentNode[] = [document];
          while (stack.length && walked < 12000 && (controls.length < cap || links.length < LINK_CAP)) {
            const root = stack.pop()!;
            for (const el of Array.from(root.querySelectorAll("*"))) {
              walked++;
              const sr = getShadowRoot(el); if (sr) stack.push(sr);
              if (controls.length >= cap && links.length >= LINK_CAP) break;
              if (!interactive(el) || !visible(el)) continue;
              const role = el.getAttribute("role") || el.tagName.toLowerCase();
              const name = nm(el); const selector = canonical(el);
              const rawId = el.getAttribute("id");
              const isDupeId = !!rawId && duplicatedIds.has(rawId);
              // Two elements sharing a duplicated id often ALSO share the same
              // role/name (two copies of the same form), which would otherwise
              // collapse into one seen-key and hide the second copy entirely —
              // fold in the element's own document position to keep them
              // distinct rows instead of silently dropping one.
              const key = isDupeId
                ? role + "|" + name + "|" + selector + "|" + Math.round(el.getBoundingClientRect().top + (window.scrollY || 0))
                : role + "|" + name + "|" + selector;
              if (seen.has(key)) continue; seen.add(key);
              if (isDupeId) duplicateIdHits++;
              const isLink = (el.tagName.toLowerCase() === "a" && el.hasAttribute("href")) || el.getAttribute("role") === "link";
              const item = { role, name, selector, ...(isDupeId ? { duplicate_id: true } : {}) };
              if (isLink) { if (links.length < LINK_CAP) links.push(item); }
              else if (controls.length < cap) { controls.push(item); }
            }
          }
          // Controls first (prioritized), then a capped tail of links, overall cap.
          return { items: [...controls, ...links].slice(0, cap), duplicateIdCount: duplicateIdHits };
        },
        args: [max],
      });
      const out = r[0]?.result as { items: unknown[]; duplicateIdCount: number } | undefined;
      const items = out?.items ?? [];
      const duplicateIdCount = out?.duplicateIdCount ?? 0;
      const warning = duplicateIdCount > 0
        ? `\n\n⚠ ${duplicateIdCount} item(s) above have an id that's DUPLICATED elsewhere on the page (duplicate_id:true) — this usually means the page rendered more than one copy of the same form/section at once (see ISSUE-2026-09-10-workday-duplicate-id-colliding-create-account-form.md). Their selector already avoids the ambiguous #id form, but treat this page as unreliable for id-based targeting generally: verify which copy a click/fill actually landed in before trusting it.`
        : "";
      return { type: "interactive_snapshot_response", requestId: msg.requestId, items, warning };
}
