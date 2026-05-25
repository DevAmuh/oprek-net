# Fireplace · The Book

A parchment markdown editor for the **Fireplace** personal dashboard.
A single contenteditable writing surface sits over a photograph of an
open book on a wooden table. Each typed character draws itself in ink
(SVG path stroke), lines bend gently toward the spine via an SVG
`feTurbulence` + `feDisplacementMap` filter, markdown formatting
(`**bold**`, `# heading`, `> quote`, etc.) renders live as you type
with the source markers visible-but-dimmed (Typora-style), the quill
cursor follows the native caret, and the page persists to
`localStorage`. A hand toggle swaps between a readable italic serif
(Cormorant Garamond) and a dramatic script (Italianno).

Vanilla **HTML / CSS / JS** only. No frameworks, no build step. Drop
it on any static host.

## File map

| File | What it is |
|------|------------|
| `index.html`            | DOM, SVG filter defs, opentype.js CDN, quill SVG |
| `style.css`             | All visual styles, design tokens, animation keyframes |
| `editor.js`             | Camera (zoom/pan), page-warp filter, quill cursor, ink trace, persistence |
| `markdown.js`           | Live block-level markdown renderer; caret save/restore; marker near-fade |
| `tweaks.js`             | The hand (font) toggle in the bottom chrome |
| `assets/book-table.jpg` | The reference photograph (2730×1535) |

External (CDN):
- **opentype.js** v1.3.4 — extracts per-glyph vector paths for the ink trace.
- **Fontsource** — `latin-400-normal.ttf` for each font. Used by
  opentype.js (it can't decode Google's WOFF2 — no Brotli in the CDN build).
- **Google Fonts CSS** — Cormorant Garamond italic + Italianno + Inter
  (chrome UI). Loaded normally for on-page rendering.

## How it's wired

