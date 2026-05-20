# Fireplace · The Book

A book-style note editor for the **Fireplace** personal dashboard. The writing
surface is a real photograph of an open book on a wooden table — text is laid
out over the parchment as if inked onto the page.

Vanilla **HTML / CSS / JS** only. No frameworks, no build step. Drop it on
any static host (Vercel, GitHub Pages, etc.) and it works.

## File map

| File | What it is |
|------|------------|
| `index.html`      | Skeleton: stage, book overlay, chrome, SVG filter defs |
| `style.css`       | All visual styles, design tokens, layout |
| `editor.js`       | Input handling, ink animation, zoom/pan, caret |
| `tweaks.js`       | The Tweaks panel (font, ink, size, curve, warp) |
| `assets/book-table.jpg` | The reference photograph (2730×1535) |

## How it's wired

### The stage
A fixed-size `#stage` element (2730×1535 to match the photo) holds the
photograph (`img#scene`) and the book overlay (`#book`). `#camera` is its
direct parent and gets a `transform: translate(...) scale(...)` to letterbox-
fit the stage into the viewport and apply user zoom/pan.

`fitStage()` computes the base scale on resize. `setZoom(target, anchorX, anchorY)`
zooms toward an anchor (mouse cursor or pinch midpoint). Pan is just adding
to `panX/panY`.

### The book overlay
`#book` is positioned via CSS variables `--book-x / --book-y / --book-w / --book-h`
as **percentages of the stage** (currently `27% / 23% / 46% / 55%`). These
were measured by sampling the photo — see `debug/grid.png` if you regen it.

Inside `#book`:
- `#paper` has `--page-pad-x / --page-pad-y` for the inner margin.
- `#text` is a single CSS-multicol container (`column-count: 2`,
  `column-gap` matches the visible spine gutter). Text naturally flows from
  the left page to the right page when column 1 fills up.

### Text rendering
A hidden `<textarea id="hidden-input">` captures keystrokes (handles IME and
mobile keyboards). On every `input` event we diff against `textBuffer` and
add/remove visible `<span class="ink-char">` elements at the end. Each
visible glyph is wrapped in an inner `<span class="ink-glyph">`:

```html
<span class="ink-char">
  <span class="ink-glyph">a</span>
</span>
```

- The **outer** span carries the **spine curve** transform.
- The **inner** span runs the **ink wipe** animation.

This separation matters: both effects use `transform`, and a single element
can only hold one `transform` value.

### Ink animation
Uses the **Web Animations API** (`Element.animate()`) per glyph — *not*
CSS `@keyframes`. CSS animations on dynamically-created elements were not
firing reliably in some environments; WAAPI is more deterministic.

The keyframes do a scaleX 0→1 left-to-right wipe (~120ms of the 520ms total)
followed by a blur 1.8px → 0 settle. A `setTimeout(800)` cancels the animation
defensively if it ever fails to commit, so chars are always visible at base
state.

### Spine curve
For each new char, `applyCurve()` measures its bounding rect, computes its
relative x position inside `#text`, and writes two CSS custom properties:

- `--char-y` — translateY downward (chars near the spine sink into the gutter)
- `--char-scale` — scaleX < 1 (chars near the spine are foreshortened by the curve)

These feed `.ink-char { transform: translateY(var(--char-y)) scaleX(var(--char-scale)); }`.

The effect is only visible when text actually reaches the inner edge of a
page (near the spine). With a short word in the upper-left of one page,
nothing curves — that's by design.

### Paper warp
SVG `feTurbulence` + `feDisplacementMap` filter on `#paper`. Toggled on by
the `.warp-on` class. `scale` attribute controls displacement strength.

### Quill caret
`#caret` is an absolutely-positioned element inside `#book`. After every
keystroke, `updateCaret()` finds the last char's bounding rect, normalises
it to book-local coordinates (dividing by the current `fitScale * zoom`),
and sets `caret.style.left/top/height`. The quill SVG is positioned with
its nib at the caret anchor; the caret line is a 2px vertical bar that blinks
via CSS.

### Zoom / pan
- Wheel: scrolls = pan, ctrl/cmd + wheel = zoom toward cursor.
- Alt + drag: pan.
- Middle-mouse drag: pan.
- 1-finger touch: pan.
- 2-finger touch: pinch zoom + pan together.
- Toolbar `−` / `+` / readout: zoom out / in / reset to `HOME_ZOOM` (1.55).

### Tweaks panel
Standalone vanilla module (`tweaks.js`). Toggled by the gear icon. Exposes:
- Font: EB Garamond / Cormorant Garamond / IM Fell English / Spectral
- Ink colour: 5 swatches
- Quill size: 18–44 pt slider
- Spine curve strength: 0–200% slider
- Paper warp: 0–6 slider

## Known limitations / TODO

These are the unfinished parts the next iteration should tackle:

1. **Caret is end-of-text only.** You can't click into the middle of typed
   text and edit there. The hidden textarea's selectionStart isn't
   reflected in the visible page. Add support for arrow keys and click-to-
   position by mapping textarea offset ↔ span index.

2. **No real page-turn.** The chrome shows "spread 4 of 32" but ‹/› buttons
   don't do anything. When `#text` content overflows column 2, it just gets
   clipped (`overflow: hidden`). Wire `prev`/`next` to swap which slice of
   the text buffer is rendered, and add a page-flip animation.

3. **No persistence.** The buffer lives in JS only. Add `localStorage` save
   on every input (debounced ~300ms).

4. **Curve is per-char and recomputed via JS.** Works fine but might jank
   on very long buffers (O(n) per char). Consider an SVG `feDisplacementMap`
   with a horizontal-cylinder map seeded on the spine — would let the GPU
   do the curve in a single pass.

5. **Selection / copy-paste / undo** are inherited from the hidden textarea
   but aren't visible. The selection highlight doesn't render.

6. **Fonts are Google Fonts CDN.** For offline / strict CSP, self-host the
   four families.

7. **Animation polish.** The current scaleX wipe reads as "ink growing from
   left." For a more authentic stroke trace, render each glyph as an SVG
   path and animate `stroke-dasharray`. Heavy work — not all fonts ship as
   SVG paths and you'd need a runtime path generator (e.g. opentype.js).

## Coordinate cheat sheet

- **Stage**: 2730×1535 fixed CSS pixels. All percentages in `style.css` are
  of this stage.
- **Viewport**: window.innerWidth × innerHeight. The camera scales the
  stage to fit.
- **Book**: 27%–73% horizontally, 23%–78% vertically of the stage.
- **Book center / spine**: 50% of the stage horizontally.
- **getBoundingClientRect** values are in *viewport* coordinates — divide
  by `fitScale * zoom` to get stage-coordinate sizes.

## What the user sees

1. Wood table + open book photo, scaled to fit the viewport.
2. Top chrome bar: notebook title, spread number, prev/next.
3. Bottom chrome bar: demo / clear / zoom controls / save status / tweaks.
4. Italic hint "begin where the candlelight finds you…" centered on the
   left page. Hidden once typing starts.
5. Click anywhere → caret focuses on left page → start typing → each char
   wipes in with the ink animation.
6. Demo button replays a sample passage at handwriting cadence (~60ms/char).
