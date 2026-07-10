// =============================================================
// Pemeran — wizard shell: hash-based screen router + progress rail
// =============================================================

import { state, STAGES, stageIndex, onChange, init as initState } from './state.js';

// M3: every stage now has a real module — one lookup table drives route().
const STAGE_MODULES = {
  setup:  './stages/setup.js',
  cp:     './stages/cp.js',
  tp:     './stages/tp.js',
  kktp:   './stages/kktp.js',
  atp:    './stages/atp.js',
  prosem: './stages/prosem.js',
  rpp:    './stages/rpp.js',
  ekspor: './stages/ekspor.js',
};

let els = null;

export async function mount(ids) {
  els = ids; // { rail, stage, autosave, title, sub }

  onChange(() => {
    renderRail();
    renderAutosave();
    renderHeader();
  });

  await initState();

  if (!location.hash) location.hash = '#/' + state.stage;
  window.addEventListener('hashchange', route);

  renderRail();
  renderAutosave();
  renderHeader();
  await route();
}

function renderRail() {
  const idx = stageIndex(state.stage);
  els.rail.innerHTML = '';
  STAGES.forEach((s, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'rail-sep';
      sep.textContent = '›';
      els.rail.appendChild(sep);
    }
    const reachable = i <= idx;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'rail-step'
      + (i < idx ? ' is-done' : '')
      + (i === idx ? ' is-current' : '')
      + (reachable ? ' is-clickable' : '');
    btn.textContent = (i < idx ? '✓ ' : '') + s.label;
    if (!reachable) {
      btn.disabled = true;
      btn.title = 'Selesaikan tahap sebelumnya dulu.';
    } else {
      btn.addEventListener('click', () => { location.hash = '#/' + s.id; });
    }
    els.rail.appendChild(btn);
  });
}

function renderAutosave() {
  const status = state.saveStatus;
  els.autosave.className = 'autosave is-' + (status === 'idle' ? 'saved' : status);
  const label =
    status === 'saving' ? 'Menyimpan…' :
    status === 'error'  ? (state.saveError || 'Gagal menyimpan') :
    status === 'saved'  ? 'Tersimpan ✓' :
    'Draf belum disimpan';
  els.autosave.innerHTML = '<span class="autosave-dot"></span><span>' + label + '</span>';
}

function renderHeader() {
  const h = state.spine.header;
  els.title.textContent = h.mapel ? (h.mapel + ' — Kelas ' + (h.kelas || '?')) : 'Perangkat baru';
  els.sub.textContent = [h.tahunAjaran, h.guru].filter(Boolean).join(' · ');
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, '') || state.stage;
  const modPath = STAGE_MODULES[hash];
  if (modPath) {
    try {
      const mod = await import(modPath);
      await mod.render(els.stage);
    } catch (e) {
      els.stage.innerHTML = '<div class="placeholder card"><div class="big-icon">⚠️</div>'
        + '<h2>Tahap "' + hash + '" gagal dimuat</h2><p class="muted">' + String((e && e.message) || e) + '</p></div>';
    }
  } else {
    els.stage.innerHTML = '<div class="placeholder card"><div class="big-icon">🚧</div>'
      + '<h2>Tahap tidak dikenal</h2><p>"' + hash + '" bukan tahap yang valid.</p></div>';
  }
  renderRail();
}