### The stage
A fixed-size `#stage` (2730×1535, the photo's native resolution) holds
the photograph (`img#scene`) and the book overlay (`#book`). `#camera`
is its direct parent and gets a `transform: translate(...) scale(...)`
to fit the stage into the viewport and apply user zoom/pan.

`fitStage()` computes the base scale on resize. `setZoom(target, anchorX,
anchorY)` zooms toward an anchor (mouse cursor or pinch midpoint). Pan
is just adding to `panX/panY`. `vpW()`/`vpH()` use fallbacks because
`innerWidth/innerHeight` can momentarily be 0 in headless contexts.

### The book + writing surface
`#book` is positioned via CSS variables `--book-x / --book-y / --book-w
/ --book-h` as **percentages of the stage** (currently `27% / 23% / 46%
/ 55%`).

Inside `#book`:
- `.text-flow[contenteditable]` — the actual editor. The browser handles
  caret, selection, arrow keys, click-to-position, undo/redo natively.
- `#quill-caret` (sibling of `.text-flow`) — the quill cursor.
- `.hint` — the italic prompt that fades out on first keystroke.

### SVG page-warp filter (the brief's approach, done right)
```
filter id="page-warp" filterUnits=objectBoundingBox x=-3% y=-3% w=106% h=106%
  feTurbulence (fractalNoise, baseFrequency 0.04, seed nudged every 8s)
    → feDisplacementMap (scale 4)     -- paper-texture wobble
  feImage #spine-map                   -- a generated cosine PNG
    → feDisplacementMap (scale 22)    -- spine dip, ~11px max at gutter
```
JS generates the spine displacement map at startup (`buildSpineMap`):
a 256×4 PNG where each column carries the same horizontal cosine valley
(G channel = 128 at outer edges → ~0 at the horizontal centre, so feDisplacementMap
samples `output(x,y) = input(x, y + scale·(G/255 − 0.5))` — pixels at the
spine come from ABOVE, i.e. lines dip downward into the gutter).
The PNG data URL is set on `#spine-map`'s href, and `.text-flow.warp-on`
turns the filter on. If generation fails, the class isn't added and text
stays unwarped (graceful).

### Quill cursor follows the native caret
`#quill-caret` is a zero-size anchor sibling of `.text-flow` inside
`#book` — kept outside the SVG filter so the quill itself isn't warped.
On every `selectionchange` and `input` (throttled with `setTimeout 16ms`),
`updateQuill()`:
1. Gets the native caret rect via `Selection.getRangeAt(0).getBoundingClientRect()`
   (falls back to the focus block's `<br>` or its own rect for empty blocks).
2. Converts to book-local stage pixels: `(rect.left − bookRect.left) / scale`.
3. Adds the spine dip (`spineDipPx(t)` mirrors the displacement map math)
   so the nib stays glued to the warped line near the gutter.
4. Sets `caret.left/top/height`.

The quill SVG is sized in `em` (1.2em × 3.2em) with `left:-0.64em; top:-3.12em`
so the nib pixel (SVG viewBox 64,312 of 120×320) lands at `#quill-caret`'s
origin at any font size. The native caret is hidden via
`.text-flow { caret-color: transparent }` so only the quill is visible.

### Ink trace (opentype.js · transient overlay)
When the user types a single character (`input` event with
`inputType: 'insertText'` and `e.data.length === 1`):
1. `runInkTrace(ch)` isolates the just-typed char into a
   `<span class="ink-fresh">` (transparent → no abrupt pop-in).
2. `spawnInkOverlay` creates an `<svg>` in `#hidden-host` (viewport-fixed
   layer), positioned at the char's screen rect. The glyph's vector path
   from opentype.js is set with `stroke-dasharray = strokeDashoffset =
   pathLength`. WAAPI animates `strokeDashoffset → 0` over `inkMs` (~80ms).
3. On animation finish (or after a safety setTimeout): the overlay fades
   (110 ms cross-fade) and is removed.
4. After ~150ms total, the `.ink-fresh` span is replaced with a plain
   text node — char becomes visible.

If opentype.js isn't loaded or the font's TTF hasn't fetched yet, the
trace is skipped (no DOM mutation, native undo stays pristine).

### Markdown live renderer (`markdown.js`)
Supported (v1): `# H1`, `## H2`, `### H3`, `**bold**`, `*italic*`,
`> blockquote`, `- bullet`, `1. ordered`, `` `code` ``, `[text](url)`.

On every `input`, **debounced 220 ms** (so it doesn't fight the ink trace),
`renderCaretBlock()` finds the block containing the caret, re-parses its
`textContent`, and replaces its `innerHTML`. If the block's tag changed
(e.g. `<p>` → `<h1>`), the block element itself is replaced in-place.

Markers (`**`, `#`, `>`, etc.) are wrapped in `<span class="md-marker">`
spans — visible but dimmed via CSS (opacity 0.32; whimsy `.near` bumps
to 0.88 in the focused block).

Caret is preserved across re-renders via a character-offset save/restore:
`saveBlockSelection(block)` counts chars from the block start to the
caret; `restoreBlockSelection(block, offsets)` walks the new tree to find
the matching text node + offset.

### Hand (font) toggle
`tweaks.js` wires `#btn-font` in the bottom chrome. One click swaps
the `--book-font` CSS variable between Cormorant Garamond italic
(default) and Italianno (script). The `.text-flow` cross-fades opacity
0.35 → 1 during the swap. The choice persists. Italianno's TTF is
loaded for the ink trace via Fontsource on first toggle.

### Persistence
`localStorage.setItem('fireplace.book.v2', { v:2, html, font, savedAt })`
debounced 300 ms after each input. Status indicator decays
`writing… → saved · just now → 5s ago → 1m ago → 1h ago` (refresh
every 5 s). The candle-pulse keyframe on `.status-dot.flash` fires
on successful save. `restoreFromStorage()` runs once at init.

### Whimsy
- **Candle flicker** on `.candlelight` (7s loop, soft-light blend over the photo).
- **Quill breathes** every 4.5s (subtle rotation).
- **Marker brighten** when caret enters the block (`.md-marker.near` class).
- **Ink-bleed text-shadow** on `.text-flow` — `text-shadow: 0 0 0.4px / 0 0 1.1px` warm tones, makes the ink feel wet.
- **Save flourish** — `candle-pulse` box-shadow on the status dot at every save.
- **Slow ambient turbulence** — `feTurbulence seed` nudged every 8s; the paper texture drifts imperceptibly.
- **Wax seal** in the top chrome ("Fp" inside an embossed red disc).
- **Cache-bust query strings** `?v=g2` on `style.css` / `editor.js` /
  `markdown.js` / `tweaks.js` — bump when shipping a new version.

### Zoom / pan
- Wheel: pans · over `.text-flow` (when it can scroll) lets native scroll
  · `Ctrl/Cmd + wheel` zooms toward cursor.
- Alt + drag / middle-mouse drag: pan.
- 1-finger touch: pan (unless starting on the text).
- 2-finger touch: pinch zoom.
- Toolbar: `−` / `+` / readout (click to reset to `HOME_ZOOM = 1.55`).

## Coordinate cheat sheet
- **Stage**: 2730×1535 fixed CSS pixels. All percentages are of the stage.
- **Viewport**: `vpW()`/`vpH()` (with fallbacks for headless).
- **Book**: 27%–73% horizontally, 23%–78% vertically of the stage. Spine at 50%.
- **#quill-caret coords**: book-local CSS pixels (un-zoomed stage px).
- **`getBoundingClientRect`**: viewport pixels; divide by `fitScale * zoom`
  to get stage-coord sizes.

## What the user sees
1. Wood table + open book photo, scaled to fit the viewport.
2. Top chrome: wax seal + notebook title.
3. Bottom chrome: clear · zoom · saved-status · hand toggle.
4. Italic hint "begin where the candlelight finds you…" centered on the page.
   Hides on first keystroke.
5. Click anywhere on the page → caret jumps there → start typing → each
   character draws itself in ink (~80 ms stroke trace), then settles.
6. Type `# Title` and pause → renders as a heading (with `#` shown dimmed).
   Type `**bold**` → renders inline. Same for `*italic*`, `> quote`,
   `- bullet`, `` `code` ``, `[text](url)`.
7. Drag-select text → warm candlelight wash on the selection. Native
   click-to-position, arrow keys, undo/redo all work.
8. Click `Aa` in the bottom chrome → swap between italic serif and script.
9. Refresh the browser → content + font choice restored.

## Known limitations / TODO

These are the parts the next iteration could still polish:

1. **Drop-cap on H1** — would require the parser to wrap the first
   heading letter in a `.dropcap` span (because the `#` marker is the
   actual first letter; CSS `::first-letter` would style the `#`, not the
   heading character). Deferred for a follow-up.
2. **Multi-line markdown blocks** — fenced code blocks (` ``` `) and
   block-spanning lists (real `<ul>`/`<ol>` containers across multiple
   line items) aren't supported in v1. Each `- item` is its own paragraph
   with a `.md-bullet` marker.
3. **Nested inline markdown** — `**bold *italic***` doesn't combine; the
   inner italic markers aren't processed (the parser stashes bold spans
   first, so their inner content is not re-walked).
4. **Mobile keyboard** — typing on a virtual keyboard works; the bottom
   chrome may overlap with the keyboard. No special handling yet.
5. **CSS / WAAPI animations in headless previews** — they don't render
   frames in some screenshot tools. Real browsers are fine. Verify the
   ink trace, marker fade, save flourish, and font cross-fade visually
   in a real browser.
6. **Cache-bust query strings** — drop or bump `?v=...` when shipping
   a new build; they exist purely for dev (to force script/stylesheet
   reloads past browser caching).
