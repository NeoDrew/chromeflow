# Driving LinkedIn with chromeflow

LinkedIn is a React SPA that mounts large parts of its UI (Easy Apply
modals, some dialogs) inside **web-component shadow hosts**, runs
behavioural anti-bot, and aggressively rate-limits automation. chromeflow
itself stays generic; there is no LinkedIn-specific tool. This page is a
recipe pack for driving LinkedIn's specific quirks with the normal
primitives (`get_page_text`, `find_text`, `click_element`,
`get_form_fields`, `fill_input`, `execute_script`, `wait_for`).

Everything below was validated against the live logged-in site, including a
real end-to-end Easy Apply submission.

## The five LinkedIn facts that bite you

1. **The Easy Apply modal lives in an OPEN shadow host (`#interop-outlet`).**
   `get_page_text()` with **no selector** reads it: modal content is
   prepended under an `[open dialog]` marker, because chromeflow auto-collects
   open dialogs shadow-deep. `get_page_text(selector="div[role=dialog]")`
   often returns almost nothing, because the light-DOM `div[role=dialog]` it
   scopes to is a transitional wrapper while the real content sits in the
   shadow tree. **Read modals with no selector.**

2. **`textHint` for modal buttons drifts to the wrong control.** A modal
   "Next" and the search-results pagination "Next" are both on screen.
   `click_element(textHint="Next", in_dialog=true)` can still match the
   pagination button, which navigates the job list to the next page and
   **silently switches `currentJobId` under the open modal**, leaving you one
   Submit-click away from applying to the wrong job. Always click modal
   buttons by their **precise aria-label selector** (shown below).

3. **The submit button needs a pointer-event chain, not a plain click.** A
   CDP coordinate click on "Submit application" lands but does NOT fire
   LinkedIn's submit handler (the modal stays on Review). The reliable path
   is an `execute_script` pointer chain on the button. See the Easy Apply
   recipe.

4. **Verify the job at every step.** Because of fact 2, re-read the modal
   heading (`Apply to <Company>`) and `currentJobId` on each step and abort
   if either changes unexpectedly.

5. **Screenshots are unreliable on LinkedIn.** The heavy SPA makes
   `take_screenshot` fail often with bitmap/fetch errors. Use
   `get_page_text`, `find_text`, and `get_form_fields` for all state
   inspection.

## Job search + scraping

Search via URL params, with no clicking through filters:
```
open_page("https://www.linkedin.com/jobs/search/?keywords=AI%20Engineer&f_AL=true&f_WT=2&location=United%20Kingdom")
```
- `f_AL=true` is Easy Apply only
- `f_WT=2` is Remote (1=on-site, 3=hybrid)
- `keywords`, `location` are URL-encoded
- `start=25` is pagination (page 2), `start=50` (page 3), and so on

Scrape the result cards into structured data in one call:
```js
execute_script(`
  const cards=[...document.querySelectorAll('li[data-occludable-job-id]')];
  return cards.map(li=>({
    id: li.getAttribute('data-occludable-job-id'),
    title: (li.querySelector('a.job-card-container__link, a.job-card-list__title')?.innerText||'').trim().split('\\n')[0],
    company: (li.querySelector('[class*="job-card-container__primary-description"], [class*="artdeco-entity-lockup__subtitle"]')?.innerText||'').trim(),
    location: (li.querySelector('[class*="job-card-container__metadata"]')?.innerText||'').trim(),
    easyApply: /Easy Apply/i.test(li.textContent||''),
  })).filter(j=>j.title);
`)
```
Open a specific job's detail pane (right side) without losing the list:
```
click_element(selector='li[data-occludable-job-id="<ID>"] a.job-card-container__link', until_text_contains="Easy Apply")
```
Read the full description from the detail pane with `get_page_text` (no
selector). It includes the About-the-job text and applicant insights.

## Easy Apply, the full recipe

Easy Apply is a 1-to-5-step modal. Steps run Contact info, then optionally
Resume and Additional Questions, then Review, then Submit. For a complete
profile most fields are pre-filled, so the work is mostly advance, verify,
submit.

**1. Open the modal:**
```
click_element(selector='button.jobs-apply-button, .jobs-apply-button--top-card button')
```
Confirm it opened and capture the job you are applying to:
```js
execute_script(`
  const dlg=$deep('div[role="dialog"]');
  return { heading: dlg?.querySelector('h2,h3')?.innerText?.trim(),
           jobId: new URLSearchParams(location.search).get('currentJobId') };
`)
// expect heading "Apply to <Company>". REMEMBER this company + jobId.
```

**2. Advance through steps by precise aria-label selector** (never
`textHint="Next"`):
```
click_element(selector='button[aria-label="Continue to next step"]')
```
After each advance, **re-verify** the heading/jobId are unchanged and read
the step:
```js
execute_script(`
  const dlg=$deep('div[role="dialog"]');
  return { heading: dlg?.querySelector('h2,h3')?.innerText?.trim(),
           jobId: new URLSearchParams(location.search).get('currentJobId'),
           progress: dlg?.innerText.match(/(\\d+)%/)?.[1] };
`)
```
If heading or jobId changed, **abort**: dismiss and restart on the intended
job (see Dismiss below). Read step content with `get_page_text()` (no
selector).

