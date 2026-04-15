
## Chromeflow issues from Outlier session (Apr 15, 2026)

### Outlier /dashboard and /en/expert/tasks serve "Switch Devices" mobile SSR
Observed: after navigating to https://app.outlier.ai/dashboard (where the
"Continue Tasking" button sends the user) the returned HTML contains only the
mobile-notice block ("This page's mobile view is currently under construction").
The body HTML length is ~70KB so there's markup being sent, but the
`.large-device-only` wrapper is empty (`textContent.length == 0`). The
server-rendered mobile notice is the only visible content.

Client reports normal desktop:
- window.outerWidth/innerWidth: 1470
- matchMedia('(min-width: 769px)').matches == true
- User-Agent: standard Chrome/Mac desktop string

So the mobile page is being chosen server-side, not by client responsive CSS.
Possible inputs the server is using:
- User-Agent Client Hints (Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform)
- TLS fingerprint / JA3
- A cookie set by a prior request that flagged the session
- Anti-automation heuristics keyed on the CDP/debugger attach signature

Behaviour notes:
- /en/expert (the home/landing page) renders fine with full content
- /marketplace renders fine
- Continue Tasking button on /en/expert navigates to /dashboard via a React
  onClick handler; /dashboard returns the mobile block
- /en/expert/tasks worked once at the very start of the session (Aether
  timesheet loaded, timer started, stop timer worked), then subsequently started
  returning the mobile block too. It did not recover across tab close/reopen,
  hard reload, or cache-bust query params.
- The "Switch Devices" overlay cannot be removed locally to reveal content
  underneath, because the desktop content was never rendered in the SSR response
  to begin with.

Impact: chromeflow can drive Outlier's static pages but cannot reliably reach
the actual tasking UI once the server flips the session into mobile-block mode.
It appears Outlier is actively differentiating automated sessions from real
browsers at the SSR layer.

This is out of scope for chromeflow to "fix" cleanly — the signals driving the
decision are probably TLS- or header-level, below the CDP/extension layer.
Documenting here so future agents don't waste time retrying reloads or chasing
a matchMedia override that won't help.

Recommendation: treat Outlier tasking as a manual workflow. chromeflow remains
appropriate for DataAnnotation and Multimango tasks where the pages render
desktop content normally.
