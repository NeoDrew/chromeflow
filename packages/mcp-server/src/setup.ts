import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const HOME = homedir();
const CLAUDE_JSON_PATH = join(HOME, ".claude.json");

function getClaudeMdContent(): string {
  // Resolve relative to this file: dist/index.js → ../CLAUDE.md
  const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
  const claudeMdPath = join(packageDir, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    return readFileSync(claudeMdPath, "utf8");
  }
  // Fallback for local dev: look two levels up (packages/mcp-server/CLAUDE.md)
  const devPath = join(dirname(fileURLToPath(import.meta.url)), "..", "CLAUDE.md");
  if (existsSync(devPath)) {
    return readFileSync(devPath, "utf8");
  }
  throw new Error("CLAUDE.md not found in package. Run `npm run build` first.");
}

// Placeholder kept for the old hardcoded string — now unused
const PROJECT_CLAUDE_MD = `# Chromeflow — Claude Instructions

## What chromeflow is
Chromeflow is a browser guidance tool. When a task requires the user to interact with a
website (create accounts, set up billing, retrieve API keys, configure third-party services),
use chromeflow to guide them through it visually instead of giving text instructions.

## When to use chromeflow (be proactive)
Use chromeflow automatically whenever a task requires:
- Creating or configuring a third-party account (Stripe, SendGrid, Supabase, Vercel, etc.)
- Retrieving API keys, secrets, or credentials to place in \`.env\`
- Setting up pricing tiers, webhooks, or service configuration in a web UI
- Any browser-based step that is blocking code work

Do NOT ask "should I open the browser?" — just do it. The user expects seamless handoff.

## HARD RULES — never break these

1. **Never use Bash as a fallback for browser tasks.** If \`click_element\` fails, use
   \`scroll_page\` then retry, or use \`highlight_region\` to show the user. Never use
   \`osascript\`, \`applescript\`, or any shell command to control the browser.

2. **Take a screenshot only when you need to decide what to do next.** Do not take
   a screenshot after every action as a reflex. Take one after navigation, or when
   \`click_element\`/\`find_and_highlight\` fails and you need to locate something visually.

3. **\`open_page\` already waits for navigation.** Never call \`wait_for_navigation\`
   immediately after \`open_page\` — it will time out.

4. **When \`click_element\` fails:** first try \`scroll_page(down)\` then retry
   \`click_element\`. If it still fails, \`take_screenshot\` and use \`highlight_region\`
   with pixel coordinates from the image.

## Guided flow pattern

\`\`\`
1. show_guide_panel(title, steps[])          — show the full plan upfront
2. open_page(url)                            — navigate to the right page
3. For each step:
   a. [if needed] take_screenshot()          — only when you need to locate something
   b. Claude acts directly:
        click_element("Save")               — press buttons/links Claude can press
        fill_input("Product name", "Pro")   — fill fields Claude knows the answer to
        scroll_page("down")                 — reveal off-screen content then retry
      Or pause for the user:
        find_and_highlight(text, msg)        — show the user what to do
        wait_for_click()                    — wait for user interaction
   c. mark_step_done(i)                      — check off the step
4. clear_overlays()                          — clean up when done
\`\`\`

**Default to automation.** Only pause for human input when the step genuinely requires
personal data or a human decision.

## What to do automatically vs pause for the user

**Claude acts directly** (\`click_element\` / \`fill_input\`):
- Any button: Save, Continue, Create, Add, Confirm, Next, Submit, Update
- Product names, descriptions, feature lists
- Prices and amounts specified in the task
- URLs, redirect URIs, webhook endpoints
- Selecting billing period, currency, or other known options
- Dismissing cookie banners, cookie dialogs, "not now" prompts

**Pause for the user** (\`find_and_highlight\` + \`wait_for_click\`):
- Email address / username / login
- Password or passphrase
- Payment method / billing / card details
- Phone number / 2FA / OTP codes
- Any legal consent the user must personally accept
- Choices that depend on user preference Claude wasn't told

## Capturing credentials
After a secret key or API key is revealed:
1. \`read_element(hint)\` — capture the value
2. \`write_to_env(KEY_NAME, value, envPath)\` — write to \`.env\`
3. Tell the user what was written

Use the absolute path for \`envPath\` — it's the Claude Code working directory + \`/.env\`.

## Error handling
- \`click_element\` not found → \`scroll_page("down")\` then retry
- Still not found → \`take_screenshot()\` then \`highlight_region(x,y,w,h,msg)\`
- Page still loading → \`take_screenshot()\` to confirm, proceed when content is visible
- Never use Bash to work around a stuck browser interaction
`;

