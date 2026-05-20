/* ═══════════════════════════════════════════════════════════════
   Fireplace · The Book — editor.js
   ═══════════════════════════════════════════════════════════════ */

(() => {
'use strict';

// ─────────── elements ───────────
const Viewport      = document.getElementById('viewport');
const Camera        = document.getElementById('camera');
const Stage         = document.getElementById('stage');
const Book          = document.getElementById('book');
const Paper         = document.getElementById('paper');
const SpreadEl      = document.getElementById('spread');
const LeftPage      = document.getElementById('page-left-inner');
const RightPage     = document.getElementById('page-right-inner');
const Caret         = document.getElementById('caret');
const HiddenInput   = document.getElementById('hidden-input');
const HintEl        = document.getElementById('hint');
const ZoomValue     = document.getElementById('zoom-value');
const StatusText    = document.getElementById('status-text');
const ShortcutChip  = document.getElementById('shortcut-chip');
const PageIndicator = document.querySelector('.page-indicator');

// ─────────── constants ───────────
const STAGE_W = 2730;
const STAGE_H = 1535;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 3.6;

// ─────────── state ───────────
let zoom = 1.55;  // initial: book fills the viewport, hints of table around it
let panX = 0, panY = 0;
let fitScale = 1;
let textBuffer = '';
let charSpans = [];                           // visible PRIMARY spans on the spread
                                              // (one per buffer char — hard-break siblings excluded)
let spreads = [{ start: 0, end: 0 }];         // [{start, end}] indexes into textBuffer
let currentSpread = 0;
let activePageEl = LeftPage;                  // page receiving live typing
let caretIndex = 0;                           // insertion point in textBuffer (0..length)
let firstInputDone = false;

// settings (mirrored to Tweaks panel)
window.__book = {
  font: 'EB Garamond',
  size: 30,
  ink: '#2a1808',
  inkMs: 80,                          // per-glyph stroke trace duration
  fontDb: {},                         // family → parsed opentype.js Font
  setFont(f) {
    this.font = f;
    LeftPage.style.fontFamily = `'${f}', Georgia, serif`;
    RightPage.style.fontFamily = `'${f}', Georgia, serif`;
    loadFontForInkTrace(f);            // async load (no await — fallback works)
    rebuildSpreads();
    updateCaret();
  },
  setSize(px) {
    this.size = px;
    LeftPage.style.fontSize = px + 'px';
    RightPage.style.fontSize = px + 'px';
    rebuildSpreads();
    updateCaret();
  },
  setInk(c) {
    this.ink = c;
    document.documentElement.style.setProperty('--ink', c);
    document.documentElement.style.setProperty('--ink-soft', c + 'd9');
    document.documentElement.style.setProperty('--ink-wet', c);
  },
};

// Paper-warp turbulence on each page-inner (kept off the rotated .page so
// the 3D context doesn't flatten on Safari).
LeftPage.classList.add('warp-on');
RightPage.classList.add('warp-on');
function fitStage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // leave some headroom for chrome
  const pad = 80;
  fitScale = Math.min((vw - pad*2) / STAGE_W, (vh - pad*2) / STAGE_H);
  applyCamera();
}

function applyCamera() {
  const scale = fitScale * zoom;
  const cx = (window.innerWidth - STAGE_W * scale) / 2 + panX;
  const cy = (window.innerHeight - STAGE_H * scale) / 2 + panY;
  Camera.style.transform = `translate3d(${cx}px, ${cy}px, 0) scale(${scale})`;
  ZoomValue.textContent = Math.round(zoom * 100) + '%';
}

function setZoom(target, anchorClientX, anchorClientY, animated) {
  target = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target));
  if (anchorClientX != null) {
    // keep the world point under the anchor stable
    const scaleBefore = fitScale * zoom;
    const scaleAfter  = fitScale * target;
    const cxBefore = (window.innerWidth  - STAGE_W * scaleBefore) / 2 + panX;
    const cyBefore = (window.innerHeight - STAGE_H * scaleBefore) / 2 + panY;
    const worldX = (anchorClientX - cxBefore) / scaleBefore;
    const worldY = (anchorClientY - cyBefore) / scaleBefore;
    panX = anchorClientX - worldX * scaleAfter - (window.innerWidth  - STAGE_W * scaleAfter) / 2;
    panY = anchorClientY - worldY * scaleAfter - (window.innerHeight - STAGE_H * scaleAfter) / 2;
  }
  zoom = target;
  if (animated) {
    Camera.classList.add('animating');
    applyCamera();
    setTimeout(() => Camera.classList.remove('animating'), 300);
  } else {
    applyCamera();
  }
}

const HOME_ZOOM = 1.55;
function resetView() {
  panX = 0; panY = 0;
  setZoom(HOME_ZOOM, null, null, true);
}

window.addEventListener('resize', () => { fitStage(); updateCaret(); });

// ─────────── wheel: pan, ctrl-wheel: zoom ───────────
Viewport.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    const factor = Math.pow(1.0025, -e.deltaY);
    setZoom(zoom * factor, e.clientX, e.clientY, false);
  } else {
    panX -= e.deltaX;
    panY -= e.deltaY;
    applyCamera();
  }
}, { passive: false });

