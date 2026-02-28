/**
 * Find a form input by its label/placeholder/aria-label and set its value,
 * dispatching the synthetic events React/Vue/Svelte apps need to pick up the change.
 * Also handles contenteditable elements used by dashboards like Stripe.
 */
export function fillInput(
  textHint: string,
  value: string
): { success: boolean; message: string } {
  const lower = textHint.toLowerCase().trim();

  // Try contenteditable elements first (used by Stripe, Notion, etc.)
  const editable = findContentEditable(lower);
  if (editable) {
    editable.focus();
    // Select all existing content and replace
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editable);
    selection?.removeAllRanges();
    selection?.addRange(range);
    // insertText is the most React-compatible way to set value in contenteditable
    document.execCommand("insertText", false, value);
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    editable.dispatchEvent(new Event("change", { bubbles: true }));
    editable.scrollIntoView({ behavior: "smooth", block: "center" });
    return { success: true, message: `Filled "${textHint}" with value` };
  }

  const input = findInput(lower);
  if (!input) {
    // Last resort: the user may have just clicked/focused the target field via
    // wait_for_click — try to fill whatever is currently focused.
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      if (active.isContentEditable) {
        active.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(active);
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.execCommand("insertText", false, value);
        active.dispatchEvent(new Event("input", { bubbles: true }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
        return { success: true, message: `Filled "${textHint}" with value` };
      }
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        if (isEditable(active)) {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            active instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
            "value"
          )?.set;
          if (nativeSetter) nativeSetter.call(active, value);
          else active.value = value;
          active.dispatchEvent(new Event("input", { bubbles: true }));
          active.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true, message: `Filled "${textHint}" with value` };
        }
      }
    }
    return { success: false, message: `No input found for "${textHint}"` };
  }

  // Focus the element first (triggers any focus handlers)
  input.focus();

  if (input instanceof HTMLSelectElement) {
    // For <select>, find matching option
    const option = Array.from(input.options).find(
      (o) =>
        o.text.toLowerCase().includes(lower) ||
        o.value.toLowerCase().includes(lower)
    );
    if (option) {
      input.value = option.value;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return { success: true, message: `Selected "${option?.text ?? value}"` };
  }

  // For React-controlled inputs, bypass the synthetic event system by using
  // the native setter so React's onChange fires correctly.
  const nativeSetter = Object.getOwnPropertyDescriptor(
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype,
    "value"
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    (input as HTMLInputElement).value = value;
  }

  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

  // Scroll into view and briefly highlight it
  input.scrollIntoView({ behavior: "smooth", block: "center" });

  return { success: true, message: `Filled "${textHint}" with value` };
}

type FillableInput = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

function findInput(lower: string): FillableInput | null {
  // 1. <label> whose text matches → use htmlFor to find input
  for (const label of Array.from(document.querySelectorAll<HTMLLabelElement>("label"))) {
    if (label.textContent?.toLowerCase().includes(lower)) {
      const target = label.htmlFor
        ? document.getElementById(label.htmlFor)
        : label.querySelector<FillableInput>("input, textarea, select");
      if (target && isEditable(target)) return target as FillableInput;
    }
  }

  // 2. Input with placeholder matching
  for (const el of Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
      "input[placeholder], textarea[placeholder]"
    )
  )) {
    if (el.placeholder.toLowerCase().includes(lower) && isEditable(el)) return el;
  }

  // 3. Input with aria-label matching
  for (const el of Array.from(
    document.querySelectorAll<FillableInput>("input[aria-label], textarea[aria-label], select[aria-label]")
  )) {
    const ariaLabel = el.getAttribute("aria-label") ?? "";
    if (ariaLabel.toLowerCase().includes(lower) && isEditable(el)) return el;
  }

  // 4. Any text node near an input that contains the hint
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent?.toLowerCase().includes(lower)) return NodeFilter.FILTER_REJECT;
      const p = node.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const style = getComputedStyle(p);
      if (style.display === "none" || style.visibility === "hidden") return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNode = walker.nextNode();
  if (textNode) {
    const anchor = (textNode as Text).parentElement!;
    // Walk up to 6 ancestor levels looking for an input — also check next sibling at each
    // level (handles layouts where label and input are in separate sibling divs, e.g. Stripe).
    let node: Element | null = anchor;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      const input = node.querySelector<FillableInput>("input, textarea, select");
      if (input && isEditable(input)) return input;
      const sibling = node.nextElementSibling;
      if (sibling) {
        const sibInput = sibling.querySelector<FillableInput>("input, textarea, select");
        if (sibInput && isEditable(sibInput)) return sibInput;
      }
      node = node.parentElement;
    }
  }

  // 5. Input/textarea whose name or id attribute matches the hint (e.g. <input name="name">)
  for (const el of Array.from(document.querySelectorAll<FillableInput>("input, textarea"))) {
    const name = (el as HTMLInputElement).name?.toLowerCase() ?? "";
    if (name === lower && isEditable(el)) return el;
  }
  for (const el of Array.from(document.querySelectorAll<FillableInput>("input, textarea"))) {
    if (el.id.toLowerCase() === lower && isEditable(el)) return el;
  }

  return null;
}

function findContentEditable(lower: string): HTMLElement | null {
  for (const el of Array.from(
    document.querySelectorAll<HTMLElement>('[contenteditable]:not([contenteditable="false"])')
  )) {
    const ariaLabel = (el.getAttribute("aria-label") ?? "").toLowerCase();
    const dataPlaceholder = (
      el.getAttribute("data-placeholder") ??
      el.getAttribute("placeholder") ??
      ""
    ).toLowerCase();
    if (ariaLabel.includes(lower) || dataPlaceholder.includes(lower)) return el;

    // Check for a <label> or nearby text node that matches
    const id = el.id;
    if (id) {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${id}"]`);
      if (label?.textContent?.toLowerCase().includes(lower)) return el;
    }
    const container = el.closest("div, li, tr, fieldset, form") ?? el.parentElement;
    if (container) {
      const text = container.textContent?.toLowerCase() ?? "";
      // Only match if the hint appears as a label near this element (not as its own content)
      const ownText = el.textContent?.toLowerCase() ?? "";
      if (text.includes(lower) && !ownText.includes(lower)) return el;
    }
  }
  return null;
}

function isEditable(el: Element): boolean {
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) return false;
  if ((el as HTMLInputElement).disabled || (el as HTMLInputElement).readOnly) return false;
  const type = (el as HTMLInputElement).type?.toLowerCase();
  const nonFillable = ["checkbox", "radio", "submit", "button", "reset", "file", "hidden"];
  if (nonFillable.includes(type)) return false;
  return true;
}
