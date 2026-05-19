# Security Policy

## Reporting a vulnerability

Email security reports to **AndrewMaxwellRobertson@gmail.com** with the subject `chromeflow security`. Please include:

- A description of the vulnerability and its impact
- Reproduction steps (URL, tool call sequence, or extension interaction)
- Your affected chromeflow version (run `chromeflow --version` or check the plugin manifest)
- Whether you're willing to be credited in the fix announcement

I'll acknowledge within 72 hours and aim to ship a fix within 14 days for confirmed high-severity issues. Please do **not** open a public GitHub issue for security reports.

## Scope

In scope:

- The MCP server (`packages/mcp-server`) — credential leaks, command injection, privilege escalation, RCE via crafted page content
- The Chrome extension (`packages/extension`) — permission misuse, message-passing vulnerabilities, cookie/session token leaks
- The plugin packaging (`packages/plugin`) — supply-chain issues, install-time arbitrary code execution

Out of scope:

- Issues that require the user to install a malicious plugin manually
- Bugs that only affect users running unsupported Chrome versions
- Self-XSS that requires the user to paste attacker-controlled code into devtools
- Denial-of-service via making chromeflow drive a heavy page

## Past advisories

- **2026-05-12 (v0.9.4)**: `inspect_request_headers` previously returned the raw `cookie:` header — including `user_session` and other bearer tokens — to the agent context. Fixed by redacting cookie values by default. ([release](https://github.com/NeoDrewX/chromeflow/releases))

## Acknowledgements

Researchers who report a valid issue will be credited in the fix's commit message and in this file unless they request otherwise.
