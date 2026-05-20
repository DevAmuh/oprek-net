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
  });
}

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
