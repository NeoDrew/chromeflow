== CHROMEFLOW ISSUES & WORKAROUNDS ==

--- CLICKING ELEMENTS ---

1. COLLAPSED PANELS HAVE 0x0 DIMENSIONS
   Elements inside collapsed panels (e.g. the Problem Builder when the left
   panel is hidden) exist in the DOM but have zero width/height. click_element
   now warns when an element has 0x0 dimensions. Workaround: toggle the panel
   expand button first (the "<<" / ">>" arrow), then retry the click.

--- NAVIGATION ---

2. PAGE RELOAD LOSES PANEL STATE
   After open_page to the same URL (to force reload), the data viewer
   resets to the Services tab with panels collapsed. You need to click
   Build again and re-expand panels. Use save_page_state() before reloading
   to preserve form field values.

3. CLICKING SUB-TABS NAVIGATES TO NEW URL
   Clicking "Problem Runner" or "Fairness Analyzer" in the data viewer
   actually navigates to a new URL path (/problem-runner, /fairness-analyzer).
   This means the page state changes and you may need to re-select problems
   in dropdowns.