function isRunningViaNpx(): boolean {
  // When run via `npx chromeflow`, npm sets npm_lifecycle_script or the path contains _npx
  return (
    process.env.npm_execpath?.includes("npx") === true ||
    process.argv[1]?.includes("_npx") === true ||
    process.env.npm_config_user_agent?.includes("npm") === true
  );
}

function patchClaudeJson(serverScriptPath: string) {
  let config: Record<string, unknown> = {};

  if (existsSync(CLAUDE_JSON_PATH)) {
    try {
      config = JSON.parse(readFileSync(CLAUDE_JSON_PATH, "utf8"));
    } catch {
      config = {};
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }

  // When installed from npm (run via npx), register with npx so updates are automatic.
  // When run from a local build (dev), use the absolute node path.
  const entry = isRunningViaNpx()
    ? { command: "npx", args: ["-y", "chromeflow"] }
    : { command: "node", args: [serverScriptPath] };

  (config.mcpServers as Record<string, unknown>).chromeflow = entry;

  writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2) + "\n");
}

function patchProjectClaudeMd(cwd: string, force = false) {
  const claudeMdPath = join(cwd, "CLAUDE.md");
  const content = getClaudeMdContent();

  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf8");
    if (existing.includes("chromeflow")) {
      if (!force) return "already-present";
      // Replace the existing chromeflow section with the fresh content
      const before = existing.slice(0, existing.indexOf("# Chromeflow")).trimEnd();
      writeFileSync(claudeMdPath, (before ? before + "\n\n" : "") + content);
      return "updated";
    }
    writeFileSync(claudeMdPath, existing.trimEnd() + "\n\n" + content);
    return "appended";
  }

  writeFileSync(claudeMdPath, content);
  return "created";
}

const CHROMEFLOW_TOOLS = [
  "open_page", "take_screenshot", "clear_overlays", "get_elements", "execute_script",
  "fill_input", "read_element", "get_page_text", "write_to_env",
  "scroll_page", "click_element", "wait_for_click", "wait_for_selector", "mark_step_done",
  "find_and_highlight", "highlight_region", "show_guide_panel",
  // v0.1.23+
  "switch_to_tab", "list_tabs", "get_form_fields", "scroll_to_element",
  "save_page_state", "restore_page_state",
  // v0.1.25+
  "take_and_copy_screenshot",
  // v0.1.32+
  "fill_form",
  // v0.1.36+
  "set_file_input",
  // v0.1.39+
  "get_console_logs",
  // v0.1.40+
  "capture_terminal",
  // v0.1.42+
  "set_dialog_response",
].map((t) => `mcp__chromeflow__${t}`);

function patchSettingsLocalJson(cwd: string) {
  const claudeDir = join(cwd, ".claude");
  const settingsPath = join(claudeDir, "settings.local.json");

  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch {
      settings = {};
    }
  }

  if (!settings.permissions || typeof settings.permissions !== "object") {
    settings.permissions = {};
  }
  const perms = settings.permissions as Record<string, unknown>;
  const existing: string[] = Array.isArray(perms.allow) ? perms.allow as string[] : [];

  // Remove stale chromeflow entries, add current ones
  const withoutChromeflow = existing.filter((t) => !t.startsWith("mcp__chromeflow__"));
  const merged = [...withoutChromeflow, ...CHROMEFLOW_TOOLS];

  const changed =
    merged.length !== existing.length ||
    CHROMEFLOW_TOOLS.some((t) => !existing.includes(t));
  if (!changed) return "already-present";

  perms.allow = merged;
  if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  return "updated";
}

