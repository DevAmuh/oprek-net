// =============================================================
// Pemeran — Stage: Prosem (Program Semester) — V2b redesign
// -------------------------------------------------------------
// NO AI (plan's owner decision #6 — Kaldik skipped, auto-distribute from
// yearly JP). The matrix preview IS the screen now: week cells are
// clickable to move a unit/sumatif's JP to a different week (row's total
// JP always preserved) — click a filled cell to select it, then click an
// empty cell in the SAME row to move it there; click the same cell again
// to cancel. A moved row is flagged "manual" in spine.prosem.overrides so
// recompute() never silently stomps it (pipeline.distributeProsemWithOverrides).
// "Susun ulang otomatis" clears all overrides back to the deterministic
// auto-distribution. The old opaque validator badge is replaced by a plain-
// language hint strip ("Semester Ganjil: 34 JP terpakai dari 36 target —
// kurang 2 JP") that WARNS but never blocks — Lanjut is always enabled once
// a Prosem exists at all.
// =============================================================

import { state, setProsem, setStage } from '../state.js';
import { toast } from '../api.js';
import { distributeProsemWithOverrides, aggregateProta, flattenProsemRows, moveProsemCell } from '../pipeline.js';
import { renderProsemHtml } from '../render/prosem.js';
import { badgeHtml, wireValidatorChips } from '../validate.js';

