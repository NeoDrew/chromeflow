# Chromeflow Issues Log

## MCP Server Disconnections
- Chromeflow MCP server disconnects frequently mid-task, requiring `/mcp` to reconnect
- All tools become unavailable simultaneously with no warning
- Happens especially during long sessions or after periods of inactivity
- Workaround: user runs `/mcp` to reconnect, then ToolSearch to re-fetch tool schemas

## CSP Blocks execute_script on External Sites
- Sites like outlier.ai use strict Content Security Policy that blocks `execute_script`
- Returns: "EvalError: Evaluating a string as JavaScript violates CSP directive"
- No workaround available, must fall back to get_page_text and click_element
- Affected sites: outlier.ai (confirmed), likely Stripe, GitHub per docs

## click_element Fails on Styled Links/Buttons
- "APPLY NOW" on outlier.ai visible in page text but not clickable via click_element
- Likely uses a styled div or span instead of a proper button/a element
- find_and_highlight also fails to locate the element
- get_elements shows only 1-3 elements on pages that visually have many more
- Workaround: try direct URL navigation, or highlight and ask user to click

## 0x0 Dimension Warnings
- click_element frequently reports "element has 0x0 dimensions (likely inside a collapsed or hidden panel)"
- Happens on: Save As buttons, Start buttons in data viewer, Apply buttons
- Sometimes the click still works despite the warning, sometimes it doesn't
- Workaround: scroll to the element area first, or use execute_script to click directly

## fill_input Targets Wrong Field
- When multiple textareas exist on a page, fill_input can fill the wrong one
- Especially problematic on DataAnnotation forms with many similarly-labeled fields
- The "Time spent" text went into a "Search files..." input on the Holodeck task
- Workaround: use execute_script with textarea index targeting instead of fill_input

## Monaco Editor Content Race Condition
- Monaco editor content can differ between reads during page load
- First read returned one problem JSON, subsequent reads returned a different one
- Likely caused by auto-sync or page state restoration happening after initial render
- Workaround: always verify Monaco content after page fully loads, re-download if mismatch

## Page State Loss
- DataAnnotation pages can lose form state on tab switch or page reload
- save_page_state only captured 4 of 14+ fields on some pages
- Workaround: use execute_script to directly read/write textarea values as backup

## WebSocket Connectivity in PingLine Data Viewer
- Problem Runner shows "WebSocket not connected" when clicking Start
- Service Health shows "Connected" but Problem Runner still fails
- Start button has 0x0 dimensions and is in a collapsed panel
- Blocks: running problems, Fairness Analyzer, golden trajectory grading
- Workaround: navigate away and back, Reset Viewer, full page reload

## LinkedIn OAuth Popup Interference
- Outlier sign-up triggered LinkedIn OAuth popup that took over the page
- get_form_fields returned phone verification code fields instead of the profile form
- Page text showed LinkedIn "Allow" dialog instead of the expected sign-up form
- Chromeflow doesn't handle OAuth redirects or popups well

## React Select Dropdowns
- Standard click_element and fill_input don't work on React Select components
- Requires execute_script with specific react-select input targeting
- Works on DataAnnotation but blocked by CSP on external sites
- No workaround on CSP-protected sites except asking user to click manually