// ─────────── mouse: alt+drag or middle-button to pan ───────────
let dragging = false, dragOrigin = null, panOrigin = null;
Viewport.addEventListener('mousedown', (e) => {
  const wantsPan = e.altKey || e.button === 1;
  if (wantsPan) {
    e.preventDefault();
    dragging = true;
    dragOrigin = { x: e.clientX, y: e.clientY };
    panOrigin  = { x: panX, y: panY };
    Viewport.classList.add('panning');
  } else if (e.button === 0) {
    // click on stage → focus textarea, place caret at end
    HiddenInput.focus();
  }
});
window.addEventListener('mousemove', (e) => {
  if (dragging) {
    panX = panOrigin.x + (e.clientX - dragOrigin.x);
    panY = panOrigin.y + (e.clientY - dragOrigin.y);
    applyCamera();
  } else {
    // show grab cursor when Alt is held
    Viewport.classList.toggle('pan-ready', e.altKey);
  }
});
window.addEventListener('mouseup', () => {
  dragging = false;
  Viewport.classList.remove('panning');
});
window.addEventListener('blur', () => { dragging = false; Viewport.classList.remove('panning'); });

// ─────────── touch: 1-finger pan, 2-finger pinch zoom ───────────
let touchState = null;
Viewport.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    touchState = {
      mode: 'pan',
      x: e.touches[0].clientX,
      y: e.touches[0].clientY,
      panX, panY,
      moved: false,
    };
  } else if (e.touches.length === 2) {
    const [a, b] = e.touches;
    const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY;
    touchState = {
      mode: 'pinch',
      startDist: Math.hypot(dx, dy),
      startZoom: zoom,
      cx: (a.clientX + b.clientX) / 2,
      cy: (a.clientY + b.clientY) / 2,
    };
  }
}, { passive: true });

Viewport.addEventListener('touchmove', (e) => {
  if (!touchState) return;
  if (touchState.mode === 'pan' && e.touches.length === 1) {
    const t = e.touches[0];
    panX = touchState.panX + (t.clientX - touchState.x);
    panY = touchState.panY + (t.clientY - touchState.y);
    if (Math.hypot(t.clientX - touchState.x, t.clientY - touchState.y) > 6) touchState.moved = true;
    applyCamera();
    e.preventDefault();
  } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
    const [a, b] = e.touches;
    const dx = b.clientX - a.clientX, dy = b.clientY - a.clientY;
    const dist = Math.hypot(dx, dy);
    const newZoom = touchState.startZoom * (dist / touchState.startDist);
    setZoom(newZoom, touchState.cx, touchState.cy, false);
    e.preventDefault();
  }
}, { passive: false });

Viewport.addEventListener('touchend', (e) => {
  if (touchState && touchState.mode === 'pan' && !touchState.moved) {
    HiddenInput.focus();
  }
  touchState = null;
});

// ─────────── ink character insertion ───────────
// Insert one char into a specific page-inner. Returns the wrapper span (or
// the leading span for newlines, which spawn a paired hard-break sibling).
function appendChar(pageInner, ch, animate) {
  if (ch === '\n') {
    const span = document.createElement('span');
    span.className = 'ink-char newline';
    pageInner.appendChild(span);
    const br = document.createElement('span');
    br.className = 'ink-char hard-break';
    br.innerHTML = '<br>';
    pageInner.appendChild(br);
    return span;
  }
  if (ch === ' ') {
    const span = document.createElement('span');
    span.className = 'ink-char space';
    span.textContent = ' ';
    pageInner.appendChild(span);
    return span;
  }
  const span = document.createElement('span');
  span.className = 'ink-char';
  const glyph = document.createElement('span');
  glyph.className = 'ink-glyph';
  glyph.textContent = ch;
  span.appendChild(glyph);
  pageInner.appendChild(span);
  if (animate) {
    const font = window.__book.fontDb[window.__book.font];
    const dur  = window.__book.inkMs || 80;
    const ink  = window.__book.ink;
    const traced = font ? startInkTrace(glyph, ch, font, ink, dur) : false;
    if (!traced) animateGlyphInk(glyph);   // fallback to scaleX wipe
  }
  return span;
}

// ─────────── opentype.js: real per-glyph ink trace ───────────
// We overlay an SVG path (from the loaded WOFF2) on the rendered glyph,
// animate stroke-dashoffset from full length to 0 over ~80ms, then fade
// the SVG out as the underlying text fades back in. Falls back silently
// to the scaleX wipe (animateGlyphInk) when opentype.js isn't ready or
// can't parse the requested font.
// Fontsource serves the same Google fonts as TTF (which opentype.js parses
// natively, no Brotli needed). The Google CDN serves WOFF2 only, and the
// CDN-hosted opentype.min.js doesn't bundle a Brotli decoder.
const FONTSOURCE_SLUGS = {
  'EB Garamond':       'eb-garamond',
  'Cormorant Garamond':'cormorant-garamond',
  'IM Fell English':   'im-fell-english',
  'Spectral':          'spectral',
};

