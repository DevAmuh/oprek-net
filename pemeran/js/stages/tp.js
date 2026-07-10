// =============================================================
// Pemeran — Stage: TP (Tujuan Pembelajaran)
// -------------------------------------------------------------
// "Buatkan TP" (per elemen CP) -> pipeline.assignTpCodes() locks in
// codes D.<kelas>.<noCP>.<noTP>. Editable table: kode locked, rumusan
// editable, bloom dropdown, add/remove row, per-row 🔄 regenerate
// (regenerate_item). "Isi Contoh" gives an offline canned decomposition
// so the whole chain is walkable without an API key.
// =============================================================

import { state, setTps, setStage } from '../state.js';
import { toast } from '../api.js';
import { callAi } from '../aiApi.js';
import { assignTpCodes } from '../pipeline.js';
import { badgeHtml } from '../validate.js';

const BLOOM_OPTIONS = [
  ['C1', 'C1 — Mengingat'], ['C2', 'C2 — Memahami'], ['C3', 'C3 — Menerapkan'],
  ['C4', 'C4 — Menganalisis'], ['C5', 'C5 — Mengevaluasi'], ['C6', 'C6 — Mencipta'],
];
const DUMMY_VERBS = ['menjelaskan', 'mengidentifikasi', 'menerapkan', 'membandingkan', 'menganalisis'];
const DUMMY_BLOOMS = ['C2', 'C1', 'C3', 'C2', 'C4'];

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function dummyPerElemen(elemenList) {
  return elemenList.map((el) => Array.from({ length: 3 }, (_, i) => ({
    rumusan: `${DUMMY_VERBS[i % DUMMY_VERBS.length]} aspek terkait ${el.nama.toLowerCase()} (contoh — ganti dengan hasil AI sesungguhnya)`,
    bloom: DUMMY_BLOOMS[i % DUMMY_BLOOMS.length],
  })));
}

let tps = [];

function persist() {
  setTps(tps);
}

