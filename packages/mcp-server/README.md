# chromeflow — MCP server

The standalone npm package for the [Chromeflow](https://chromeflow.run) MCP server. Lets Claude Code, Codex CLI, or any MCP-compatible agent drive your real Chrome browser with sessions intact — clicks, fills forms, captures API keys to `.env`, downloads authenticated files.

## Recommended install — the plugin

For **Claude Code**:

```
/plugin marketplace add https://gitlab.com/NeoDrew/chromeflow.git
/plugin install chromeflow
```

For **Codex CLI**:

```
codex plugin marketplace add https://gitlab.com/NeoDrew/chromeflow.git
/plugins
```

The plugin bundles the MCP server, the usage skill, permission allowlists, and the SessionStart hook in a single install. No npm dependency, no per-project setup.

## Manual install — this package

For environments where the plugin isn't an option (custom MCP clients, hand-crafted `.mcp.json`, CI test harnesses), install this npm package and wire it manually.

```bash
npm install -g chromeflow
# or run on demand
npx -y chromeflow
```

Then add to your MCP-client config (`.mcp.json`, `mcp.config`, or wherever your agent looks):

```json
{
  "mcpServers": {
    "chromeflow": {
      "command": "npx",
      "args": ["-y", "chromeflow"]
    }
  }
}
```

You still need the [Chromeflow Chrome extension](https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime) installed — it's the part that actually drives Chrome. The MCP server is a stdio↔WebSocket bridge between your agent and the extension.

## What's in this package

A single bundled file: `bin/chromeflow.mjs` (~890 KB ESM), built from `packages/mcp-server/src/` via esbuild. Reading source? See the [GitLab repository](https://gitlab.com/NeoDrew/chromeflow).

## Tools exposed (v0.9.5)

28 MCP tools across navigation, reading, interaction, waiting, privileged network, highlight + handoff, and utility. The full catalogue lives in [CLAUDE.md](https://gitlab.com/NeoDrew/chromeflow/-/blob/main/CLAUDE.md) — read that before writing an agent that calls these tools.

## Links

- **Website**: https://chromeflow.run
- **Compare to Playwright / Browser Use / Puppeteer**: https://chromeflow.run/compare
- **Use cases** (Stripe, Canvas, OAuth, API keys): https://chromeflow.run/use-cases
- **FAQ**: https://chromeflow.run/faq
- **GitLab**: https://gitlab.com/NeoDrew/chromeflow
- **Chrome Web Store**: https://chromewebstore.google.com/detail/chromeflow/lkdchdgkbkodliefobkkhiegjdiidime
- **MCP Registry**: `io.gitlab.NeoDrew/chromeflow`

## License

MIT — see [LICENSE](https://gitlab.com/NeoDrew/chromeflow/-/blob/main/LICENSE).
