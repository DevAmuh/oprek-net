/* ═══════════════════════════════════════════════════════════════
   Fireplace · The Book — editor.js
   Phase A: camera (zoom/pan) + the contenteditable writing surface.
   Later phases add: SVG page-warp, quill cursor, ink trace,
   markdown live-render, font toggle, persistence, whimsy.
   ═══════════════════════════════════════════════════════════════ */

(() => {
'use strict';

// ─────────── elements ───────────
const Viewport     = document.getElementById('viewport');
const Camera       = document.getElementById('camera');
const Stage        = document.getElementById('stage');
const Book         = document.getElementById('book');
const TextFlow     = document.getElementById('text-flow');
const QuillCaret   = document.getElementById('quill-caret');
const HiddenHost   = document.getElementById('hidden-host');
const HintEl       = document.getElementById('hint');
const ZoomValue    = document.getElementById('zoom-value');
const StatusText   = document.getElementById('status-text');
const StatusDot    = document.querySelector('.status-dot');
const ShortcutChip = document.getElementById('shortcut-chip');

// ─────────── constants ───────────
const STAGE_W = 2730;
const STAGE_H = 1535;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 5;
const HOME_ZOOM = 1.55;

// ─────────── camera state ───────────
let zoom = HOME_ZOOM;
let panX = 0, panY = 0;
let fitScale = 1;
let firstInputDone = false;

// shared book state (built up across phases)
window.__book = {
  font: 'Cormorant Garamond',
  ink: '#2a1808',
  inkMs: 80,            // per-glyph ink-trace duration
};

// ─────────── camera ───────────
// Viewport size with fallbacks — innerWidth/innerHeight can momentarily be
// 0 before the layout viewport sizes (especially in headless contexts).
function vpW() { return window.innerWidth  || document.documentElement.clientWidth  || 1280; }
function vpH() { return window.innerHeight || document.documentElement.clientHeight || 800; }

function fitStage() {
  const pad = 80;
  fitScale = Math.min((vpW() - pad * 2) / STAGE_W, (vpH() - pad * 2) / STAGE_H);
  if (!(fitScale > 0)) fitScale = 0.3;
  applyCamera();
}

function applyCamera() {
  const scale = fitScale * zoom;
  const cx = (vpW() - STAGE_W * scale) / 2 + panX;
  const cy = (vpH() - STAGE_H * scale) / 2 + panY;
  Camera.style.transform = `translate3d(${cx}px, ${cy}px, 0) scale(${scale})`;
  ZoomValue.textContent = Math.round(zoom * 100) + '%';
}

function setZoom(target, anchorX, anchorY, animated) {
  target = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target));
  if (anchorX != null) {
    // keep the world point under the anchor stable
    const sb = fitScale * zoom;
    const sa = fitScale * target;
    const cxb = (vpW() - STAGE_W * sb) / 2 + panX;
    const cyb = (vpH() - STAGE_H * sb) / 2 + panY;
    const wx = (anchorX - cxb) / sb;
    const wy = (anchorY - cyb) / sb;
    panX = anchorX - wx * sa - (vpW() - STAGE_W * sa) / 2;
    panY = anchorY - wy * sa - (vpH() - STAGE_H * sa) / 2;
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

function resetView() {
  panX = 0;
  panY = 0;
  setZoom(HOME_ZOOM, null, null, true);
}

window.addEventListener('resize', fitStage);

// ─────────── wheel: ctrl=zoom · over-text=scroll · else=pan ───────────
Viewport.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    setZoom(zoom * Math.pow(1.0025, -e.deltaY), e.clientX, e.clientY, false);
    return;
  }
  // over the editable surface AND it can scroll → let the page scroll
  if (e.target.closest && e.target.closest('#text-flow')) {
    if (TextFlow.scrollHeight > TextFlow.clientHeight + 1) return;
  }
  e.preventDefault();
  panX -= e.deltaX;
  panY -= e.deltaY;
  applyCamera();
}, { passive: false });

