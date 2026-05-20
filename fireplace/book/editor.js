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
let charSpans = [];                           // visible spans on the current spread
let spreads = [{ start: 0, end: 0 }];         // [{start, end}] indexes into textBuffer
let currentSpread = 0;
let activePageEl = LeftPage;                  // page receiving live typing
let firstInputDone = false;

// settings (mirrored to Tweaks panel)
window.__book = {
  font: 'EB Garamond',
  size: 30,
  ink: '#2a1808',
  setFont(f) {
    this.font = f;
    LeftPage.style.fontFamily = `'${f}', Georgia, serif`;
    RightPage.style.fontFamily = `'${f}', Georgia, serif`;
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
  if (animate) animateGlyphInk(glyph);
  return span;
}

// Current ink-trace effect — scaleX wipe + blur settle via WAAPI. Phase D
// will replace this with per-glyph SVG path tracing (opentype.js); this
// stays as the fallback path.
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
// newlines). Returns true if something was removed.
function popLastCharFromPage(pageInner) {
  const last = pageInner.lastElementChild;
  if (!last) return false;
  if (last.classList.contains('hard-break')) {
    last.remove();
    const prev = pageInner.lastElementChild;
    if (prev && prev.classList.contains('newline')) prev.remove();
  } else {
    last.remove();
  }
  return true;
}

// Rebuild the global charSpans array from the currently rendered DOM.
// Used for caret math (Phase A keeps the simple last-span approach).
function refreshCharSpans() {
  charSpans = [];
  for (const el of LeftPage.children) {
    if (el.classList.contains('ink-char')) charSpans.push(el);
  }
  for (const el of RightPage.children) {
    if (el.classList.contains('ink-char')) charSpans.push(el);
  }
}

// ─────────── layout: page filling + spread bookkeeping ───────────
// fillPage: insert chars from `text` until overflow. Returns count consumed.
// Used both for visible layout and offscreen probing.
function fillPage(pageInner, text) {
  pageInner.innerHTML = '';
  let i = 0;
  while (i < text.length) {
    appendChar(pageInner, text[i], false);
    if (pageInner.scrollHeight > pageInner.clientHeight + 1) {
      // overflow — pop the last char (and trailing hard-break if newline)
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
  // active page = whichever has the trailing edge of this spread
  activePageEl = RightPage.lastElementChild ? RightPage : LeftPage;
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
  if (!PageIndicator) return;
  PageIndicator.innerHTML = `spread <b>${currentSpread + 1}</b> of ${spreads.length}`;
}

// ─────────── hot path: append/remove while typing ───────────
function appendLiveChar(ch) {
  const span = appendChar(activePageEl, ch, true);
  if (activePageEl.scrollHeight > activePageEl.clientHeight + 1) {
    // overflow on active page — pop and try the next page
    popLastCharFromPage(activePageEl);
    if (activePageEl === LeftPage) {
      activePageEl = RightPage;
      appendChar(activePageEl, ch, true);
      if (activePageEl.scrollHeight > activePageEl.clientHeight + 1) {
        // right page also overflowed — start a new spread
        popLastCharFromPage(activePageEl);
        startNewSpread(ch);
      }
    } else {
      // right page overflowed — start a new spread
      startNewSpread(ch);
    }
  }
  refreshCharSpans();
}

// Commit the current spread's end at the current buffer position, push a
// fresh spread, clear pages, and seat the char at the start of the new spread.
function startNewSpread(ch) {
  spreads[currentSpread].end = textBuffer.length;  // textBuffer not yet updated to include ch
  currentSpread++;
  spreads.push({ start: textBuffer.length, end: textBuffer.length });
  LeftPage.innerHTML = '';
  RightPage.innerHTML = '';
  activePageEl = LeftPage;
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
// Phase A keeps the original last-char-rect approach — caret will drift
// slightly under the page tilt (pages are 3D-rotated but #caret is at
// #book level). Phase B replaces this with a Range probe inside the page.
function updateCaret() {
  let last = null;
  for (let i = charSpans.length - 1; i >= 0; i--) {
    const s = charSpans[i];
    if (!s.classList.contains('newline') && !s.classList.contains('hard-break')) { last = s; break; }
  }
  const bookRect = Book.getBoundingClientRect();
  const scale = fitScale * zoom;
  let x, y;
  if (last) {
    const r = last.getBoundingClientRect();
    x = (r.right  - bookRect.left) / scale;
    y = (r.bottom - bookRect.top)  / scale;
  } else {
    // empty book — park nib at the start of the left page's first line
    const pageRect = LeftPage.getBoundingClientRect();
    const fs = parseFloat(getComputedStyle(LeftPage).fontSize);
    const leading = parseFloat(getComputedStyle(LeftPage).lineHeight) || (fs * 1.6);
    const padL = parseFloat(getComputedStyle(LeftPage).paddingLeft);
    const padT = parseFloat(getComputedStyle(LeftPage).paddingTop);
    x = (pageRect.left - bookRect.left) / scale + padL;
    y = (pageRect.top  - bookRect.top)  / scale + padT + leading * 0.78;
  }
  Caret.style.left = x + 'px';
  Caret.style.top  = y + 'px';
}

// ─────────── input handling ───────────
HiddenInput.addEventListener('input', () => {
  const v = HiddenInput.value;
  // Phase A: append/remove at end only (positional diff comes in Phase B)
  if (v.length > textBuffer.length) {
    const added = v.slice(textBuffer.length);
    for (const ch of added) {
      textBuffer += ch;             // commit BEFORE appendLiveChar so spread
      appendLiveChar(ch);           // splits use the right buffer length
    }
  } else if (v.length < textBuffer.length) {
    const removeCount = textBuffer.length - v.length;
    for (let i = 0; i < removeCount; i++) {
      textBuffer = textBuffer.slice(0, -1);
      removeLiveLastChar();
    }
  } else {
    textBuffer = v;
  }
  // mirror the trailing spread's end to the live buffer length
  if (spreads.length > 0) spreads[currentSpread].end = textBuffer.length;
  updatePageIndicator();
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
  updateCaret();
  markUnsaved();
});

// keep textarea focused with caret at end
HiddenInput.addEventListener('blur', () => {
  // refocus on next mouse click — handled by viewport click
});

// ─────────── chrome fade & save indicator ───────────
let savedTimer = null;
function markUnsaved() {
  StatusText.textContent = 'writing…';
  document.querySelector('.status-dot').style.background = '#e8b669';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    StatusText.textContent = 'saved · just now';
    document.querySelector('.status-dot').style.background = '#6ed09a';
  }, 900);
}

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
function clearBook() {
  HiddenInput.value = '';
  textBuffer = '';
  LeftPage.innerHTML = '';
  RightPage.innerHTML = '';
  charSpans = [];
  spreads = [{ start: 0, end: 0 }];
  currentSpread = 0;
  activePageEl = LeftPage;
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
updatePageIndicator();
updateCaret();
HiddenInput.focus();

// Re-position the caret once fonts and layout have settled
setTimeout(() => { updateCaret(); }, 50);
setTimeout(() => { updateCaret(); }, 250);
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => { updateCaret(); });
}

// expose helpers for tweaks panel
window.__updateCaret = updateCaret;
window.__rebuildSpreads = rebuildSpreads;

})();
