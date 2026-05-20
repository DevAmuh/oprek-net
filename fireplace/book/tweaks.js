/* ═══════════════════════════════════════════════════════════════
   Fireplace · The Book — tweaks.js (vanilla)
   ═══════════════════════════════════════════════════════════════ */

(() => {
'use strict';

const Panel = document.getElementById('tweaks-panel');
let open = false;

const FONTS = [
  { name: 'EB Garamond',       label: 'Garamond',  sample: 'Aa' },
  { name: 'Cormorant Garamond', label: 'Cormorant', sample: 'Aa' },
  { name: 'IM Fell English',    label: 'IM Fell',   sample: 'Aa' },
  { name: 'Spectral',           label: 'Spectral',  sample: 'Aa' },
];

const INKS = [
  { name: 'Walnut',     value: '#2a1808' },
  { name: 'Sepia',      value: '#4a2c10' },
  { name: 'Midnight',   value: '#0e1a3a' },
  { name: 'Burgundy',   value: '#3a0e1a' },
  { name: 'Iron Gall',  value: '#161208' },
];

function render() {
  const info = (window.__getSpreadInfo && window.__getSpreadInfo()) || { current: 0, total: 1 };
  const wetness = (window.__book && typeof window.__book.inkMs === 'number') ? window.__book.inkMs : 80;
  Panel.innerHTML = `
    <h3>Tweaks</h3>
    <div class="panel-sub">The Book · vol. iii</div>

    <div class="tweak-row">
      <div class="tweak-label">Hand <b id="tw-font-name">${window.__book.font}</b></div>
      <div class="font-row" id="tw-fonts"></div>
    </div>

    <div class="tweak-row">
      <div class="tweak-label">Ink <b id="tw-ink-name">${currentInkName()}</b></div>
      <div class="swatch-row" id="tw-inks"></div>
    </div>

    <div class="tweak-row">
      <div class="tweak-label">Quill size <b><span id="tw-size-val">${window.__book.size}</span> pt</b></div>
      <input type="range" min="18" max="44" step="1" value="${window.__book.size}" id="tw-size">
    </div>

    <div class="tweak-row">
      <div class="tweak-label">Ink wetness <b><span id="tw-wet-val">${wetness}</span> ms</b></div>
      <input type="range" min="60" max="150" step="5" value="${wetness}" id="tw-wet">
    </div>

    <div class="tweak-row">
      <div class="tweak-label">Spread <b><span id="tw-spread-val">${info.current + 1}</span> / <span id="tw-spread-max">${info.total}</span></b></div>
      <input type="range" min="1" max="${Math.max(1, info.total)}" step="1" value="${info.current + 1}" id="tw-spread">
    </div>

    <div class="tweak-row">
      <button class="font-btn danger" id="tw-clear-data">Erase the book…</button>
    </div>
  `;

  // fonts
  const fontsEl = Panel.querySelector('#tw-fonts');
  FONTS.forEach(f => {
    const btn = document.createElement('button');
    btn.className = 'font-btn' + (f.name === window.__book.font ? ' active' : '');
    btn.style.fontFamily = `'${f.name}', serif`;
    btn.innerHTML = `<span style="font-size:16px; font-style:italic;">${f.sample}</span> &nbsp; <span style="font-size:11px; opacity:0.7;">${f.label}</span>`;
    btn.addEventListener('click', () => {
      window.__book.setFont(f.name);
      Panel.querySelectorAll('.font-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      Panel.querySelector('#tw-font-name').textContent = f.name;
    });
    fontsEl.appendChild(btn);
  });

  // inks
  const inksEl = Panel.querySelector('#tw-inks');
  INKS.forEach(ink => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (ink.value.toLowerCase() === window.__book.ink.toLowerCase() ? ' active' : '');
    sw.style.background = ink.value;
    sw.title = ink.name;
    sw.addEventListener('click', () => {
      window.__book.setInk(ink.value);
      Panel.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
      sw.classList.add('active');
      Panel.querySelector('#tw-ink-name').textContent = ink.name;
    });
    inksEl.appendChild(sw);
  });

  // size
  const sizeEl = Panel.querySelector('#tw-size');
  sizeEl.addEventListener('input', () => {
    const v = +sizeEl.value;
    window.__book.setSize(v);
    Panel.querySelector('#tw-size-val').textContent = v;
    refreshSpreadRange();
  });

  // ink wetness (animation duration — picked up by Phase D's stroke trace)
  const wetEl = Panel.querySelector('#tw-wet');
  if (wetEl) {
    wetEl.addEventListener('input', () => {
      const v = +wetEl.value;
      if (window.__book) window.__book.inkMs = v;
      Panel.querySelector('#tw-wet-val').textContent = v;
    });
  }

  // spread selector — jumps to spread N
  const spreadEl = Panel.querySelector('#tw-spread');
  if (spreadEl) {
    spreadEl.addEventListener('input', () => {
      const target = +spreadEl.value - 1;
      if (window.__goToSpread) window.__goToSpread(target);
      Panel.querySelector('#tw-spread-val').textContent = target + 1;
    });
  }

  // Erase the book — two-step confirm
  const clearBtn = Panel.querySelector('#tw-clear-data');
  if (clearBtn) {
    let armed = false;
    let armedTimer = null;
    clearBtn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        clearBtn.textContent = 'really? (click again)';
        clearBtn.classList.add('armed');
        armedTimer = setTimeout(() => {
          armed = false;
          clearBtn.textContent = 'Erase the book…';
          clearBtn.classList.remove('armed');
        }, 3000);
      } else {
        clearTimeout(armedTimer);
        if (window.__eraseBook) window.__eraseBook();
      }
    });
  }
}

function refreshSpreadRange() {
  if (!window.__getSpreadInfo) return;
  const info = window.__getSpreadInfo();
  const slider = Panel && Panel.querySelector('#tw-spread');
  const valLbl = Panel && Panel.querySelector('#tw-spread-val');
  const maxLbl = Panel && Panel.querySelector('#tw-spread-max');
  if (slider) {
    slider.max = Math.max(1, info.total);
    slider.value = info.current + 1;
  }
  if (valLbl) valLbl.textContent = info.current + 1;
  if (maxLbl) maxLbl.textContent = info.total;
}

// Keep the spread slider in sync when prev/next or live overflow updates state.
window.addEventListener('book:spread-changed', refreshSpreadRange);

function currentInkName() {
  const ink = INKS.find(i => i.value.toLowerCase() === window.__book.ink.toLowerCase());
  return ink ? ink.name : 'Custom';
}

function show() {
  Panel.hidden = false;
  render();
  open = true;
}
function hide() {
  Panel.hidden = true;
  open = false;
}

window.__toggleTweaks = () => { open ? hide() : show(); };

// close on Escape
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && open) hide();
});

})();
