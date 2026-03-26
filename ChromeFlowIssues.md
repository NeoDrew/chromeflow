
## Known chromeflow limitations & workarounds

### React Select / custom dropdowns
`click_element` and `fill_input` do not work on React Select components (the styled
"Select..." dropdowns common on DataAnnotation and similar forms). Use this pattern instead:

```js
// 1. Open the menu — click the control div
var controls = document.querySelectorAll('[class*="control"]');
// filter to the right one by pageY if there are multiple
controls[N].click();

// 2. Pick an option — find by exact text content, dispatch mouse events
var allEls = document.querySelectorAll('*');
for (var i = 0; i < allEls.length; i++) {
    if (allEls[i].textContent.trim() === 'Target Option' && allEls[i].children.length === 0) {
        allEls[i].click();
        allEls[i].dispatchEvent(new MouseEvent('mousedown', {bubbles: true}));
        allEls[i].dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));
        break;
    }
}

// 3. Verify
controls[N].textContent.trim(); // should now show selected value
```

### React-controlled textareas without labels
`fill_input` label resolution walks 8 levels deep and also checks `previousElementSibling`,
which covers most cases. It also falls back to `document.activeElement` if the user just
clicked the field via `wait_for_click`.

However, if the label and textarea are more than 8 DOM levels apart or in a non-standard
structure, "No input found" will still occur. In that case, use the native setter directly:

```js
var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
var ta = document.querySelectorAll('textarea')[index];
setter.call(ta, value);
ta.dispatchEvent(new Event('input', {bubbles: true}));
ta.dispatchEvent(new Event('change', {bubbles: true}));
```

Identify the right textarea by `pageY = getBoundingClientRect().top + scrollY` — use a
context scan of surrounding DOM text to confirm before writing.

### File upload confirmation
After the user uploads a file, the `input[type="file"]` element is removed from the DOM
and replaced with a preview or "Remove" link. `get_form_fields()` marks file inputs as
"manual only" — highlight them and ask the user to select the file. Confirm success with:
`document.body.innerText.includes('Remove')` or check for the preview image.

### Page content rendered as embedded images
Some DataAnnotation tabs (e.g. the qualification "Examples" tab) serve content as
base64-encoded PNG images embedded in HTML rather than DOM text. `get_page_text()`,
`innerText`, and `textContent` return nothing useful for this content.

Workaround: zoom the page out so the full width fits on screen, then screenshot to read
the content visually:

```js
document.body.style.zoom = '0.4';  // shrink to fit wide content
// then use take_and_copy_screenshot() to read it
```

Restore zoom afterward: `document.body.style.zoom = '1'`.