// ─────────── mouse: alt / middle-button drag to pan ───────────
let dragging = false, dragOrigin = null, panOrigin = null;
Viewport.addEventListener('mousedown', (e) => {
  if (e.altKey || e.button === 1) {
    e.preventDefault();
    dragging = true;
    dragOrigin = { x: e.clientX, y: e.clientY };
    panOrigin  = { x: panX, y: panY };
    Viewport.classList.add('panning');
  } else if (e.button === 0) {
    const onChrome = e.target.closest && (e.target.closest('.chrome') || e.target.closest('.shortcut-chip'));
    const onText   = e.target.closest && e.target.closest('#text-flow');
    if (!onChrome && !onText) focusEditorAtEnd();
  }
});
window.addEventListener('mousemove', (e) => {
  if (dragging) {
    panX = panOrigin.x + (e.clientX - dragOrigin.x);
    panY = panOrigin.y + (e.clientY - dragOrigin.y);
    applyCamera();
  } else {
    Viewport.classList.toggle('pan-ready', e.altKey);
  }
});
window.addEventListener('mouseup', () => {
  dragging = false;
  Viewport.classList.remove('panning');
});
window.addEventListener('blur', () => {
  dragging = false;
  Viewport.classList.remove('panning');
});

// ─────────── touch: 1-finger pan, 2-finger pinch ───────────
let touchState = null;
Viewport.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    const onText = e.target.closest && e.target.closest('#text-flow');
    // starting on the text → let the browser place the caret; otherwise pan
    touchState = onText
      ? { mode: 'text' }
      : { mode: 'pan', x: e.touches[0].clientX, y: e.touches[0].clientY, panX, panY };
  } else if (e.touches.length === 2) {
    const [a, b] = e.touches;
    touchState = {
      mode: 'pinch',
      startDist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY),
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
    applyCamera();
    e.preventDefault();
  } else if (touchState.mode === 'pinch' && e.touches.length === 2) {
    const [a, b] = e.touches;
    const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    setZoom(touchState.startZoom * (dist / touchState.startDist),
            touchState.cx, touchState.cy, false);
    e.preventDefault();
  }
}, { passive: false });

Viewport.addEventListener('touchend', () => { touchState = null; });

// ─────────── SVG page-warp (paper texture + per-page topology) ───────────
// 2-D displacement map. Each HALF of the map is one page:
//   t (0 = outer edge, 1 = spine) drives the horizontal curve;
//   Y (0 = top, 1 = bottom)  drives where on the line the bend lands.
//
// Curve per page:
//   dip(t) = 0.04·sin(t·π) + 0.012·t
//     — flat at the outer corner (t=0),
//     — max dip in the MIDDLE of the page (t=0.5),
//     — slight residual dip at the spine corner (t=1).
//   dispY(t, Y) = dip(t) · (1 − 2·Y)
//     — top line moves DOWN by dip(t),
//     — middle line doesn't move,
//     — bottom line moves UP by dip(t).
//   Net visual: the page is bounded by a "smile" on the top edge
//   and an inverted smile on the bottom edge — exactly the silhouette
//   in the photo (and what you drew over it).
//
// feDisplacementMap samples output(x,y) = input(x, y + scale·(G/255 − 0.5)).
// scale on the filter = 80, so encoded G in [1..255] gives ±40 px.
//
// The RIGHT half of the map is the MIRROR of the left, so both pages
// dip toward their own middles, with the spine shared at the centre.
const PAGE_WARP = { mapW: 512, mapH: 256, maxDispPx: 100, pageHeightPx: 844 };

function pageDip(t) {
  // Big enough that it's UNDENIABLE if the filter is applying.
  // We'll dial back to "slight" once confirmed visible.
  return 0.15 * Math.sin(t * Math.PI) + 0.04 * t;
}