async function loadFontForInkTrace(family) {
  if (typeof opentype === 'undefined') return null;
  if (window.__book.fontDb[family]) return window.__book.fontDb[family];
  const slug = FONTSOURCE_SLUGS[family];
  if (!slug) { console.warn('book: no fontsource slug for', family); return null; }
  try {
    const url = `https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-400-normal.ttf`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('http ' + res.status);
    const buf = await res.arrayBuffer();
    const font = opentype.parse(buf);
    window.__book.fontDb[family] = font;
    return font;
  } catch (e) {
    console.warn('book: ink-trace font load failed for', family, e);
    return null;
  }
}

function startInkTrace(glyph, ch, font, inkColor, durationMs) {
  if (!font) return false;
  try {
    const fontSize = parseFloat(getComputedStyle(glyph).fontSize);
    const otGlyph = font.charToGlyph(ch);
    if (!otGlyph || !otGlyph.path) return false;
    const path = otGlyph.getPath(0, 0, fontSize);
    const d = path.toPathData(2);
    if (!d || d.length < 4) return false;

    // viewBox aligned to font metrics so SVG y=0 == text baseline.
    const ascentPx  =  font.ascender  / font.unitsPerEm * fontSize;
    const descentPx = -font.descender / font.unitsPerEm * fontSize;
    const advWidth  = (otGlyph.advanceWidth || 500) / font.unitsPerEm * fontSize;

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('class', 'ink-trace');
    svg.setAttribute('viewBox', `0 ${-ascentPx} ${advWidth || 1} ${ascentPx + descentPx}`);
    svg.setAttribute('preserveAspectRatio', 'none');

    const pathEl = document.createElementNS(svgNs, 'path');
    pathEl.setAttribute('d', d);
    pathEl.setAttribute('fill', 'none');
    pathEl.setAttribute('stroke', inkColor);
    pathEl.setAttribute('stroke-width', String(fontSize * 0.06));
    pathEl.setAttribute('stroke-linecap', 'round');
    pathEl.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(pathEl);

    glyph.style.color = 'transparent';
    glyph.appendChild(svg);

    let total;
    try { total = pathEl.getTotalLength(); } catch { total = 0; }
    if (!total || total < 1) {
      // Path has no length (e.g. spaces sneaking in) — revert.
      svg.remove();
      glyph.style.color = '';
      return false;
    }
    pathEl.style.strokeDasharray  = total;
    pathEl.style.strokeDashoffset = total;

    const anim = pathEl.animate(
      [{ strokeDashoffset: total }, { strokeDashoffset: 0 }],
      { duration: durationMs, fill: 'forwards', easing: 'ease-out' }
    );

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      glyph.style.color = '';
      svg.style.transition = 'opacity 110ms ease-out';
      svg.style.opacity = '0';
      setTimeout(() => { if (svg.parentNode) svg.remove(); }, 130);
    };
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
    setTimeout(cleanup, durationMs + 240);  // safety net
    return true;
  } catch (e) {
    return false;
  }
}

// Current scaleX wipe — kept as the FALLBACK path. Used when opentype.js
// isn't ready, when a glyph has no path data, or for any other failure
// mode. Same WAAPI mechanic as before.
function animateGlyphInk(glyph) {
  const anim = glyph.animate(
    [
      { transform: 'scaleX(0)',    filter: 'blur(1.8px)', opacity: 0.75, offset: 0 },
      { transform: 'scaleX(1.06)', filter: 'blur(1.2px)', opacity: 1.0,  offset: 0.18 },
      { transform: 'scaleX(1.0)',  filter: 'blur(0.6px)', opacity: 1.0,  offset: 0.45 },
      { transform: 'scaleX(1.0)',  filter: 'blur(0)',     opacity: 1.0,  offset: 1 },
    ],
    { duration: 520, fill: 'forwards', easing: 'linear' }
  );
  setTimeout(() => {
    if (anim.playState !== 'finished') anim.cancel();
  }, 800);
}

// Remove the trailing ink-char on a page (and the paired hard-break for
// newlines). Skips #caret. Returns true if something was removed.
function popLastCharFromPage(pageInner) {
  // walk backwards to find the last ink-char that isn't the caret div
  for (let i = pageInner.children.length - 1; i >= 0; i--) {
    const el = pageInner.children[i];
    if (el === Caret) continue;
    if (!el.classList.contains('ink-char')) continue;
    if (el.classList.contains('hard-break')) {
      el.remove();
      // also remove the preceding newline span
      for (let j = pageInner.children.length - 1; j >= 0; j--) {
        const prev = pageInner.children[j];
        if (prev === Caret) continue;
        if (prev.classList.contains('newline')) { prev.remove(); break; }
        break;
      }
    } else {
      el.remove();
    }
    return true;
  }
  return false;
}

// Empty a page-inner while preserving the #caret child (so its DOM
// attachment survives a re-layout).
function emptyPage(pageInner) {
  const toRemove = [];
  for (const el of pageInner.children) {
    if (el !== Caret) toRemove.push(el);
  }
  toRemove.forEach(el => el.remove());
}

// Move the #caret div into a specific page-inner (no-op if already there).
function attachCaretTo(pageInner) {
  if (Caret.parentElement !== pageInner) {
    pageInner.appendChild(Caret);
  }
}

