# Fireplace · The Book

A book-style note editor for the **Fireplace** personal dashboard. Text sits
on a real photograph of an open book on a wooden table — each glyph is drawn
with a per-stroke ink trace, the two pages tilt back at the spine in real CSS
3D perspective, and the whole spread persists to `localStorage`.

Vanilla **HTML / CSS / JS** only. No frameworks, no build step. Drop it on
any static host (Vercel, GitHub Pages, etc.) and it works.

## File map

| File | What it is |
|------|------------|
| `index.html`            | Skeleton: stage, spread, two pages, quill SVG, chrome, filter defs |
| `style.css`             | All visual styles, 3D perspective, design tokens, layout |
| `editor.js`             | Input + layout + caret + spreads + persistence + ink trace |
| `tweaks.js`             | The Tweaks panel (font, ink, size, ink wetness, spread, erase) |
| `assets/book-table.jpg` | The reference photograph (2730×1535) |

External (CDN):
- **opentype.js** (v1.3.4) — parses TTF font data so each typed character can
  trace itself as an SVG path.
- **Fontsource** TTF mirrors of Google Fonts — opentype.js can't decode WOFF2
  (no Brotli in the CDN build), so the runtime fetches `latin-400-normal.ttf`
  from Fontsource on first use of each font.

## How it's wired

