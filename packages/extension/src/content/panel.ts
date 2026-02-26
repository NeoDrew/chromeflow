const PANEL_ID = "__chromeflow_panel__";
const STEP_ATTR = "data-chromeflow-step";

export function clearPanel() {
  document.getElementById(PANEL_ID)?.remove();
}

export function markStepDone(stepIndex: number) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel) return;
  const row = panel.querySelector<HTMLDivElement>(`[${STEP_ATTR}="${stepIndex}"]`);
  if (!row) return;

  row.style.opacity = "0.45";
  const num = row.querySelector<HTMLDivElement>("[data-chromeflow-num]");
  if (num) {
    num.style.background = "#22c55e";
    num.textContent = "✓";
  }

  // If all steps are now done, show a completion state then fade out
  const allRows = panel.querySelectorAll(`[${STEP_ATTR}]`);
  const allDone = Array.from(allRows).every(
    (r) => r.querySelector("[data-chromeflow-num]")?.textContent === "✓"
  );
  if (allDone) {
    setTimeout(() => showCompletion(panel), 300);
  }
}

function showCompletion(panel: HTMLElement) {
  panel.innerHTML = "";
  panel.style.cssText += "transition: opacity 0.4s; opacity: 1;";

  const inner = document.createElement("div");
  inner.style.cssText = `
    padding: 20px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    text-align: center;
  `;

  const check = document.createElement("div");
  check.style.cssText = `
    width: 40px; height: 40px; border-radius: 50%;
    background: #22c55e; color: #fff;
    font-size: 20px; display: flex;
    align-items: center; justify-content: center;
  `;
  check.textContent = "✓";

  const label = document.createElement("div");
  label.style.cssText = `font-size: 13px; font-weight: 600; color: #e8e8e8;`;
  label.textContent = "All done!";

  inner.appendChild(check);
  inner.appendChild(label);
  panel.appendChild(inner);

  // Fade out and remove after 2.5s
  setTimeout(() => {
    panel.style.opacity = "0";
    setTimeout(() => panel.remove(), 400);
  }, 2500);
}

export function showGuidePanel(
  title: string,
  steps: Array<{ text: string; done?: boolean }>
) {
  clearPanel();

  const panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    width: 300px;
    background: #0f0f0f;
    border: 1px solid #2a2a2a;
    border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6);
    z-index: 2147483646;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    overflow: hidden;
    animation: chromeflow-slidein 0.25s ease;
  `;

  // Inject panel animations once
  if (!document.getElementById("__chromeflow_panel_styles__")) {
    const style = document.createElement("style");
    style.id = "__chromeflow_panel_styles__";
    style.textContent = `
      @keyframes chromeflow-slidein {
        from { opacity: 0; transform: translateY(12px); }
        to { opacity: 1; transform: translateY(0); }
      }
    `;
    document.head.appendChild(style);
  }

  // Header
  const header = document.createElement("div");
  header.style.cssText = `
    background: linear-gradient(135deg, #7c3aed, #2563eb);
    padding: 12px 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  `;
  const titleEl = document.createElement("span");
  titleEl.style.cssText = `
    color: #fff;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.2px;
  `;
  titleEl.textContent = `⚡ ${title}`;

  const closeBtn = document.createElement("button");
  closeBtn.style.cssText = `
    background: none;
    border: none;
    color: rgba(255,255,255,0.7);
    font-size: 16px;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  `;
  closeBtn.textContent = "×";
  closeBtn.onclick = () => panel.remove();

  header.appendChild(titleEl);
  header.appendChild(closeBtn);

  // Steps list
  const list = document.createElement("div");
  list.style.cssText = `padding: 10px 0;`;

  steps.forEach((step, i) => {
    const row = document.createElement("div");
    row.setAttribute(STEP_ATTR, String(i));
    row.style.cssText = `
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 8px 14px;
      ${step.done ? "opacity: 0.45;" : ""}
    `;

    const num = document.createElement("div");
    num.setAttribute("data-chromeflow-num", "1");
    num.style.cssText = `
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: ${step.done ? "#22c55e" : "#7c3aed"};
      color: #fff;
      font-size: 11px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      margin-top: 1px;
    `;
    num.textContent = step.done ? "✓" : String(i + 1);

    const text = document.createElement("div");
    text.style.cssText = `
      font-size: 13px;
      color: #e8e8e8;
      line-height: 1.45;
    `;
    text.textContent = step.text;

    row.appendChild(num);
    row.appendChild(text);
    list.appendChild(row);
  });

  panel.appendChild(header);
  panel.appendChild(list);
  document.documentElement.appendChild(panel);
}