// Get the visible primary spans on a page (one per buffer char — excludes
// the paired hard-break sibling and the caret div).
function getPrimarySpans(pageInner) {
  const out = [];
  for (const el of pageInner.children) {
    if (el === Caret) continue;
    if (!el.classList.contains('ink-char')) continue;
    if (el.classList.contains('hard-break')) continue;
    out.push(el);
  }
  return out;
}

// Number of buffer chars currently rendered on a page.
function countCharsInPage(pageInner) {
  return getPrimarySpans(pageInner).length;
}

// Rebuild the global charSpans array from the currently rendered DOM.
// One entry per buffer char in spread order (left page first, then right).
function refreshCharSpans() {
  charSpans = getPrimarySpans(LeftPage).concat(getPrimarySpans(RightPage));
}

// ─────────── layout: page filling + spread bookkeeping ───────────
// fillPage: insert chars from `text` until overflow. Returns count consumed.
// Used both for visible layout and offscreen probing. Preserves #caret
// when emptying the visible pages.
function fillPage(pageInner, text) {
  emptyPage(pageInner);
  let i = 0;
  while (i < text.length) {
    appendChar(pageInner, text[i], false);
    if (pageInner.scrollHeight > pageInner.clientHeight + 1) {
      popLastCharFromPage(pageInner);
      return i;
    }
    i++;
  }
  return text.length;
}

// Render spreads[idx] into the visible left/right pages.
function layoutSpread(idx) {
  const sp = spreads[idx];
  if (!sp) return;
  const slice = textBuffer.slice(sp.start, sp.end);
  const leftCount = fillPage(LeftPage, slice);
  fillPage(RightPage, slice.slice(leftCount));
  refreshCharSpans();
  // Active page = whichever holds the trailing edge.
  activePageEl = countCharsInPage(RightPage) > 0 ? RightPage : LeftPage;
  // Reattach caret if it got detached during a previous layout cycle.
  if (!Caret.parentElement) attachCaretTo(activePageEl);
}

// Walk the full buffer offscreen and rebuild the spreads[] index. Cheap
// because it runs only on font/size changes and persistence flushes.
function rebuildSpreads() {
  const probeL = makeProbe(LeftPage);
  const probeR = makeProbe(RightPage);
  const result = [];
  let pos = 0;
  if (textBuffer.length === 0) {
    result.push({ start: 0, end: 0 });
  } else {
    while (pos < textBuffer.length) {
      const rest = textBuffer.slice(pos);
      const lc = fillPage(probeL, rest);
      const rc = fillPage(probeR, rest.slice(lc));
      const consumed = lc + rc;
      if (consumed === 0) break;  // safety: a single char too big for a page
      result.push({ start: pos, end: pos + consumed });
      pos += consumed;
    }
  }
  probeL.remove();
  probeR.remove();
  spreads = result;
  if (currentSpread >= spreads.length) currentSpread = spreads.length - 1;
  if (currentSpread < 0) currentSpread = 0;
  layoutSpread(currentSpread);
  updatePageIndicator();
}

// Make a hidden offscreen clone of a page-inner for measurement.
function makeProbe(template) {
  const probe = document.createElement('div');
  probe.className = template.className;
  probe.style.cssText =
    `position:fixed; left:-100000px; top:0; visibility:hidden; ` +
    `width:${template.clientWidth}px; height:${template.clientHeight}px; ` +
    `padding:0; box-sizing:border-box;` +
    // copy the computed type so measurements match the visible page
    `font-family:${getComputedStyle(template).fontFamily}; ` +
    `font-size:${getComputedStyle(template).fontSize}; ` +
    `line-height:${getComputedStyle(template).lineHeight}; ` +
    `letter-spacing:${getComputedStyle(template).letterSpacing}; ` +
    `word-wrap:break-word; overflow-wrap:break-word; overflow:hidden;`;
  document.body.appendChild(probe);
  return probe;
}

function updatePageIndicator() {
  if (PageIndicator) {
    PageIndicator.innerHTML = `spread <b>${currentSpread + 1}</b> of ${spreads.length}`;
  }
  dispatchEvent(new CustomEvent('book:spread-changed', {
    detail: { current: currentSpread, total: spreads.length },
  }));
}

// ─────────── hot path: append/remove while typing ───────────
// Append `ch` to the buffer's CURRENT spread end. Caller updates
// textBuffer AFTER this returns (so startNewSpread sees the pre-char
// length).
function appendLiveChar(ch) {
  appendChar(activePageEl, ch, true);
  if (activePageEl.scrollHeight > activePageEl.clientHeight + 1) {
    popLastCharFromPage(activePageEl);
    if (activePageEl === LeftPage) {
      activePageEl = RightPage;
      attachCaretTo(RightPage);
      appendChar(activePageEl, ch, true);
      if (activePageEl.scrollHeight > activePageEl.clientHeight + 1) {
        popLastCharFromPage(activePageEl);
        startNewSpread(ch);
      }
    } else {
      startNewSpread(ch);
    }
  }
  refreshCharSpans();
}