### The stage
A fixed-size `#stage` (2730×1535, the photo's native resolution) holds the
photograph (`img#scene`) and the book overlay (`#book`). `#camera` is its
direct parent and gets a `transform: translate(...) scale(...)` to fit the
stage into the viewport and apply user zoom/pan.

`fitStage()` computes the base scale on resize. `setZoom(target, anchorX, anchorY)`
zooms toward an anchor (mouse cursor or pinch midpoint). Pan is just adding
to `panX/panY`.

### The book overlay
`#book` is positioned via CSS variables `--book-x / --book-y / --book-w / --book-h`
as **percentages of the stage** (currently `27% / 23% / 46% / 55%`). Measured
from the photograph.

Inside `#book > #paper > .spread` are two `.page` elements with real 3D
perspective. Each page tilts back at its inner (spine) edge by `--spine-tilt`
(default `10deg`) — that match the photograph's spine fold without the old
broken `feDisplacementMap` cylinder filter:

```
.spread             perspective: 1800px; perspective-origin: 50% 40%;
  .page-left        transform-origin: 100% 50%;  transform: rotateY( 10deg);
    .page-inner     position: absolute; inset: 0; padding: 6% 7%;
  .page-right       transform-origin:   0% 50%;  transform: rotateY(-10deg);
    .page-inner
```

The text is laid out per-page by JS — CSS multicol is gone. `fillPage` inserts
chars one at a time, measuring `scrollHeight > clientHeight` to know when a
page is full and overflow needs to move to the next page (or start a new
spread).

### Spreads & buffer
`textBuffer` is the canonical state — one string. `spreads[]` is a parallel
index of `{ start, end }` offsets into `textBuffer`. `currentSpread` says
which spread is on screen. `rebuildSpreads()` walks the full buffer offscreen
through hidden probe pages to recompute the breakpoints (runs on font/size
change, on restore, and once `document.fonts.ready` resolves).

### Text rendering
A hidden `<textarea id="hidden-input">` captures keystrokes (handles IME and
mobile keyboards). On every `input` event we positional-diff against
`textBuffer` to find what was added/removed, taking the fast append/remove
path at the end or the slow `rebuildSpreads` path for mid-buffer edits.

Each glyph is wrapped in an inner `<span class="ink-glyph">`:

```html
<span class="ink-char">
  <span class="ink-glyph">a</span>
</span>
```

Newlines spawn a paired `.ink-char.hard-break` sibling carrying the `<br>`;
the primary `ink-char` is the buffer's char, the hard-break is layout-only.

### Ink trace animation
`startInkTrace(glyph, ch, font, ink, durationMs)` uses an opentype.js-parsed
font to extract the glyph's vector path, overlays an `<svg class="ink-trace">`
on the inline-block, sets `stroke-dasharray = strokeDashoffset = pathLength`,
and animates `stroke-dashoffset → 0` over `inkMs` ms via WAAPI. The underlying
text goes `color: transparent` during the trace; on `onfinish` the SVG fades
out (110 ms) while the text fades back in — outline-then-fill in one motion.

If opentype.js isn't loaded yet, or the requested font hasn't fetched, or the
glyph has no path data (rare — e.g. emoji), the call returns `false` and
`appendChar` falls back to `animateGlyphInk` — the simpler scaleX wipe + blur
settle. Either way the visible glyph ends up the same.

Font files load lazily: EB Garamond on init, the other three (Cormorant
Garamond, IM Fell English, Spectral) on first selection in the tweaks panel.

### Quill caret
`#caret` is a zero-size positioning anchor that lives **inside the active
`.page-inner`** so it inherits the page's 3D tilt automatically — quill leans
with the page, no projection math needed. `updateCaret()` walks the visible
spans, picks the right one based on `caretIndex`, and writes
`caret.style.left/top` using `offsetLeft + offsetWidth` (local CSS pixels,
which the page's transform applies to both caret and span equally).

The quill SVG is sized in `em` units: `width: 1.2em; height: 3.2em; left:
-0.64em; top: -3.12em` so the nib (SVG viewBox `(64, 312)`) stays anchored
at `#caret`'s origin at any font size.

`attachCaretTo(pageInner)` moves the `#caret` div between left and right
pages on overflow / spread change.

### Click-to-position + arrow keys + selection
- **Click on a `.page-inner`** → `document.caretRangeFromPoint(x, y)` →
  walk up to parent `.ink-char` → look up its index in `charSpans` → set
  `caretIndex` and `HiddenInput.setSelectionRange`.
- **Left/Right/Home/End** → let the textarea handle natively, then sync
  `caretIndex = HiddenInput.selectionStart`. If the new index falls outside
  the current spread, `ensureSpreadForOffset` switches and re-layouts.
- **Up/Down** → custom: probe `caretRangeFromPoint(currentX, currentY ± lineH)`.
- **Selection** → on every input/keyup, walk `charSpans[start..end]` and add
  `.ink-selected` (warm rgba(232,182,105,.28) wash). Selection that crosses
  the spine is shown broken into two highlights (matches reality, doesn't
  bridge the 3D gutter).

### Page navigation (prev / next)
`#btn-prev` / `#btn-next` call `goToSpread(currentSpread ± 1)`.
`animatePageFlip(direction)` clones the leaving page, strips its IDs (so the
DOM doesn't end up with two `#page-left-inner`), drops the clone into
`.spread` with class `flipping-page`, and runs a WAAPI rotateY animation
(0 → ±180°) over 700 ms with a `cubic-bezier(0.42, 0, 0.20, 1)` ease and a
mid-flip box-shadow lift. Layout of the destination spread is scheduled at
the 100 ms mark (during the visually busy midpoint) so it doesn't jank the
animation.

The spread indicator (top chrome) and the spread slider (tweaks panel) both
listen on a `book:spread-changed` custom event dispatched whenever
`updatePageIndicator()` runs.

### Persistence (`localStorage`)
Save key: `fireplace.book.v1`. On every input event, `schedulePersist()`
debounces 300 ms then writes:

```json
{ "v": 1, "buffer": "...", "currentSpread": 2,
  "settings": { "font": "EB Garamond", "size": 30, "ink": "#2a1808" },
  "savedAt": 1737316582341 }
```

`updateSavedStatus()` refreshes every 5 s — the bottom chrome shows
`saved · just now` → `saved · 5s ago` → `saved · 1m ago` → `saved · 1h ago`.
Errors flip the status dot to `#e86969` (`save failed`).

`restoreFromStorage()` runs once at init, before the first `updateCaret`,
and recovers buffer + spread + font/size/ink. The "Erase the book…" button
in the tweaks panel does a two-step confirm then wipes the key and reloads.

### Zoom / pan
Unchanged from the previous architecture:
- Wheel: scrolls = pan, ctrl/cmd + wheel = zoom toward cursor.
- Alt + drag / middle-mouse drag: pan.
- 1-finger touch: pan.
- 2-finger touch: pinch zoom + pan together.
- Toolbar `−` / `+` / readout: zoom out / in / reset to `HOME_ZOOM` (1.55).

### Paper-warp turbulence
SVG `feTurbulence` + `feDisplacementMap`. Applied to each `.page-inner`
(NOT to the rotated `.page`) so the 3D context doesn't flatten on Safari.
On by default at `scale=3.5`; there's no tweaks-panel slider since the
default reads as natural paper irregularity at every font size.

### Tweaks panel
Standalone vanilla module (`tweaks.js`). Toggled by the gear icon. Exposes:
- **Hand**: font family (EB Garamond / Cormorant Garamond / IM Fell English / Spectral).
- **Ink**: 5 swatches.
- **Quill size**: 18–44 pt slider.
- **Ink wetness**: 60–150 ms slider — controls per-glyph trace duration.
- **Spread**: 1..N range slider, two-way bound with `currentSpread`.
- **Erase the book…**: two-step confirm (click 1 arms; click 2 within 3 s
  wipes `localStorage` and reloads).

## Coordinate cheat sheet
- **Stage**: 2730×1535 fixed CSS pixels. All percentages in `style.css` are
  of this stage.
- **Viewport**: `window.innerWidth × innerHeight`. The camera scales the
  stage to fit.
- **Book**: 27%–73% horizontally, 23%–78% vertically of the stage.
- **Book center / spine**: 50% of the stage horizontally.
- **Pages**: each is a child of `.spread`, flexed to 50% of the spread width,
  3D-rotated around its inner edge by `--spine-tilt`.
- **Caret coordinates**: `caret.style.left/top` are in `.page-inner`'s local
  CSS pixel space (un-transformed). The page's 3D rotation applies equally
  to caret and spans at render time.
- **getBoundingClientRect** values are in *viewport* coordinates (projected
  through any 3D rotations); divide by `fitScale * zoom` to get stage-coord
  sizes for elements that aren't rotated.

## What the user sees
1. Wood table + open book photo, scaled to fit the viewport.
2. Top chrome bar: notebook title, spread indicator, prev/next.
3. Bottom chrome bar: demo / clear / zoom controls / "saved · just now" / tweaks gear.
4. Italic hint "begin where the candlelight finds you…" centered on the
   left page. Hidden once typing starts (and on restore if the buffer has
   content).
5. Click anywhere on a page → caret jumps to that text position → start
   typing → each character draws itself as a pen stroke (~80 ms) then
   settles into solid text.
6. Overflow the right page → next spread auto-creates → click the chrome's
   ›  to flip forward, ‹ to flip back.
7. Refresh the browser → buffer + spread + settings restored from localStorage.

## Known limitations / TODO

These are the parts the next iteration could still polish:

1. **No path-traced selection range render.** Selection highlight is per-char
   inline-block backgrounds. Multi-line selections inside a single page
   show broken rectangles at line wraps — works fine but isn't beautiful.

2. **Frozen-glyph optimization deferred.** All live SVG traces are removed
   when their animation completes (so DOM count stays low without an
   explicit freeze sweep). For very long buffers (10k+ chars) on slow
   devices, layout could be optimized further — e.g. virtualized pages.

3. **Storage versioning.** `fireplace.book.v1`. If the schema changes in
   v2, write a migration step in `restoreFromStorage`.

4. **Offline / strict CSP.** opentype.js + Fontsource fetches need network
   access at first load. The fallback (scaleX wipe) covers the experience
   when those fail, but to ship offline, self-host the TTFs (and ship
   opentype.min.js locally).

5. **Mobile keyboard + flip jitter.** When the virtual keyboard appears
   mid-flip animation, `visualViewport.resize` can cause layout jitter.
   Not handled yet.

6. **Cross-page selection.** Currently splits per-page (selection that
   spans the spine renders as two separate highlights, one per page).
   By design — bridging the 3D gutter would look weird.