function buildPageWarpMap() {
  const { mapW: w, mapH: h, maxDispPx, pageHeightPx } = PAGE_WARP;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const half = w / 2;
  for (let i = 0; i < w; i++) {
    // t = 0 at the outer edge of the page, 1 at the spine — mirrored for the right page
    const tPage = (i < half) ? (i / (half - 1)) : (1 - (i - half) / (half - 1));
    const dip = pageDip(tPage);
    for (let j = 0; j < h; j++) {
      const Y = j / (h - 1);                  // 0 top → 1 bottom
      const dispYNorm = dip * (1 - 2 * Y);    // top dips down, bottom rises up
      const dispYPx = dispYNorm * pageHeightPx;
      // encode into G; scale on the filter must equal 2·maxDispPx
      let g = 128 + (dispYPx / maxDispPx) * 127;
      if (g < 0) g = 0; else if (g > 255) g = 255;
      const idx = (j * w + i) * 4;
      img.data[idx]     = 128;                // R — no horizontal displacement (yet)
      img.data[idx + 1] = Math.round(g);      // G — vertical displacement
      img.data[idx + 2] = 128;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function installPageWarp() {
  const spineMap = document.getElementById('spine-map');
  if (!spineMap) return;
  try {
    const url = buildPageWarpMap();
    spineMap.setAttribute('href', url);
    spineMap.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
    TextFlow.classList.add('warp-on');
  } catch (e) {
    console.warn('book: page-warp install failed', e);
  }
}

// ─────────── quill cursor — follows the native caret ───────────
// The quill SVG (em-scaled, nib at #quill-caret's 0,0) is positioned at
// the native caret. #quill-caret lives in #book, outside the SVG filter,
// so the quill itself isn't warped — but we DO add the spine dip to its
// y so the nib still meets the warped line of text near the gutter.

// Visual y-offset the page-warp filter applies at fraction (xFrac, yFrac)
// of the .text-flow. Mirrors buildPageWarpMap so the quill nib stays
// glued to the displaced line of text.
function pageWarpDispPx(xFrac, yFrac) {
  // map xFrac (0..1 across whole text-flow) → tPage (0..1 outer→spine on its page)
  const tPage = (xFrac < 0.5) ? (xFrac * 2) : ((1 - xFrac) * 2);
  return pageDip(tPage) * (1 - 2 * yFrac) * PAGE_WARP.pageHeightPx;
}

// The caret rectangle in viewport pixels (collapsed to the selection's
// focus point). Falls back to the block / its <br> for empty blocks.
function caretRect() {
  const sel = window.getSelection();
  if (!sel || !sel.focusNode || !TextFlow.contains(sel.focusNode)) return null;
  const range = document.createRange();
  try {
    range.setStart(sel.focusNode, sel.focusOffset);
  } catch (_) { return null; }
  range.collapse(true);
  let r = range.getBoundingClientRect();
  if (r && (r.height > 0)) return r;
  const rects = range.getClientRects();
  if (rects.length && rects[0].height > 0) return rects[0];
  // empty block — measure its <br>, else the block box
  let node = sel.focusNode;
  if (node.nodeType === 3) node = node.parentNode;
  if (node && node.querySelector) {
    const br = node.querySelector('br');
    if (br) {
      const br2 = br.getBoundingClientRect();
      if (br2.height > 0) return br2;
    }
  }
  return node ? node.getBoundingClientRect() : null;
}

function updateQuill() {
  const r = caretRect();
  if (!r) return;
  const bookRect = Book.getBoundingClientRect();
  const tfRect = TextFlow.getBoundingClientRect();
  const scale = fitScale * zoom;
  if (scale <= 0 || tfRect.width === 0) return;

  // caret position in book-local (un-zoomed stage) pixels
  let x = (r.left - bookRect.left) / scale;
  let y = (r.top  - bookRect.top)  / scale;
  const h = r.height / scale;

  // follow the page-warp displacement so the nib meets the warped line
  const xFrac = (r.left - tfRect.left) / tfRect.width;
  const yFrac = (r.top  - tfRect.top)  / tfRect.height;
  y += pageWarpDispPx(xFrac, yFrac);

  // nib sits near the writing line (≈ baseline of the caret line)
  QuillCaret.style.left = x + 'px';
  QuillCaret.style.top  = (y + h * 0.74) + 'px';
}

// Throttle with setTimeout (not rAF — rAF can be paused when the page
// isn't painting, which would stick the throttle permanently).
let quillTimer = null;
function scheduleQuillUpdate() {
  if (quillTimer) return;
  quillTimer = setTimeout(() => { quillTimer = null; updateQuill(); }, 16);
}

document.addEventListener('selectionchange', scheduleQuillUpdate);
TextFlow.addEventListener('focus', () => {
  QuillCaret.classList.add('visible');
  scheduleQuillUpdate();
});
TextFlow.addEventListener('blur', () => {
  QuillCaret.classList.remove('visible');
});

// ─────────── ink trace (opentype.js · transient overlay) ───────────
// Every typed character draws itself: the just-typed glyph is briefly
// hidden (an .ink-fresh span, transparent), an SVG path of the glyph is
// spawned in #hidden-host (screen-space, decoupled from the editable DOM),
// its stroke-dashoffset animates 0→full over ~80ms, then the overlay fades
// as the real char is revealed. Falls back to a plain (un-traced) char if
// opentype.js or the font TTF isn't available — no DOM mutation in that
// case, so native undo stays pristine.
const SVG_NS = 'http://www.w3.org/2000/svg';
const FONTSOURCE_SLUGS = {
  'Cormorant Garamond': 'cormorant-garamond',
  'Italianno':          'italianno',
};
const fontDb = {};

async function loadFontForInkTrace(family) {
  if (typeof opentype === 'undefined') return null;
  if (fontDb[family]) return fontDb[family];
  const slug = FONTSOURCE_SLUGS[family];
  if (!slug) return null;
  try {
    // Fontsource serves TTF (opentype.js can't decode Google's WOFF2 —
    // the CDN build has no Brotli decoder).
    const res = await fetch(`https://cdn.jsdelivr.net/fontsource/fonts/${slug}@latest/latin-400-normal.ttf`);
    if (!res.ok) throw new Error('http ' + res.status);
    const font = opentype.parse(await res.arrayBuffer());
    fontDb[family] = font;
    return font;
  } catch (e) {
    console.warn('book: ink-trace font load failed for', family, e);
    return null;
  }
}

function runInkTrace(ch) {
  const font = fontDb[window.__book.font];
  if (!font) return;                     // fallback: no trace, no DOM mutation
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const node = sel.focusNode;
  const off  = sel.focusOffset;
  if (!node || node.nodeType !== 3 || off < 1) return;
  if (node.textContent[off - 1] !== ch) return;

  // isolate the just-typed char in a transient transparent span
  const charNode = node.splitText(off - 1);   // charNode starts with ch
  const afterNode = charNode.splitText(1);     // afterNode = the rest
  const span = document.createElement('span');
  span.className = 'ink-fresh';
  span.textContent = ch;
  charNode.parentNode.replaceChild(span, charNode);

  // restore the caret right after the span
  const r = document.createRange();
  r.setStart(afterNode, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);

  const rect = span.getBoundingClientRect();
  let drew = false;
  if (rect.width > 0 && rect.height > 0) {
    drew = spawnInkOverlay(ch, span, rect, font);
  }
  const revealMs = drew ? (window.__book.inkMs || 80) + 70 : 0;
  setTimeout(() => revealInkFresh(span), revealMs);
}

function revealInkFresh(span) {
  const p = span.parentNode;
  if (p) p.replaceChild(document.createTextNode(span.textContent), span);
}

function spawnInkOverlay(ch, span, rect, font) {
  const glyph = font.charToGlyph(ch);
  if (!glyph || !glyph.path || !glyph.path.commands || !glyph.path.commands.length) return false;

  const scale = fitScale * zoom;
  const cssFs = parseFloat(getComputedStyle(span).fontSize) || 30;
  const emPx  = cssFs * scale;                       // on-screen em, px
  const upm = font.unitsPerEm || 1000;
  const ascentEm  = font.ascender  / upm;
  const descentEm = font.descender / upm;            // negative
  const emBoxPx = (ascentEm - descentEm) * emPx;
  const baselineY = rect.top + (rect.height - emBoxPx) / 2 + ascentEm * emPx;

  const path = glyph.getPath(0, 0, emPx);            // baseline at y=0
  const d = path.toPathData(2);
  const bb = path.getBoundingBox();
  if (!isFinite(bb.x1) || (bb.x2 - bb.x1) < 0.01) return false;

  const pad = emPx * 0.22;
  const vbX = bb.x1 - pad, vbY = bb.y1 - pad;
  const vbW = (bb.x2 - bb.x1) + pad * 2;
  const vbH = (bb.y2 - bb.y1) + pad * 2;

  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `${vbX} ${vbY} ${vbW} ${vbH}`);
  svg.style.cssText =
    `position:absolute; overflow:visible; filter:blur(0.35px);` +
    `left:${rect.left + vbX}px; top:${baselineY + vbY}px;` +
    `width:${vbW}px; height:${vbH}px;`;

  const pathEl = document.createElementNS(SVG_NS, 'path');
  pathEl.setAttribute('d', d);
  pathEl.setAttribute('fill', 'none');
  pathEl.setAttribute('stroke', window.__book.ink || '#2a1808');
  pathEl.setAttribute('stroke-width', String(Math.max(0.7, emPx * 0.052)));
  pathEl.setAttribute('stroke-linecap', 'round');
  pathEl.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(pathEl);
  HiddenHost.appendChild(svg);

  let len = 0;
  try { len = pathEl.getTotalLength(); } catch (_) {}
  if (!len) { svg.remove(); return false; }

  pathEl.style.strokeDasharray  = len;
  pathEl.style.strokeDashoffset = len;
  const dur = window.__book.inkMs || 80;
  const anim = pathEl.animate(
    [{ strokeDashoffset: len }, { strokeDashoffset: 0 }],
    { duration: dur, easing: 'ease-out', fill: 'forwards' }
  );

  let cleaned = false;
  const finish = () => {
    if (cleaned) return;
    cleaned = true;
    svg.style.transition = 'opacity 130ms ease-out';
    svg.style.opacity = '0';
    setTimeout(() => { if (svg.parentNode) svg.remove(); }, 150);
  };
  anim.onfinish = finish;
  anim.oncancel = finish;
  setTimeout(finish, dur + 90);   // safety net if WAAPI callbacks stall
  return true;
}

// ─────────── persistence (localStorage autosave) ───────────
const STORAGE_KEY = 'fireplace.book.v2';
const SAVE_DEBOUNCE_MS = 300;
let saveTimer = null;
let lastSaveAt = 0;

function schedulePersist() {
  StatusText.textContent = 'writing…';
  StatusDot.style.background = 'var(--chrome-accent)';
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, SAVE_DEBOUNCE_MS);
}

function persistNow() {
  saveTimer = null;
  try {
    const payload = {
      v: 2,
      html: TextFlow.innerHTML,
      font: window.__book.font,
      savedAt: Date.now(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    lastSaveAt = payload.savedAt;
    updateSavedStatus();
    // whimsy: candle-glow pulse on the status dot
    StatusDot.classList.remove('flash');
    // force reflow so the animation re-triggers
    void StatusDot.offsetWidth;
    StatusDot.classList.add('flash');
    setTimeout(() => StatusDot.classList.remove('flash'), 750);
  } catch (e) {
    StatusText.textContent = 'save failed';
    StatusDot.style.background = '#e86969';
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
  StatusDot.style.background = '#6ed09a';
}

function restoreFromStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return false;
  try {
    const data = JSON.parse(raw);
    if (data.v !== 2) return false;
    if (data.html) TextFlow.innerHTML = data.html;
    if (data.font) {
      window.__book.font = data.font;
      const fallback = data.font === 'Italianno'
        ? "'Petit Formal Script', cursive"
        : "'Georgia', serif";
      document.documentElement.style.setProperty('--book-font', `'${data.font}', ${fallback}`);
      loadFontForInkTrace(data.font);
    }
    lastSaveAt = data.savedAt || 0;
    if (lastSaveAt) updateSavedStatus();
    if (!isEditorEmpty()) {
      firstInputDone = true;
      HintEl.classList.add('hidden');
    }
    return true;
  } catch (e) {
    console.warn('book: restore failed', e);
    return false;
  }
}

// expose for tweaks.js
window.__book.loadFontForInkTrace = loadFontForInkTrace;
window.__book.schedulePersist     = schedulePersist;

// ─────────── the writing surface (contenteditable) ───────────
function focusEditorAtEnd() {
  TextFlow.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(TextFlow);
  range.collapse(false);  // collapse to end
  sel.removeAllRanges();
  sel.addRange(range);
  scheduleQuillUpdate();
}

function isEditorEmpty() {
  return TextFlow.textContent.replace(/​/g, '').trim().length === 0;
}

function refreshHint() {
  if (isEditorEmpty()) HintEl.classList.remove('hidden');
  else HintEl.classList.add('hidden');
}

TextFlow.addEventListener('input', (e) => {
  // draw the just-typed character with the ink trace
  if (e && e.inputType === 'insertText' && e.data && e.data.length === 1) {
    runInkTrace(e.data);
  }
  if (!firstInputDone && !isEditorEmpty()) {
    firstInputDone = true;
    document.querySelectorAll('.chrome').forEach(c => c.classList.add('faded'));
  }
  refreshHint();
  schedulePersist();
  scheduleQuillUpdate();
});

// ─────────── toolbar ───────────
document.getElementById('btn-zoom-in').addEventListener('click',
  () => setZoom(zoom * 1.25, window.innerWidth / 2, window.innerHeight / 2, true));
document.getElementById('btn-zoom-out').addEventListener('click',
  () => setZoom(zoom / 1.25, window.innerWidth / 2, window.innerHeight / 2, true));
document.getElementById('btn-zoom-reset').addEventListener('click', resetView);

document.getElementById('btn-clear').addEventListener('click', () => {
  TextFlow.innerHTML = '<p><br></p>';
  firstInputDone = false;
  refreshHint();
  focusEditorAtEnd();
});

// ─────────── chrome reveal on mouse near edges ───────────
let chromeRevealTimer = null;
window.addEventListener('mousemove', (e) => {
  if (e.clientY < 80 || e.clientY > window.innerHeight - 80) {
    document.querySelectorAll('.chrome').forEach(c => c.classList.remove('faded'));
    clearTimeout(chromeRevealTimer);
    chromeRevealTimer = setTimeout(() => {
      if (firstInputDone) {
        document.querySelectorAll('.chrome').forEach(c => c.classList.add('faded'));
      }
    }, 2400);
  }
});

// ─────────── init ───────────
try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (_) {}

fitStage();
setTimeout(fitStage, 0);                  // re-fit once layout has settled
window.addEventListener('load', fitStage);
installPageWarp();
loadFontForInkTrace('Cormorant Garamond');   // ink-trace glyph data (async)
restoreFromStorage();                         // bring back the last session
refreshHint();
TextFlow.focus();
QuillCaret.classList.add('visible');
scheduleQuillUpdate();
setTimeout(updateQuill, 60);              // settle once fonts/layout land
setTimeout(updateQuill, 300);

// keep the "saved · Xs ago" label fresh
setInterval(updateSavedStatus, 5000);

// whimsy: nudge the paper-warp turbulence seed every 8s — the page
// texture drifts imperceptibly, the parchment looks alive
setInterval(() => {
  const turb = document.querySelector('#page-warp feTurbulence');
  if (turb) {
    const s = (parseInt(turb.getAttribute('seed'), 10) + 1) % 90;
    turb.setAttribute('seed', String(s));
  }
}, 8000);

setTimeout(() => {
  ShortcutChip.classList.add('visible');
  setTimeout(() => ShortcutChip.classList.remove('visible'), 5000);
}, 700);

// expose camera helpers for later phases
window.__book.getCamera = () => ({ zoom, panX, panY, fitScale });
window.__book.resetView = resetView;

})();