// Commit the current spread's end at the current buffer position, push a
// fresh spread, clear pages (preserving caret div), and seat the char at
// the start of the new spread.
// NOTE: caller ensures textBuffer does NOT yet include `ch` so the spread
// boundary lands cleanly at the buffer position before this char.
function startNewSpread(ch) {
  spreads[currentSpread].end = textBuffer.length;
  currentSpread++;
  spreads.push({ start: textBuffer.length, end: textBuffer.length });
  emptyPage(LeftPage);
  emptyPage(RightPage);
  activePageEl = LeftPage;
  attachCaretTo(LeftPage);
  appendChar(activePageEl, ch, true);
  updatePageIndicator();
}

function removeLiveLastChar() {
  // try active page first
  if (popLastCharFromPage(activePageEl)) {
    refreshCharSpans();
    return;
  }
  // active page empty: if we're on right, fall back to left
  if (activePageEl === RightPage) {
    activePageEl = LeftPage;
    if (popLastCharFromPage(activePageEl)) {
      refreshCharSpans();
      return;
    }
  }
  // both pages empty — go back a spread if possible
  if (currentSpread > 0) {
    spreads.pop();
    currentSpread--;
    layoutSpread(currentSpread);
    updatePageIndicator();
    removeLiveLastChar();   // pop the actual trailing char from the prior spread
  }
}

// ─────────── caret / quill positioning ───────────
// Caret lives inside the active .page-inner so it inherits the 3D tilt.
// We use offsetLeft/offsetTop of the relevant span — these are local CSS
// pixels (untransformed) relative to the page-inner, which is exactly
// what caret.style.left/top wants. The page's 3D rotation applies equally
// to caret and span at render time, so they coincide perfectly on screen.
function updateCaret() {
  const sp = spreads[currentSpread];
  if (!sp) return;
  const localOffset = Math.max(0, Math.min(sp.end - sp.start, caretIndex - sp.start));

  // Which page does the caret live on?
  const leftCount = countCharsInPage(LeftPage);
  let targetPage, idxInPage;
  if (localOffset <= leftCount) {
    targetPage = LeftPage;
    idxInPage = localOffset;
  } else {
    targetPage = RightPage;
    idxInPage = localOffset - leftCount;
  }
  attachCaretTo(targetPage);

  const cs = getComputedStyle(targetPage);
  const padL = parseFloat(cs.paddingLeft);
  const padT = parseFloat(cs.paddingTop);
  const lineH = parseFloat(cs.lineHeight) || (parseFloat(cs.fontSize) * 1.6);

  let left, top;

  if (idxInPage === 0) {
    // Start of page — nib at the top-left corner of the writing area
    left = padL;
    top  = padT;
  } else {
    const spans = getPrimarySpans(targetPage);
    const lastSpan = spans[idxInPage - 1];
    if (!lastSpan) { left = padL; top = padT; }
    else if (lastSpan.classList.contains('newline')) {
      // After a hard newline, jump to the start of the next visual line.
      left = padL;
      top  = lastSpan.offsetTop + lineH;
    } else {
      // Sit nib at the right edge of the previous char, on its top line.
      left = lastSpan.offsetLeft + lastSpan.offsetWidth;
      top  = lastSpan.offsetTop;
    }
  }

  Caret.style.left = left + 'px';
  Caret.style.top  = top  + 'px';
  Caret.style.height = lineH + 'px';
}

// Find which spread a buffer offset belongs to; switch and re-layout if
// it isn't the current one.
function ensureSpreadForOffset(offset) {
  if (spreads[currentSpread] &&
      offset >= spreads[currentSpread].start &&
      offset <= spreads[currentSpread].end) return;
  for (let i = 0; i < spreads.length; i++) {
    if (offset >= spreads[i].start && offset <= spreads[i].end) {
      currentSpread = i;
      layoutSpread(currentSpread);
      updatePageIndicator();
      return;
    }
  }
}

// ─────────── selection highlight (warm wash on selected chars) ───────────
function updateSelectionHighlight() {
  // Clear previous highlight
  document.querySelectorAll('.ink-selected').forEach(el => el.classList.remove('ink-selected'));
  const s0 = HiddenInput.selectionStart;
  const s1 = HiddenInput.selectionEnd;
  if (s0 === s1) return;
  const sp = spreads[currentSpread];
  if (!sp) return;
  const localStart = Math.max(0, s0 - sp.start);
  const localEnd   = Math.min(sp.end - sp.start, s1 - sp.start);
  if (localStart >= localEnd) return;
  refreshCharSpans();
  for (let i = localStart; i < localEnd && i < charSpans.length; i++) {
    if (charSpans[i]) charSpans[i].classList.add('ink-selected');
  }
}

