import { fillInput } from "../fill.js";
import type { IncomingMessage } from "./frame-util.js";

export function opFillInput(msg: IncomingMessage): unknown {
  const result = fillInput(
    msg.textHint as string,
    msg.value as string,
    msg.nth as number | undefined,
    (msg.exact as boolean | undefined) ?? false
  );
  return { type: "fill_response", requestId: msg.requestId, ...result };
}

export function opSavePageState(msg: IncomingMessage): unknown {
  const state: Array<{ selector: string; type: string; value: string; checked?: boolean }> = [];
  // Track positional counters per tag for fallback selectors
  const tagCounts: Record<string, number> = {};
  for (const el of Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select"))) {
    const tag = el.tagName.toLowerCase();
    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    const isCheckable = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
    // Build selector: prefer id > name > positional nth-of-type fallback
    let selector: string;
    if (el.id) {
      selector = `#${CSS.escape(el.id)}`;
    } else if (el.name) {
      selector = isCheckable
        ? `[name="${el.name}"][value="${(el as HTMLInputElement).value}"]`
        : `[name="${el.name}"]`;
    } else {
      // Fallback: use tag + nth-of-type for elements with no id or name
      selector = `${tag}:nth-of-type(${tagCounts[tag]})`;
    }
    if (isCheckable) {
      state.push({ selector, type: (el as HTMLInputElement).type, value: (el as HTMLInputElement).value, checked: (el as HTMLInputElement).checked });
    } else {
      const value = (el as HTMLInputElement | HTMLTextAreaElement).value;
      if (value) state.push({ selector, type: el instanceof HTMLSelectElement ? "select" : el instanceof HTMLTextAreaElement ? "textarea" : (el.type || "text"), value });
    }
  }
  // CodeMirror editors (use index-based selector)
  document.querySelectorAll<HTMLElement>(".cm-editor").forEach((editor, i) => {
    const content = editor.querySelector(".cm-content")?.textContent ?? "";
    if (content.trim()) state.push({ selector: `.cm-editor:nth-of-type(${i + 1})`, type: "codemirror", value: content });
  });
  // Monaco editors — save via model value if available
  try {
    const monacoModels = (window as any).monaco?.editor?.getModels?.() as any[] | undefined;
    if (monacoModels) {
      monacoModels.forEach((model: any, i: number) => {
        const content = model.getValue?.() ?? "";
        if (content.trim()) state.push({ selector: `monaco-model-${i}`, type: "monaco", value: content });
      });
    }
  } catch { /* monaco not available */ }
  return { type: "save_state_response", requestId: msg.requestId, state };
}

export function opRestorePageState(msg: IncomingMessage): unknown {
  const stateItems = msg.state as Array<{ selector: string; type: string; value: string; checked?: boolean }>;
  let restored = 0;
  for (const item of stateItems) {
    if (item.type === "codemirror") {
      const match = item.selector.match(/:nth-of-type\((\d+)\)/);
      const n = match ? parseInt(match[1], 10) - 1 : 0;
      const editors = document.querySelectorAll<HTMLElement>(".cm-editor");
      const editor = editors[n];
      if (editor) {
        const cmContent = editor.querySelector<HTMLElement>(".cm-content");
        if (cmContent) {
          cmContent.focus();
          document.execCommand("selectAll");
          document.execCommand("insertText", false, item.value);
          restored++;
        }
      }
      continue;
    }
    if (item.type === "monaco") {
      try {
        const match = item.selector.match(/monaco-model-(\d+)/);
        const i = match ? parseInt(match[1], 10) : 0;
        const models = (window as any).monaco?.editor?.getModels?.();
        if (models?.[i]) { models[i].setValue(item.value); restored++; }
      } catch { /* monaco not available */ }
      continue;
    }
    try {
      const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(item.selector);
      if (!el) continue;
      if (item.type === "checkbox" || item.type === "radio") {
        (el as HTMLInputElement).checked = item.checked ?? false;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (el instanceof HTMLSelectElement) {
        el.value = item.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const nativeSetter = Object.getOwnPropertyDescriptor(
          el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          "value"
        )?.set;
        if (nativeSetter) nativeSetter.call(el, item.value);
        else (el as HTMLInputElement).value = item.value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      restored++;
    } catch { /* skip bad selectors */ }
  }
  return { type: "action_done", requestId: msg.requestId, message: `Restored ${restored} of ${stateItems.length} fields` };
}

export async function opFillForm(msg: IncomingMessage): Promise<unknown> {
  const formFields = msg.fields as Array<{ label: string; value: string }>;
  const exact = (msg.exact as boolean | undefined) ?? false;
  const results: Array<{ label: string; success: boolean; message: string; matched?: string }> = [];
  for (const field of formFields) {
    const result = fillInput(field.label, field.value, 1, exact);
    results.push({ label: field.label, success: result.success, message: result.message, matched: result.matched });
    // Brief pause between fills so React can process each change event
    await new Promise((r) => setTimeout(r, 80));
  }
  const succeeded = results.filter((r) => r.success).length;
  return { type: "fill_form_response", requestId: msg.requestId, results, succeeded, total: formFields.length };
}