export async function render(container) {
  const cp = state.spine.cp;
  tps = Array.isArray(state.spine.tps) ? state.spine.tps.map((t) => ({ ...t })) : [];

  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg">
        <div class="row-between">
          <h2>Tujuan Pembelajaran (TP)</h2>
          <div class="row" style="gap:6px;"><span class="chip">${cp.elemen.length} elemen CP</span>${badgeHtml(state.spine, 'tp')}</div>
        </div>
        <p class="muted small">TP memecah tiap elemen CP menjadi kompetensi operasional & terukur. Kode (D.&lt;kelas&gt;.&lt;no CP&gt;.&lt;no TP&gt;) ditetapkan otomatis dan tidak berubah lagi setelah ini.</p>
        <div class="row" id="tp-actions">
          <button class="btn btn-primary btn-lg" id="btn-generate">✨ Buatkan TP dengan AI</button>
          <button class="btn btn-outline" id="btn-dummy">Isi Contoh (tanpa AI)</button>
          ${tps.length ? '<button class="btn btn-ghost" id="btn-regen-all">↻ Buat ulang semua</button>' : ''}
        </div>
      </div>
      <div class="card card-pad-lg" id="tp-table-card"></div>
      <div class="row-between">
        <span class="muted small" id="tp-count-hint"></span>
        <button class="btn btn-primary btn-lg" id="btn-next">Simpan &amp; Lanjut →</button>
      </div>
    </div>
  `;

  renderTable(container);
  updateHint(container);

  container.querySelector('#btn-generate').addEventListener('click', () => onGenerate(container, true));
  container.querySelector('#btn-dummy').addEventListener('click', () => onGenerate(container, false));
  const regenAllBtn = container.querySelector('#btn-regen-all');
  if (regenAllBtn) regenAllBtn.addEventListener('click', () => onGenerate(container, true));

  container.querySelector('#btn-next').addEventListener('click', () => onNext(container));
}

async function onGenerate(container, useAi) {
  const cp = state.spine.cp;
  if (!cp.elemen.length) return toast('CP belum diisi — lengkapi tahap CP dulu.', { error: true });
  const kelas = state.spine.header.kelas;

  const btns = container.querySelectorAll('#tp-actions button');
  btns.forEach((b) => { b.disabled = true; });

  try {
    let perElemenTps;
    if (useAi) {
      const r = await callAi('generate_tp', { planId: state.planId, cp: { elemen: cp.elemen }, kelas, mapel: state.spine.header.mapel });
      perElemenTps = r.perElemen.map((e) => e.tps);
    } else {
      perElemenTps = dummyPerElemen(cp.elemen);
    }
    const { tps: built, warnings } = assignTpCodes(cp.elemen, perElemenTps, kelas);
    tps = built;
    persist();
    renderTable(container);
    updateHint(container);
    toast(useAi ? 'TP berhasil dibuat oleh AI.' : 'TP contoh berhasil diisi (offline, tanpa AI).');
    if (warnings.length) toast(warnings[0], { error: true });
  } catch (e) {
    // callAi already toasted
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function renderTable(container) {
  const card = container.querySelector('#tp-table-card');
  if (!tps.length) {
    card.innerHTML = '<p class="muted">Belum ada TP. Klik "Buatkan TP dengan AI" atau "Isi Contoh" di atas.</p>';
    return;
  }

  card.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="text-align:left; border-bottom:2px solid var(--line-strong);">
            <th style="padding:8px 6px; width:110px;">Kode</th>
            <th style="padding:8px 6px; width:140px;">Elemen</th>
            <th style="padding:8px 6px;">Rumusan TP</th>
            <th style="padding:8px 6px; width:170px;">Bloom</th>
            <th style="padding:8px 6px; width:70px;"></th>
          </tr>
        </thead>
        <tbody id="tp-tbody"></tbody>
      </table>
    </div>
    <button class="btn btn-ghost" id="btn-add-tp" type="button">+ Tambah TP manual</button>
  `;

  const tbody = card.querySelector('#tp-tbody');
  tbody.innerHTML = tps.map((t, i) => `
    <tr data-i="${i}" style="border-bottom:1px solid var(--line);">
      <td style="padding:6px; font-weight:700; vertical-align:top;">${escapeHtml(t.kode)}</td>
      <td style="padding:6px; vertical-align:top;">${escapeHtml(t.elemen)}</td>
      <td style="padding:6px;"><textarea class="in-rumusan" data-i="${i}" rows="2" style="min-height:auto;">${escapeHtml(t.rumusan)}</textarea></td>
      <td style="padding:6px; vertical-align:top;">
        <select class="in-bloom" data-i="${i}">
          <option value="">—</option>
          ${BLOOM_OPTIONS.map(([v, label]) => `<option value="${v}" ${t.bloom === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </td>
      <td style="padding:6px; vertical-align:top; white-space:nowrap;">
        <button type="button" class="btn-ghost" data-regen="${i}" title="Regenerasi dengan AI" style="border:none;background:none;cursor:pointer;font-size:1.1rem;">🔄</button>
        <button type="button" class="btn-ghost" data-remove="${i}" title="Hapus" style="border:none;background:none;cursor:pointer;font-size:1.1rem;">🗑</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('.in-rumusan').forEach((el) => el.addEventListener('input', (ev) => {
    tps[Number(ev.target.dataset.i)].rumusan = ev.target.value;
    persist();
  }));
  tbody.querySelectorAll('.in-bloom').forEach((el) => el.addEventListener('change', (ev) => {
    tps[Number(ev.target.dataset.i)].bloom = ev.target.value || null;
    persist();
  }));
  tbody.querySelectorAll('[data-remove]').forEach((el) => el.addEventListener('click', (ev) => {
    tps.splice(Number(ev.currentTarget.dataset.remove), 1);
    persist();
    renderTable(container);
    updateHint(container);
  }));
  tbody.querySelectorAll('[data-regen]').forEach((el) => el.addEventListener('click', (ev) => onRegenRow(container, Number(ev.currentTarget.dataset.regen))));

  card.querySelector('#btn-add-tp').addEventListener('click', () => {
    const lastElemen = tps.length ? tps[tps.length - 1].elemen : (state.spine.cp.elemen[0] || {}).nama;
    // Recompute a plausible next code for this elemen (manual rows use the
    // same D.<kelas>.<noCP>.<noTP> pattern, noTP = count already in that elemen + 1).
    const noCP = state.spine.cp.elemen.findIndex((e) => e.nama === lastElemen) + 1 || 1;
    const noTP = tps.filter((t) => t.elemen === lastElemen).length + 1;
    tps.push({ kode: `D.${state.spine.header.kelas}.${noCP}.${noTP}`, elemen: lastElemen || '', rumusan: 'Peserta didik dapat …', bloom: null });
    persist();
    renderTable(container);
    updateHint(container);
  });
}

async function onRegenRow(container, i) {
  const tp = tps[i];
  if (!tp) return;
  const elemenObj = state.spine.cp.elemen.find((e) => e.nama === tp.elemen) || {};
  const tpLainnya = tps.filter((t, j) => j !== i && t.elemen === tp.elemen).map((t) => t.rumusan);

  toast('Meregenerasi TP ' + tp.kode + '…');
  try {
    const r = await callAi('regenerate_item', {
      planId: state.planId,
      target: 'tp',
      context: { elemenNama: tp.elemen, elemenTeks: elemenObj.teks || '', tpLainnya },
      current: { rumusan: tp.rumusan, bloom: tp.bloom },
    });
    tps[i] = { ...tp, rumusan: r.value.rumusan, bloom: r.value.bloom };
    persist();
    renderTable(container);
    toast('TP ' + tp.kode + ' berhasil diregenerasi.');
  } catch (e) {
    // already toasted
  }
}

function updateHint(container) {
  const el = container.querySelector('#tp-count-hint');
  if (el) el.textContent = tps.length ? `${tps.length} TP di ${new Set(tps.map((t) => t.elemen)).size} elemen.` : '';
}

async function onNext(container) {
  if (!tps.length) return toast('Buat TP dulu sebelum lanjut.', { error: true });
  if (tps.some((t) => !t.rumusan || !t.rumusan.trim())) return toast('Ada TP dengan rumusan kosong.', { error: true });
  const btn = container.querySelector('#btn-next');
  btn.disabled = true; btn.textContent = 'Menyimpan…';
  const ok = await setStage('kktp');
  btn.disabled = false; btn.textContent = 'Simpan & Lanjut →';
  if (ok) location.hash = '#/kktp';
}
