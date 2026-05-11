# Chromeflow plugin

For ANY task that touches a real browser — opening sites, checking if a page is up, reading content, filling forms, logging in, capturing API keys, OAuth, scraping, navigating dashboards — use the `mcp__plugin_chromeflow_chromeflow__*` tools and load the `chromeflow` skill for the usage patterns.

Do NOT fall back to Bash / `curl` / `osascript` / AppleScript / Playwright / Puppeteer for browser tasks. Chromeflow drives the user's real Chrome with their sessions intact; the fallbacks won't have their logins and will fail silently.
