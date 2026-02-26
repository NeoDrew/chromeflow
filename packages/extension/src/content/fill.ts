/**
 * Find a form input by its label/placeholder/aria-label and set its value,
 * dispatching the synthetic events React/Vue/Svelte apps need to pick up the change.
 */
export function fillInput(
  textHint: string,
  value: string
): { success: boolean; message: string } {
  const lower = textHint.toLowerCase().trim();

  const input = findInput(lower);
  if (!input) {
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
    // Look for nearest input sibling/cousin
    const container = anchor.closest("div, li, tr, fieldset, form") ?? anchor.parentElement;
    if (container) {
      const nearby = container.querySelector<FillableInput>("input, textarea, select");
      if (nearby && isEditable(nearby)) return nearby;
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
