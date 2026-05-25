/* ═══════════════════════════════════════════════════════════════
   Fireplace · The Book — tweaks.js
   The hand toggle. One button in the bottom chrome: swap between
   the readable italic serif (Cormorant Garamond) and the dramatic
   script (Italianno). Cross-fades the writing surface during the
   swap so glyphs don't snap.
   ═══════════════════════════════════════════════════════════════ */

(() => {
'use strict';

const Btn = document.getElementById('btn-font');
const TextFlow = document.getElementById('text-flow');
if (!Btn || !TextFlow) return;

const SERIF  = 'Cormorant Garamond';
const SCRIPT = 'Italianno';

function applyFont(family) {
  const fallback = family === SCRIPT
    ? "'Petit Formal Script', cursive"
    : "'Georgia', serif";
  document.documentElement.style.setProperty('--book-font', `'${family}', ${fallback}`);
  Btn.title = family === SCRIPT
    ? 'Switch to italic serif'
    : 'Switch to script';
  // also load TTF for ink-trace (async, no-op if already loaded)
  if (window.__book && window.__book.loadFontForInkTrace) {
    window.__book.loadFontForInkTrace(family);
  }
  if (window.__book) window.__book.font = family;
}

function setBookFont(family) {
  if (window.__book && window.__book.font === family) return;
  // cross-fade the writing surface so the glyph swap doesn't snap
  TextFlow.style.transition = 'opacity 220ms ease';
  TextFlow.style.opacity = '0.35';
  setTimeout(() => {
    applyFont(family);
    TextFlow.style.opacity = '1';
    if (window.__book && window.__book.schedulePersist) {
      window.__book.schedulePersist();
    }
    setTimeout(() => {
      TextFlow.style.transition = '';
      TextFlow.style.opacity = '';
    }, 260);
  }, 140);
}

Btn.addEventListener('click', () => {
  const current = (window.__book && window.__book.font) || SERIF;
  setBookFont(current === SERIF ? SCRIPT : SERIF);
});

// reflect whatever font is already set (after restoreFromStorage)
applyFont((window.__book && window.__book.font) || SERIF);

})();
