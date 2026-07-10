// =============================================================
// Pemeran — Stage: Prosem (Program Semester)
// -------------------------------------------------------------
// NO AI (plan's owner decision #6 — Kaldik skipped, auto-distribute
// from yearly JP). Only knob = effective weeks per semester. Preview
// reuses the same renderer the Ekspor screen's export buttons will use.
// =============================================================

import { state, setProsem, setStage } from '../state.js';
import { toast } from '../api.js';
import { distributeProsem } from '../pipeline.js';
import { renderProsemHtml } from '../render/prosem.js';
import { badgeHtml } from '../validate.js';

let computed = null; // pipeline.distributeProsem() output, kept for the preview + persistence

function flattenRows(computedResult) {
  const rows = [];
  for (const sem of [1, 2]) {
    const data = sem === 1 ? computedResult.semester1 : computedResult.semester2;
    for (const row of data.rows) {
      for (const cell of row.cells) {
        rows.push({ semester: sem, bulan: cell.bulan, minggu: cell.minggu, materi: row.materi, jp: cell.jp, keterangan: '' });
      }
    }
  }
  return rows;
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

  // Compute + persist rows BEFORE building the header/badge markup below —
  // badgeHtml() reads state.spine.prosem.rows synchronously, so if this ran
  // after innerHTML was set (as it originally did, inside recomputeAndRender
  // at the bottom of this function) the badge would always show one step
  // stale (e.g. still "Prosem belum dibuat" right after the rows it needs
  // were actually computed).
  computeAndPersist();

  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg">
        <div class="row-between">
          <h2>Program Semester (Prosem)</h2>
          ${badgeHtml(state.spine, 'prosem')}
        </div>
        <p class="muted small">Unit ATP didistribusikan otomatis ke minggu efektif tiap semester (tanpa kalender pendidikan sekolah — jadwal generik, sesuaikan bila perlu). Kolom "Keterangan" dikosongkan karena Kaldik tidak dipakai.</p>
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
      </div>
      <div class="card card-pad-lg" id="prosem-summary"></div>
      <div class="card card-pad-lg">
        <h3>Pratinjau — Semester Ganjil</h3>
        <div style="overflow:auto; border:1px solid var(--line); border-radius:8px; max-height:70vh;">
          <iframe id="prosem-iframe-1" title="Pratinjau Prosem Ganjil" style="width:100%; min-height:600px; border:0; display:block;"></iframe>
        </div>
      </div>
      <div class="card card-pad-lg">
        <h3>Pratinjau — Semester Genap</h3>
        <div style="overflow:auto; border:1px solid var(--line); border-radius:8px; max-height:70vh;">
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
  container.querySelector('#btn-next').addEventListener('click', () => onNext(container));
}

/** Synchronous: run the deterministic distribution and persist rows to the
 *  spine. Split out from the (async) preview rendering below so callers that
 *  need fresh rows before building header/badge markup can call this alone. */
function computeAndPersist() {
  const { units, sumatif, config, header } = state.spine;
  computed = distributeProsem(units, sumatif, config, header.kelas);
  setProsem({ rows: flattenRows(computed) });
}

async function recomputeAndRender(container) {
  computeAndPersist();
  const { header, cp, tps, units, config } = state.spine;

  const summary = container.querySelector('#prosem-summary');
  summary.innerHTML = `
    <div class="row-between">
      <span><strong>Semester Ganjil:</strong> ${computed.semester1.totalJp} JP dalam ${state.spine.prosem.mingguEfektif.ganjil} minggu efektif</span>
      <span><strong>Semester Genap:</strong> ${computed.semester2.totalJp} JP dalam ${state.spine.prosem.mingguEfektif.genap} minggu efektif</span>
    </div>
  `;

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
    } catch (e) {
      toast('Gagal merender pratinjau Prosem: ' + String((e && e.message) || e), { error: true });
    }
  }
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