let computed = null; // distributeProsemWithOverrides() output, kept for the preview + persistence
let rootEl = null;
const selected = { 1: null, 2: null }; // { rowId, bulan, minggu } per semester — click-to-move state

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function loadKonstantaMingguDefault(kelas) {
  try {
    const res = await fetch('data/konstanta.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const k = await res.json();
    const d = k.mingguEfektifDefault || {};
    return { ganjil: d.ganjil ?? 18, genap: Number(kelas) === 9 ? (d.genapKelas9 ?? 14) : (d.genap ?? 17) };
  } catch (e) {
    return null;
  }
}

export async function render(container) {
  rootEl = container;
  const units = state.spine.units || [];
  if (!units.length) {
    container.innerHTML = '<div class="placeholder card"><div class="big-icon">⚠️</div><h2>Belum ada ATP</h2><p class="muted">Lengkapi tahap ATP/Prota terlebih dahulu.</p></div>';
    return;
  }

  // First-time load for this plan (no rows persisted yet): prefill
  // mingguEfektif with the kelas-aware default (kelas 9 genap is shorter).
  if (!state.spine.prosem.rows.length) {
    const def = await loadKonstantaMingguDefault(state.spine.header.kelas);
    if (def) setProsem({ mingguEfektif: def });
  }

  computeAndPersist();

  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg">
        <div class="row-between">
          <h2>Program Semester (Prosem)</h2>
          ${badgeHtml(state.spine, 'prosem')}
        </div>
        <p class="muted small">Unit ATP didistribusikan otomatis ke minggu efektif tiap semester (tanpa kalender pendidikan sekolah — jadwal generik, sesuaikan bila perlu). Klik sebuah minggu yang terisi lalu klik minggu kosong pada baris yang sama untuk memindahkan JP-nya — total JP baris tidak berubah. Kolom "Keterangan" dikosongkan karena Kaldik tidak dipakai.</p>
        <div class="grid grid-2">
          <div class="field">
            <label for="in-minggu-ganjil">Minggu efektif — Semester Ganjil</label>
            <input type="number" id="in-minggu-ganjil" min="1" max="24" value="${state.spine.prosem.mingguEfektif.ganjil}">
          </div>
          <div class="field">
            <label for="in-minggu-genap">Minggu efektif — Semester Genap</label>
            <input type="number" id="in-minggu-genap" min="1" max="24" value="${state.spine.prosem.mingguEfektif.genap}">
          </div>
        </div>
        <button class="btn btn-ghost" id="btn-reset-auto" type="button">↻ Susun ulang otomatis</button>
      </div>
      <div class="card card-pad-lg" id="prosem-hint"></div>
      <div class="card card-pad-lg">
        <h3>Pratinjau — Semester Ganjil</h3>
        <div class="doc-preview-frame" style="max-height:70vh;">
          <iframe id="prosem-iframe-1" title="Pratinjau Prosem Ganjil" style="width:100%; min-height:600px; border:0; display:block;"></iframe>
        </div>
      </div>
      <div class="card card-pad-lg">
        <h3>Pratinjau — Semester Genap</h3>
        <div class="doc-preview-frame" style="max-height:70vh;">
          <iframe id="prosem-iframe-2" title="Pratinjau Prosem Genap" style="width:100%; min-height:600px; border:0; display:block;"></iframe>
        </div>
      </div>
      <div class="row-between">
        <span></span>
        <button class="btn btn-primary btn-lg" id="btn-next">Simpan &amp; Lanjut →</button>
      </div>
    </div>
  `;

  await recomputeAndRender(container);

  container.querySelector('#in-minggu-ganjil').addEventListener('input', (e) => {
    setProsem({ mingguEfektif: { ...state.spine.prosem.mingguEfektif, ganjil: Number(e.target.value) || 1 } });
    recomputeAndRender(container);
  });
  container.querySelector('#in-minggu-genap').addEventListener('input', (e) => {
    setProsem({ mingguEfektif: { ...state.spine.prosem.mingguEfektif, genap: Number(e.target.value) || 1 } });
    recomputeAndRender(container);
  });
  container.querySelector('#btn-reset-auto').addEventListener('click', () => {
    setProsem({ overrides: {} });
    toast('Prosem disusun ulang otomatis — semua penempatan manual dihapus.');
    recomputeAndRender(container);
  });
  container.querySelector('#btn-next').addEventListener('click', () => onNext(container));

  wireValidatorChips(container);
}

/** Synchronous: run the deterministic distribution (honoring any manual
 *  overrides — V2b #4) and persist rows to the spine. Split out from the
 *  (async) preview rendering below so callers that need fresh rows before
 *  building header/badge markup can call this alone. */
function computeAndPersist() {
  const { units, sumatif, config, header, prosem } = state.spine;
  computed = distributeProsemWithOverrides(units, sumatif, config, header.kelas, prosem.overrides);
  setProsem({ rows: flattenProsemRows(computed) });
}

function renderHint(container) {
  const el = container.querySelector('#prosem-hint');
  if (!el) return;
  const { units, sumatif } = state.spine;
  const prota = aggregateProta(units || [], sumatif || []);
  const line = (label, actual, target) => {
    if (actual === target) return `<div>✓ <strong>${label}:</strong> sesuai — ${actual} JP terpakai.</div>`;
    const diff = Math.abs(target - actual);
    const verb = actual < target ? 'kurang' : 'kelebihan';
    return `<div style="color:var(--warn);">⚠ <strong>${label}:</strong> ${actual} JP terpakai dari ${target} JP target ATP/Prota — ${verb} ${diff} JP.</div>`;
  };
  el.innerHTML = `
    <h3 style="margin-top:0;">Ringkasan</h3>
    <div class="stack" style="gap:6px;">
      ${line('Semester Ganjil', computed.semester1.totalJp, prota.semester1.totalJp)}
      ${line('Semester Genap', computed.semester2.totalJp, prota.semester2.totalJp)}
    </div>
    <p class="field-hint" style="margin-top:8px;">Ini hanya peringatan — Anda tetap bisa lanjut ke tahap berikutnya. Selisih biasanya berarti minggu efektif perlu disesuaikan, atau unit ATP perlu diperbarui.</p>
  `;
}

async function recomputeAndRender(container) {
  computeAndPersist();
  const { header, cp, tps, units, config } = state.spine;

  // Every recompute rebuilds both iframes from scratch, so any in-progress
  // cell selection from the PREVIOUS DOM is now meaningless (and the row's
  // week layout may have shifted) — clear it defensively rather than risk
  // a move against stale {bulan,minggu} coordinates.
  selected[1] = null; selected[2] = null;

  renderHint(container);

  for (const [sem, iframeId] of [[1, '#prosem-iframe-1'], [2, '#prosem-iframe-2']]) {
    const semesterData = sem === 1 ? computed.semester1 : computed.semester2;
    try {
      const { html } = await renderProsemHtml({
        header, config, semesterNum: sem, semesterData, units, tps, cpElemen: cp.elemen,
      });
      const iframe = container.querySelector(iframeId);
      await new Promise((resolve) => {
        iframe.addEventListener('load', resolve, { once: true });
        iframe.srcdoc = html;
      });
      wireMatrixClicks(iframe, sem, container);
    } catch (e) {
      toast('Gagal merender pratinjau Prosem: ' + String((e && e.message) || e), { error: true });
    }
  }
}

// ---- V2b #4 — click-a-filled-cell then click-an-empty-cell to move JP -----
// The matrix is built programmatically outside the data-marker system
// (render/prosem.js), so it keeps its own bespoke handler here rather than
// going through render/docHtml/editable.js's wireEditable().
function wireMatrixClicks(iframe, semester, container) {
  const doc = iframe.contentDocument;
  if (!doc) return;

  const style = doc.createElement('style');
  style.textContent = `
    td.mark{ cursor:pointer; }
    td.mark:hover{ outline:1.5px dashed #146b64; outline-offset:-1px; }
    td.mark.is-selected{ background:#bfe0dc !important; outline:2px solid #146b64; outline-offset:-2px; }
  `;
  doc.head.appendChild(style);

  Array.from(doc.querySelectorAll('td.mark[data-row-id]')).forEach((td) => {
    td.addEventListener('click', () => onMarkClick(td, semester, container));
  });
}

function onMarkClick(td, semester, container) {
  const rowId = td.getAttribute('data-row-id');
  const bulan = td.getAttribute('data-bulan');
  const minggu = Number(td.getAttribute('data-minggu'));
  const filled = td.classList.contains('is-filled');
  const sel = selected[semester];

  if (!sel) {
    if (!filled) return; // nothing to move from an empty cell
    selected[semester] = { rowId, bulan, minggu };
    td.classList.add('is-selected');
    return;
  }

  if (sel.rowId === rowId && sel.bulan === bulan && sel.minggu === minggu) {
    td.classList.remove('is-selected'); // clicked the same cell again — cancel
    selected[semester] = null;
    return;
  }

  if (sel.rowId !== rowId) {
    toast('Pindahkan JP hanya di dalam baris (unit/sumatif) yang sama.', { error: true });
    selected[semester] = null;
    return;
  }

  if (filled) {
    toast('Pilih minggu yang masih kosong sebagai tujuan pemindahan.', { error: true });
    return;
  }

  const semData = semester === 1 ? computed.semester1 : computed.semester2;
  const newCells = moveProsemCell(semData, rowId, { bulan: sel.bulan, minggu: sel.minggu }, { bulan, minggu });
  selected[semester] = null;
  if (!newCells) {
    toast('Tidak bisa memindahkan JP ke minggu itu.', { error: true });
    return;
  }
  const overrides = Object.assign({}, state.spine.prosem.overrides, { [rowId]: { manual: true, cells: newCells } });
  setProsem({ overrides });
  toast('JP dipindahkan.');
  recomputeAndRender(container);
}

async function onNext(container) {
  if (!computed || (!computed.semester1.rows.length && !computed.semester2.rows.length)) {
    return toast('Prosem belum terbentuk.', { error: true });
  }
  const btn = container.querySelector('#btn-next');
  btn.disabled = true; btn.textContent = 'Menyimpan…';
  const ok = await setStage('rpp');
  btn.disabled = false; btn.textContent = 'Simpan & Lanjut →';
  if (ok) location.hash = '#/rpp';
}
