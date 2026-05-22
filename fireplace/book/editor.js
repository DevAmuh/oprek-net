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
};

// ─────────── camera ───────────
function fitStage() {
  const pad = 80;
  // Guard the first-paint case where the layout viewport hasn't sized yet
  // (innerWidth/innerHeight can momentarily be 0 → negative fitScale).
  const vw = window.innerWidth  || document.documentElement.clientWidth  || 1280;
  const vh = window.innerHeight || document.documentElement.clientHeight || 800;
  fitScale = Math.min((vw - pad * 2) / STAGE_W, (vh - pad * 2) / STAGE_H);
  if (!(fitScale > 0)) fitScale = 0.3;
  applyCamera();
}

function applyCamera() {
  const scale = fitScale * zoom;
  const cx = (window.innerWidth  - STAGE_W * scale) / 2 + panX;
  const cy = (window.innerHeight - STAGE_H * scale) / 2 + panY;
  Camera.style.transform = `translate3d(${cx}px, ${cy}px, 0) scale(${scale})`;
  ZoomValue.textContent = Math.round(zoom * 100) + '%';
}

function setZoom(target, anchorX, anchorY, animated) {
  target = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, target));
  if (anchorX != null) {
    // keep the world point under the anchor stable
    const sb = fitScale * zoom;
    const sa = fitScale * target;
    const cxb = (window.innerWidth  - STAGE_W * sb) / 2 + panX;
    const cyb = (window.innerHeight - STAGE_H * sb) / 2 + panY;
    const wx = (anchorX - cxb) / sb;
    const wy = (anchorY - cyb) / sb;
    panX = anchorX - wx * sa - (window.innerWidth  - STAGE_W * sa) / 2;
    panY = anchorY - wy * sa - (window.innerHeight - STAGE_H * sa) / 2;
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

// ─────────── SVG page-warp (paper texture + spine curve) ───────────
// Generates the spine displacement map: a horizontal cosine valley where
// the G channel encodes vertical displacement. The map is anchored to the
// whole .text-flow element (objectBoundingBox filter region), so even
// sparse text gets the right curve at the right horizontal positions.
//
// feDisplacementMap samples output(x,y) = input(x, y + scale·(G-0.5)).
// To make a line DIP downward at the spine — i.e. render content from
// ABOVE — we need G < 0.5 there. So: G = 128 at the outer edges
// (no displacement) falling toward 0 at the horizontal centre (spine).
function buildSpineMap() {
  const w = 256, h = 4;                       // 1-D gradient; a few rows is plenty
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const t = x / (w - 1);                    // 0..1 across the width
    const s = 1 - Math.abs(t - 0.5) * 2;      // 1 at the spine, 0 at the edges
    const dip = Math.pow(Math.max(0, s), 2.4);// concentrate the curve near the spine
    const g = Math.round(128 * (1 - dip));    // 128 at edges → ~0 at spine
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      img.data[i]     = 128;   // R — no horizontal displacement
      img.data[i + 1] = g;     // G — vertical displacement
      img.data[i + 2] = 128;   // B
      img.data[i + 3] = 255;   // A
    }
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function installPageWarp() {
  const spineMap = document.getElementById('spine-map');
  if (!spineMap) return;
  try {
    const url = buildSpineMap();
    spineMap.setAttribute('href', url);
    spineMap.setAttributeNS('http://www.w3.org/1999/xlink', 'href', url);
    TextFlow.classList.add('warp-on');
  } catch (e) {
    console.warn('book: page-warp install failed', e);
  }
}

// ─────────── the writing surface (contenteditable) ───────────
function focusEditorAtEnd() {
  TextFlow.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(TextFlow);
  range.collapse(false);  // collapse to end
  sel.removeAllRanges();
  sel.addRange(range);
}

function isEditorEmpty() {
  return TextFlow.textContent.replace(/​/g, '').trim().length === 0;
}

function refreshHint() {
  if (isEditorEmpty()) HintEl.classList.remove('hidden');
  else HintEl.classList.add('hidden');
}

TextFlow.addEventListener('input', () => {
  if (!firstInputDone && !isEditorEmpty()) {
    firstInputDone = true;
    document.querySelectorAll('.chrome').forEach(c => c.classList.add('faded'));
  }
  refreshHint();
  StatusText.textContent = 'writing…';
  StatusDot.style.background = 'var(--chrome-accent)';
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
requestAnimationFrame(fitStage);          // re-fit once layout has settled
window.addEventListener('load', fitStage);
installPageWarp();
refreshHint();
TextFlow.focus();

setTimeout(() => {
  ShortcutChip.classList.add('visible');
  setTimeout(() => ShortcutChip.classList.remove('visible'), 5000);
}, 700);

// expose camera helpers for later phases
window.__book.getCamera = () => ({ zoom, panX, panY, fitScale });
window.__book.resetView = resetView;

})();