**3. Required fields / questions.** Run `get_form_fields(only_empty=true)`;
it reaches into the shadow modal. "Additional Questions" radios (e.g. "Have
you completed a Bachelor's Degree?") are often already answered from your
saved profile (check `input[type=radio].checked`). If you must set one,
note that LinkedIn radio `id`s are URNs containing colons and parentheses,
e.g. `urn:li:fsd_formElement:...(jobId,fieldId,multipleChoice)-0`. A `#id`
selector is invalid CSS there (the colons break it), so target by the
**attribute form**:
```
click_element(selector='input[id="urn:li:fsd_formElement:...-0"]')   // the "Yes" radio
```
Text fields use `fill_input(selector=..., value=...)`.

**4. Review, then submit.** Advance to Review:
```
click_element(selector='button[aria-label="Review your application"]')
```
FINAL verification before submitting (guards against drift):
```js
execute_script(`
  const dlg=$deep('div[role="dialog"]');
  return { heading: dlg?.querySelector('h2,h3')?.innerText?.trim(),
           jobId: new URLSearchParams(location.search).get('currentJobId'),
           submit: !!$deep('button[aria-label="Submit application"]') };
`)
```
Only if `heading`/`jobId` match the job you intended, submit. A plain click
on the submit button does NOT fire LinkedIn's handler, so use the pointer
chain:
```js
execute_script(`
  const btn=$deep('button[aria-label="Submit application"]');
  if(!btn) return {error:'no submit button'};
  const r=btn.getBoundingClientRect(), cx=r.left+r.width/2, cy=r.top+r.height/2;
  for(const t of ['pointerdown','mousedown','pointerup','mouseup','click']){
    const E=t.startsWith('pointer')?PointerEvent:MouseEvent;
    btn.dispatchEvent(new E(t,{bubbles:true,cancelable:true,composed:true,clientX:cx,clientY:cy,button:0,buttons:t.endsWith('down')?1:0,pointerType:'mouse',isPrimary:true}));
  }
  return {fired:true};
`)
```
Verify it landed:
```
find_text("application was sent|Your application", regex=true)
// expect "Your application was sent to <Company>!"
```
Then dismiss the success modal (it has a Done/Dismiss control), or
`open_page` away.

**Dismiss / discard a half-filled application** (for example after
detecting drift): click the modal's `button[aria-label="Dismiss"]`. A
light-DOM "Save this application? Discard / Save" confirm opens; this
confirm IS visible to `find_text`, unlike the shadow form. Click `Discard`
with `in_dialog=true`.

> Note: on the modal Next/Submit clicks, `click_element` may report "no
> observable activity (silently_rejected)" even though the step DID advance.
> The activity probe cannot always see a shadow-DOM modal swap, so do not
> trust that message on LinkedIn modals; verify with the heading/progress
> re-read above. `until_selector` and `until_text_contains` are
> shadow-piercing in current builds, so they can also gate modal content; on
> older builds they were blind to shadow modals, in which case fall back to
> click-then-re-read.

## Connections + outreach

**Connect with a note** (from a profile or a search result). The Connect
button is sometimes behind a "More" overflow:
```
find_text("Connect", whole_word=true)            // is it a top-level button?
click_element(textHint="Connect")                // or via the More menu:
click_element(selector='button[aria-label*="More actions"]')
click_element(textHint="Connect", in_dialog=false)
```
The "Add a note" dialog is a light-DOM artdeco modal:
```
click_element(textHint="Add a note", in_dialog=true)
fill_input(selector='textarea[name="message"], #custom-message', value="<note, <=300 chars>")
click_element(textHint="Send", in_dialog=true)
```
**Messaging** an existing connection: open their profile,
`click_element(textHint="Message")`. The composer is a contenteditable, so
`type_text(into_selector='div[contenteditable="true"][role="textbox"]',
text=..., clear_first=true)` (use `type_text`, not `fill_input`, so the
React/Quill editor registers input), then click `Send`.

## People / company search + scraping

```
open_page("https://www.linkedin.com/search/results/people/?keywords=...&origin=GLOBAL_SEARCH_HEADER")
```
Scrape result entities via `execute_script` over the result list
(`li.reusable-search__result-container` / `[data-chameleon-result-urn]`),
reading name, headline, and profile URL. For a single profile,
`get_page_text` (no selector) gives the full visible profile; `read_element`
plus `write_to_env` captures a specific value intentionally.

## Feed engagement

Like, comment, or repost on targeted posts only. The feed is heavily
virtualised, so scroll the target into view (`scroll_to_element`) before
acting. The comment composer is a contenteditable (`type_text`, not
`fill_input`). **Do not post to the feed unless explicitly asked.**

## Safety / rate-limit caps (protect the account)

LinkedIn restricts and bans accounts for automation-like behaviour. Treat
these as hard caps unless the user overrides:
- **Connection requests:** about 15 to 20 per day for an established
  account, far fewer for a new one. Space them minutes apart and
  personalise.
- **Easy Apply:** moderate volume. A burst of dozens in minutes looks
  automated, so pace applications and vary timing.
- **Messages:** a handful per day, personalised.
- **Feed actions:** cap promo engagement low and mix with genuine activity
  (this mirrors the Reddit/X playbooks).
- Stop on any "You've reached the weekly invitation limit" or restriction
  interstitial and report it. Do not retry around it.