// ─────────── input handling ───────────
// Positional diff: find common prefix and suffix between the old buffer
// and the new textarea value, identify the removed slice and the added
// slice. Fast path for pure append/remove at the end; slow path for any
// mid-buffer edit (re-layout from scratch via rebuildSpreads).
HiddenInput.addEventListener('input', () => {
  const v = HiddenInput.value;
  const newSelStart = HiddenInput.selectionStart;

  if (v !== textBuffer) {
    let p = 0;
    while (p < v.length && p < textBuffer.length && v[p] === textBuffer[p]) p++;
    let sB = textBuffer.length, sN = v.length;
    while (sB > p && sN > p && v[sN - 1] === textBuffer[sB - 1]) { sB--; sN--; }
    const removed = textBuffer.slice(p, sB);
    const added   = v.slice(p, sN);

    const isAppendAtEnd  = (p === textBuffer.length && removed.length === 0);
    const isRemoveFromEnd = (sN === v.length && added.length === 0 && sB === textBuffer.length);

    if (isAppendAtEnd && added.length > 0) {
      for (const ch of added) {
        appendLiveChar(ch);
        textBuffer += ch;
        spreads[currentSpread].end = textBuffer.length;
      }
    } else if (isRemoveFromEnd && removed.length > 0) {
      for (let i = 0; i < removed.length; i++) {
        removeLiveLastChar();
        textBuffer = textBuffer.slice(0, -1);
        if (spreads[currentSpread]) spreads[currentSpread].end = textBuffer.length;
      }
    } else {
      // Mid-buffer edit — slow path: re-layout from scratch.
      textBuffer = v;
      rebuildSpreads();
    }
  }

  caretIndex = newSelStart;
  ensureSpreadForOffset(caretIndex);

  if (textBuffer.length > 0) {
    HintEl.style.display = 'none';
    HintEl.classList.add('hidden');
  } else {
    HintEl.style.display = '';
    HintEl.classList.remove('hidden');
  }
  if (!firstInputDone) {
    firstInputDone = true;
    document.querySelectorAll('.chrome').forEach(c => c.classList.add('faded'));
  }
  updatePageIndicator();
  updateCaret();
  updateSelectionHighlight();
  markUnsaved();
});

// ─────────── arrow keys ───────────
// Left/Right/Home/End: let the textarea move its own selection natively,
// then sync caretIndex and switch spread if we crossed a boundary.
// Up/Down: probe the position one line above/below the current caret via
// caretRangeFromPoint, since textarea Up/Down moves between textarea
// lines (one big line per buffer line) not visual lines on our pages.
HiddenInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const caretRect = Caret.getBoundingClientRect();
    const pageRect = activePageEl.getBoundingClientRect();
    const cs = getComputedStyle(activePageEl);
    const lineH = parseFloat(cs.lineHeight) || 48;
    // Caret is zero-size — use its top-left as probe x, midline as y.
    const probeX = caretRect.left;
    const probeY = caretRect.top + (e.key === 'ArrowUp' ? -lineH * 0.6 : lineH * 1.4);

    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(probeX, probeY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(probeX, probeY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (!range) return;
    const offset = bufferOffsetFromRange(range);
    if (offset !== null) {
      caretIndex = offset;
      HiddenInput.setSelectionRange(offset, offset);
      ensureSpreadForOffset(caretIndex);
      updateCaret();
      updateSelectionHighlight();
    }
  }
});

HiddenInput.addEventListener('keyup', (e) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
    caretIndex = HiddenInput.selectionStart;
    ensureSpreadForOffset(caretIndex);
    updateCaret();
    updateSelectionHighlight();
  }
});

// Walk up from a Range's startContainer to its parent .ink-char, look up
// its position in charSpans, and return a buffer offset. Returns null if
// the range isn't inside a writable area.
function bufferOffsetFromRange(range) {
  let node = range.startContainer;
  while (node && node.nodeType === 3) node = node.parentNode;       // text → element
  while (node && !(node.classList && node.classList.contains('ink-char'))) {
    if (node === LeftPage || node === RightPage) break;
    node = node.parentNode;
  }
  refreshCharSpans();
  if (node && node.classList && node.classList.contains('ink-char')) {
    const idx = charSpans.indexOf(node);
    if (idx >= 0) return spreads[currentSpread].start + idx + 1;  // after this char
  }
  // clicked on a page-inner's empty area — end of spread
  return spreads[currentSpread].end;
}

// ─────────── click-to-position ───────────
function handlePageClick(e) {
  let range = null;
  if (document.caretRangeFromPoint) {
    range = document.caretRangeFromPoint(e.clientX, e.clientY);
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
    if (pos) {
      range = document.createRange();
      range.setStart(pos.offsetNode, pos.offset);
    }
  }
  let offset;
  if (range) {
    let node = range.startContainer;
    while (node && node.nodeType === 3) node = node.parentNode;
    let charSpan = null;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains('ink-char') && !node.classList.contains('hard-break')) {
        charSpan = node;
        break;
      }
      node = node.parentNode;
    }
    refreshCharSpans();
    if (charSpan) {
      const idx = charSpans.indexOf(charSpan);
      if (idx >= 0) {
        const r = charSpan.getBoundingClientRect();
        const before = e.clientX < r.left + r.width / 2;
        offset = spreads[currentSpread].start + idx + (before ? 0 : 1);
      }
    }
  }
  if (offset === undefined) offset = spreads[currentSpread].end;

  caretIndex = offset;
  HiddenInput.focus();
  HiddenInput.setSelectionRange(offset, offset);
  ensureSpreadForOffset(caretIndex);
  updateCaret();
  updateSelectionHighlight();
}

LeftPage.addEventListener('click', handlePageClick);
RightPage.addEventListener('click', handlePageClick);

// HiddenInput focus / blur — toggle dormant state on the quill.
HiddenInput.addEventListener('focus', () => Caret.classList.remove('dormant'));
HiddenInput.addEventListener('blur',  () => Caret.classList.add('dormant'));