const STORE_URL = "https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime";

function tryOpenStorePage() {
  try {
    execSync(`open "${STORE_URL}"`, { stdio: "ignore" });
    return true;
  } catch {
    try {
      execSync(`xdg-open "${STORE_URL}"`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

function patchGlobalClaudeMd() {
  const globalClaudeMdPath = join(HOME, ".claude", "CLAUDE.md");
  const hint = `## Chromeflow

chromeflow is installed globally as an MCP server.

If you are working in a project and the project's CLAUDE.md does not contain chromeflow
instructions, tell the user: "Run \`npx chromeflow setup\` in this project directory to
configure chromeflow for it."
`;

  if (existsSync(globalClaudeMdPath)) {
    const existing = readFileSync(globalClaudeMdPath, "utf8");
    if (existing.includes("chromeflow")) return "already-present";
    writeFileSync(globalClaudeMdPath, existing.trimEnd() + "\n\n" + hint);
    return "appended";
  }

  const dir = join(HOME, ".claude");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(globalClaudeMdPath, hint);
  return "created";
}

export async function runSetup() {
  const scriptPath = fileURLToPath(import.meta.url);
  const distDir = dirname(scriptPath);
  const serverScriptPath = resolve(distDir, "index.js");

  console.log("\nChromeflow Setup\n" + "─".repeat(40));

  // 1. MCP server registration
  patchClaudeJson(serverScriptPath);
  const viaNpx = isRunningViaNpx();
  console.log(`✓ Registered MCP server in ~/.claude.json`);
  console.log(viaNpx ? `  → npx -y chromeflow (auto-updates)` : `  → node ${serverScriptPath}`);

  // 2. Project CLAUDE.md + settings.local.json
  const cwd = process.cwd();
  const mdResult = patchProjectClaudeMd(cwd);
  const settingsResult = patchSettingsLocalJson(cwd);
  if (mdResult === "already-present") {
    console.log("✓ CLAUDE.md already has chromeflow instructions (run `npx chromeflow update` to refresh)");
  } else if (mdResult === "appended") {
    console.log(`✓ Appended chromeflow instructions to ${join(cwd, "CLAUDE.md")}`);
  } else {
    console.log(`✓ Created ${join(cwd, "CLAUDE.md")}`);
  }

  if (settingsResult === "already-present") {
    console.log("✓ .claude/settings.local.json already allows chromeflow tools");
  } else {
    console.log("✓ Added chromeflow tools to .claude/settings.local.json (no approval prompts)");
  }

  // 3. Chrome extension
  console.log("\nChrome extension (one-time step):");
  const opened = tryOpenStorePage();
  if (opened) {
    console.log("  Opened Chrome Web Store — click 'Add to Chrome' to install.");
  } else {
    console.log(`  Install from the Chrome Web Store:\n  ${STORE_URL}`);
  }

  // 4. Global ~/.claude/CLAUDE.md hint
  const globalResult = patchGlobalClaudeMd();
  if (globalResult === "already-present") {
    console.log("✓ ~/.claude/CLAUDE.md already has chromeflow hint");
  } else if (globalResult === "appended") {
    console.log("✓ Appended chromeflow hint to ~/.claude/CLAUDE.md");
  } else {
    console.log("✓ Created ~/.claude/CLAUDE.md with chromeflow hint");
  }

  console.log("\nDone. Restart Claude Code to activate chromeflow.\n");
}

export async function runUninstall() {
  const cwd = process.cwd();
  console.log("\nChromeflow Uninstall\n" + "─".repeat(40));

  // 1. Remove from ~/.claude.json
  if (existsSync(CLAUDE_JSON_PATH)) {
    try {
      const config = JSON.parse(readFileSync(CLAUDE_JSON_PATH, "utf8")) as Record<string, unknown>;
      if (config.mcpServers && typeof config.mcpServers === "object") {
        delete (config.mcpServers as Record<string, unknown>).chromeflow;
      }
      writeFileSync(CLAUDE_JSON_PATH, JSON.stringify(config, null, 2) + "\n");
      console.log("✓ Removed chromeflow MCP server from ~/.claude.json");
    } catch {
      console.log("  Could not update ~/.claude.json (skipping)");
    }
  }

  // 2. Remove chromeflow section from project CLAUDE.md
  const claudeMdPath = join(cwd, "CLAUDE.md");
  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf8");
    if (existing.includes("# Chromeflow")) {
      const idx = existing.indexOf("# Chromeflow");
      const before = existing.slice(0, idx).trimEnd();
      writeFileSync(claudeMdPath, before ? before + "\n" : "");
      console.log(`✓ Removed chromeflow section from ${claudeMdPath}`);
    }
  }

  // 3. Remove chromeflow tools from .claude/settings.local.json
  const settingsPath = join(cwd, ".claude", "settings.local.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      const perms = settings.permissions as Record<string, unknown> | undefined;
      if (perms && Array.isArray(perms.allow)) {
        perms.allow = (perms.allow as string[]).filter((t) => !t.startsWith("mcp__chromeflow__"));
      }
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log("✓ Removed chromeflow tools from .claude/settings.local.json");
    } catch {
      console.log("  Could not update .claude/settings.local.json (skipping)");
    }
  }

  // 4. Remove chromeflow hint from ~/.claude/CLAUDE.md
  const globalClaudeMdPath = join(HOME, ".claude", "CLAUDE.md");
  if (existsSync(globalClaudeMdPath)) {
    const existing = readFileSync(globalClaudeMdPath, "utf8");
    if (existing.includes("## Chromeflow")) {
      const idx = existing.indexOf("## Chromeflow");
      const before = existing.slice(0, idx).trimEnd();
      writeFileSync(globalClaudeMdPath, before ? before + "\n" : "");
      console.log("✓ Removed chromeflow hint from ~/.claude/CLAUDE.md");
    }
  }

  console.log("\nDone. Restart Claude Code to complete removal.\n");
}

/**
 * Fetch the latest CLAUDE.md directly from the npm registry (via unpkg CDN).
 * Falls back to the bundled copy if the network is unavailable.
 */
async function fetchLatestClaudeMd(): Promise<string> {
  try {
    const res = await fetch("https://unpkg.com/chromeflow@latest/CLAUDE.md");
    if (res.ok) return await res.text();
  } catch {
    // Network unavailable — fall through to bundled copy
  }
  return getClaudeMdContent();
}

export async function runUpdate() {
  const cwd = process.cwd();
  console.log("\nChromeflow Update\n" + "─".repeat(40));

  // Fetch fresh CLAUDE.md from the registry so we're never serving a stale cached copy.
  const freshContent = await fetchLatestClaudeMd();
  const claudeMdPath = join(cwd, "CLAUDE.md");

  let mdResult: string;
  if (existsSync(claudeMdPath)) {
    const existing = readFileSync(claudeMdPath, "utf8");
    if (existing.includes("# Chromeflow")) {
      const before = existing.slice(0, existing.indexOf("# Chromeflow")).trimEnd();
      writeFileSync(claudeMdPath, (before ? before + "\n\n" : "") + freshContent);
      mdResult = "updated";
    } else {
      writeFileSync(claudeMdPath, existing.trimEnd() + "\n\n" + freshContent);
      mdResult = "appended";
    }
  } else {
    writeFileSync(claudeMdPath, freshContent);
    mdResult = "created";
  }

  if (mdResult === "updated") {
    console.log(`✓ Updated chromeflow instructions in ${claudeMdPath}`);
  } else if (mdResult === "appended") {
    console.log(`✓ Appended chromeflow instructions to ${claudeMdPath}`);
  } else {
    console.log(`✓ Created ${claudeMdPath}`);
  }

  const settingsResult = patchSettingsLocalJson(cwd);
  if (settingsResult === "already-present") {
    console.log("✓ .claude/settings.local.json already up to date");
  } else {
    console.log("✓ Updated chromeflow tools in .claude/settings.local.json");
  }

  console.log("Done.\n");
}