// keep textarea focused with caret at end
HiddenInput.addEventListener('blur', () => {
  // refocus on next mouse click — handled by viewport click
});

// ─────────── persistence (localStorage autosave) ───────────
const STORAGE_KEY = 'fireplace.book.v1';
const SAVE_DEBOUNCE_MS = 300;
let saveTimer = null;
let lastSaveAt = 0;
let statusRefreshTimer = null;

function setStatusDot(color) {
  const dot = document.querySelector('.status-dot');
  if (dot) dot.style.background = color;
}

function markUnsaved() {     // legacy name preserved — used by onInput
  StatusText.textContent = 'writing…';
  setStatusDot('#e8b669');
  schedulePersist();
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, SAVE_DEBOUNCE_MS);
}

function persistNow() {
  const payload = {
    v: 1,
    buffer: textBuffer,
    currentSpread,
    settings: {
      font: window.__book.font,
      size: window.__book.size,
      ink:  window.__book.ink,
    },
    savedAt: Date.now(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    lastSaveAt = payload.savedAt;
    updateSavedStatus();
  } catch (e) {
    StatusText.textContent = 'save failed';
    setStatusDot('#e86969');
  }
}

function updateSavedStatus() {
  if (!lastSaveAt) return;
  const ago = Date.now() - lastSaveAt;
  let label;
  if      (ago <    3000) label = 'saved · just now';
  else if (ago <   60000) label = `saved · ${Math.floor(ago / 1000)}s ago`;
  else if (ago < 3600000) label = `saved · ${Math.floor(ago / 60000)}m ago`;
  else                    label = `saved · ${Math.floor(ago / 3600000)}h ago`;
  StatusText.textContent = label;
  setStatusDot('#6ed09a');
}

function restoreFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (data.v !== 1) return false;
    textBuffer = data.buffer || '';
    HiddenInput.value = textBuffer;
    if (data.settings) {
      if (data.settings.font) window.__book.setFont(data.settings.font);
      if (data.settings.size) window.__book.setSize(data.settings.size);
      if (data.settings.ink)  window.__book.setInk(data.settings.ink);
    }
    rebuildSpreads();
    currentSpread = Math.max(0, Math.min(spreads.length - 1, data.currentSpread || 0));
    layoutSpread(currentSpread);
    caretIndex = Math.min(textBuffer.length, spreads[currentSpread].end);
    HiddenInput.setSelectionRange(caretIndex, caretIndex);
    updateCaret();
    updatePageIndicator();
    lastSaveAt = data.savedAt || 0;
    updateSavedStatus();
    if (textBuffer.length > 0) {
      HintEl.style.display = 'none';
      HintEl.classList.add('hidden');
    }
    return true;
  } catch (e) {
    console.warn('book: restore failed', e);
    return false;
  }
}

// ─────────── page navigation + flip ───────────
let flipInFlight = false;

function goToSpread(targetIdx) {
  if (flipInFlight) return;
  const clamped = Math.max(0, Math.min(spreads.length - 1, targetIdx));
  if (clamped === currentSpread) return;
  const direction = clamped > currentSpread ? 'forward' : 'back';
  flipInFlight = true;

  // Snapshot the page that's turning, animate it on top of everything,
  // then swap in the destination behind it. Caret moves with the new spread.
  const flipP = animatePageFlip(direction);

  setTimeout(() => {
    currentSpread = clamped;
    layoutSpread(currentSpread);
    const sp = spreads[currentSpread];
    caretIndex = direction === 'forward' ? sp.start : sp.end;
    HiddenInput.setSelectionRange(caretIndex, caretIndex);
    if (direction === 'forward') {
      attachCaretTo(LeftPage);
      activePageEl = LeftPage;
    } else {
      const last = countCharsInPage(RightPage) > 0 ? RightPage : LeftPage;
      attachCaretTo(last);
      activePageEl = last;
    }
    updateCaret();
    updatePageIndicator();
    dispatchEvent(new CustomEvent('book:spread-changed', {
      detail: { current: currentSpread, total: spreads.length },
    }));
  }, 100);

  flipP.then(() => { flipInFlight = false; HiddenInput.focus(); });
}

function animatePageFlip(direction) {
  return new Promise((resolve) => {
    const original = direction === 'forward'
      ? document.querySelector('.page-right')
      : document.querySelector('.page-left');
    const clone = original.cloneNode(true);
    // Strip IDs from the entire clone subtree — cloneNode copies them and
    // we don't want duplicate #caret / #page-left-inner / etc. in the DOM.
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
    clone.classList.add('flipping-page', direction === 'forward' ? 'from-right' : 'from-left');
    SpreadEl.appendChild(clone);
    const startDeg = direction === 'forward' ? -10 : 10;
    const endDeg   = direction === 'forward' ? -180 : 180;
    const anim = clone.animate(
      [
        { transform: `rotateY(${startDeg}deg)`, boxShadow: '0 4px 12px rgba(0,0,0,0.0)' },
        { transform: `rotateY(${(startDeg + endDeg) / 2}deg)`,
          boxShadow: `${direction === 'forward' ? '-' : ''}14px 18px 36px rgba(0,0,0,0.45)`,
          offset: 0.5 },
        { transform: `rotateY(${endDeg}deg)`, boxShadow: '0 4px 12px rgba(0,0,0,0.08)' },
      ],
      { duration: 700, easing: 'cubic-bezier(0.42, 0, 0.20, 1)', fill: 'forwards' }
    );
    let resolved = false;
    const cleanup = () => {
      if (resolved) return;
      resolved = true;
      if (clone.parentNode) clone.remove();
      resolve();
    };
    anim.onfinish = cleanup;
    anim.oncancel = cleanup;
    // Defensive backup — if WAAPI never fires its callbacks (rare, e.g.
    // tab backgrounding), force-remove the clone after duration + slack.
    setTimeout(cleanup, 900);
  });
}

function eraseAllData() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  lastSaveAt = 0;
  location.reload();
}
window.__eraseBook = eraseAllData;

// Reveal chrome on mouse near edges or on any movement after typing
let chromeRevealTimer = null;
function revealChrome() {
  document.querySelectorAll('.chrome').forEach(c => c.classList.remove('faded'));
  clearTimeout(chromeRevealTimer);
  chromeRevealTimer = setTimeout(() => {
    if (firstInputDone) {
      document.querySelectorAll('.chrome').forEach(c => c.classList.add('faded'));
    }
  }, 2400);
}
window.addEventListener('mousemove', (e) => {
  // only reveal if mouse is near top/bottom edge or chrome
  if (e.clientY < 80 || e.clientY > window.innerHeight - 80) revealChrome();
});

// shortcut chip — show briefly on load
setTimeout(() => {
  ShortcutChip.classList.add('visible');
  setTimeout(() => ShortcutChip.classList.remove('visible'), 5200);
}, 700);

// ─────────── toolbar buttons ───────────
document.getElementById('btn-zoom-in').addEventListener('click', () => {
  setZoom(zoom * 1.25, window.innerWidth/2, window.innerHeight/2, true);
});
document.getElementById('btn-zoom-out').addEventListener('click', () => {
  setZoom(zoom / 1.25, window.innerWidth/2, window.innerHeight/2, true);
});
document.getElementById('btn-zoom-reset').addEventListener('click', () => {
  resetView();
});
document.getElementById('btn-prev').addEventListener('click', () => goToSpread(currentSpread - 1));
document.getElementById('btn-next').addEventListener('click', () => goToSpread(currentSpread + 1));
function clearBook() {
  HiddenInput.value = '';
  textBuffer = '';
  caretIndex = 0;
  emptyPage(LeftPage);
  emptyPage(RightPage);
  charSpans = [];
  spreads = [{ start: 0, end: 0 }];
  currentSpread = 0;
  activePageEl = LeftPage;
  attachCaretTo(LeftPage);
  HintEl.style.display = '';
  HintEl.classList.remove('hidden');
  HiddenInput.focus();
  updatePageIndicator();
  updateCaret();
}
document.getElementById('btn-clear').addEventListener('click', () => {
  clearBook();
  resetView();
});

// ─────────── demo passage ───────────
const SAMPLE_PASSAGE =
"At the threshold of the year, where the candles bend toward midnight, " +
"I find myself again at this page. The fire keeps its quiet counsel; the dog " +
"turns once in his sleep; the house exhales. I have nothing urgent to say — " +
"only that the ink is wet, the hour is mine, and the night turns slowly with me.";

let demoActive = false;
document.getElementById('btn-sample').addEventListener('click', () => {
  if (demoActive) return;
  demoActive = true;
  clearBook();
  resetView();
  let i = 0;
  const tick = () => {
    if (i >= SAMPLE_PASSAGE.length) {
      demoActive = false;
      return;
    }
    const ch = SAMPLE_PASSAGE[i];
    HiddenInput.value += ch;
    HiddenInput.dispatchEvent(new Event('input'));
    i++;
    // variable, slightly clumpy timing — feels written, not typed
    let delay;
    if (ch === ' ') delay = 50 + Math.random() * 60;
    else if (ch === '.' || ch === ',' || ch === ';') delay = 240 + Math.random() * 160;
    else delay = 38 + Math.random() * 65;
    setTimeout(tick, delay);
  };
  tick();
});

// ─────────── tweaks toggle ───────────
document.getElementById('btn-tweaks').addEventListener('click', () => {
  if (window.__toggleTweaks) window.__toggleTweaks();
});

// ─────────── init ───────────
fitStage();
restoreFromStorage();
updatePageIndicator();
updateCaret();
HiddenInput.focus();

// Re-position the caret once fonts and layout have settled
setTimeout(() => { updateCaret(); }, 50);
setTimeout(() => { updateCaret(); }, 250);
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { rebuildSpreads(); updateCaret(); });
}

// Refresh the "saved · Xs ago" label every 5s so the time stays current.
statusRefreshTimer = setInterval(updateSavedStatus, 5000);

// Kick off opentype.js font loading for the default font. Subsequent
// chars get the real path trace; until it resolves, the scaleX fallback
// covers gracefully.
loadFontForInkTrace(window.__book.font);

// expose helpers for tweaks panel
window.__updateCaret    = updateCaret;
window.__rebuildSpreads = rebuildSpreads;
window.__goToSpread     = goToSpread;
window.__getSpreadInfo  = () => ({ current: currentSpread, total: spreads.length });

})();
