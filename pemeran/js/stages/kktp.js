// =============================================================
// Pemeran — Stage: KKTP (Kriteria Ketercapaian Tujuan Pembelajaran)
// -------------------------------------------------------------
// One KKTP per TP (kode = "KKTP-"+tpKode — pipeline.assignKktpCodes).
// Table: metode badge, kriteria editable, per-row 🔄 regenerate.
// =============================================================

import { state, setKktps, setStage } from '../state.js';
import { toast } from '../api.js';
import { callAi } from '../aiApi.js';
import { assignKktpCodes } from '../pipeline.js';
import { badgeHtml } from '../validate.js';

const METODE_OPTIONS = ['Deskripsi', 'Rubrik', 'Interval'];
const DUMMY_METODE_BY_BLOOM = { C1: 'Interval', C2: 'Deskripsi', C3: 'Rubrik', C4: 'Rubrik', C5: 'Deskripsi', C6: 'Rubrik' };

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function dummyItems(tps) {
  return tps.map((t) => {
    const metode = DUMMY_METODE_BY_BLOOM[t.bloom] || 'Deskripsi';
    return {
      metode,
      kriteria: metode === 'Interval'
        ? '' // pipeline fills the konstanta default interval table
        : `Peserta didik menunjukkan bukti konkret pencapaian "${t.rumusan.replace(/^Peserta didik dapat /i, '')}" (contoh — lengkapi kriteria sesungguhnya).`,
      instrumen: metode === 'Interval' ? 'Tes tertulis' : (metode === 'Rubrik' ? 'Rubrik penilaian produk/kinerja' : 'Lembar observasi/penilaian kualitatif'),
    };
  });
}

let kktps = [];

function persist() {
  setKktps(kktps);
}

export async function render(container) {
  const tps = state.spine.tps || [];
  kktps = Array.isArray(state.spine.kktps) ? state.spine.kktps.map((k) => ({ ...k })) : [];

  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg">
        <div class="row-between">
          <h2>Kriteria Ketercapaian TP (KKTP)</h2>
          <div class="row" style="gap:6px;"><span class="chip">${tps.length} TP</span>${badgeHtml(state.spine, 'kktp')}</div>
        </div>
        <p class="muted small">Setiap TP wajib punya minimal satu KKTP. Metode dipilih otomatis via pohon keputusan SOP §6.2 (Deskripsi / Rubrik / Interval) — sunting kriteria sesuai kebutuhan.</p>
        <div class="row">
          <button class="btn btn-primary btn-lg" id="btn-generate">✨ Buatkan KKTP dengan AI</button>
          <button class="btn btn-outline" id="btn-dummy">Isi Contoh (tanpa AI)</button>
        </div>
      </div>
      <div class="card card-pad-lg" id="kktp-table-card"></div>
      <div class="row-between">
        <span></span>
        <button class="btn btn-primary btn-lg" id="btn-next">Simpan &amp; Lanjut →</button>
      </div>
    </div>
  `;

  renderTable(container);

  container.querySelector('#btn-generate').addEventListener('click', () => onGenerate(container, true));
  container.querySelector('#btn-dummy').addEventListener('click', () => onGenerate(container, false));
  container.querySelector('#btn-next').addEventListener('click', () => onNext(container));
}

async function onGenerate(container, useAi) {
  const tps = state.spine.tps || [];
  if (!tps.length) return toast('Buat TP dulu di tahap sebelumnya.', { error: true });

  const btns = container.querySelectorAll('.card .row button');
  btns.forEach((b) => { b.disabled = true; });
  try {
    let items;
    if (useAi) {
      const r = await callAi('generate_kktp', { planId: state.planId, tps });
      items = r.items;
    } else {
      items = dummyItems(tps);
    }
    const { kktps: built, warnings } = assignKktpCodes(tps, items, undefined, state.spine.config.kktpThreshold);
    kktps = built;
    persist();
    renderTable(container);
    toast(useAi ? 'KKTP berhasil dibuat oleh AI.' : 'KKTP contoh berhasil diisi (offline, tanpa AI).');
    if (warnings.length) toast(warnings[0], { error: true });
  } catch (e) {
    // already toasted
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function renderTable(container) {
  const card = container.querySelector('#kktp-table-card');
  const tps = state.spine.tps || [];
  if (!kktps.length) {
    card.innerHTML = '<p class="muted">Belum ada KKTP. Klik "Buatkan KKTP dengan AI" atau "Isi Contoh" di atas.</p>';
    return;
  }

  card.innerHTML = `
    <div style="overflow-x:auto;">
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="text-align:left; border-bottom:2px solid var(--line-strong);">
            <th style="padding:8px 6px; width:150px;">Kode KKTP</th>
            <th style="padding:8px 6px; width:130px;">Metode</th>
            <th style="padding:8px 6px;">Kriteria</th>
            <th style="padding:8px 6px; width:160px;">Instrumen</th>
            <th style="padding:8px 6px; width:50px;"></th>
          </tr>
        </thead>
        <tbody id="kktp-tbody"></tbody>
      </table>
    </div>
  `;

  const tbody = card.querySelector('#kktp-tbody');
  tbody.innerHTML = kktps.map((k, i) => {
    const tp = tps.find((t) => t.kode === k.tpKode);
    return `
    <tr data-i="${i}" style="border-bottom:1px solid var(--line);">
      <td style="padding:6px; vertical-align:top;">
        <div style="font-weight:700;">${escapeHtml(k.kode)}</div>
        <div class="muted small">${escapeHtml(tp ? tp.rumusan : k.tpKode)}</div>
      </td>
      <td style="padding:6px; vertical-align:top;">
        <select class="in-metode" data-i="${i}">
          ${METODE_OPTIONS.map((m) => `<option value="${m}" ${k.metode === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select>
      </td>
      <td style="padding:6px;"><textarea class="in-kriteria" data-i="${i}" rows="2" style="min-height:auto;">${escapeHtml(k.kriteria)}</textarea></td>
      <td style="padding:6px;"><input type="text" class="in-instrumen" data-i="${i}" value="${escapeHtml(k.instrumen)}"></td>
      <td style="padding:6px; vertical-align:top; white-space:nowrap;">
        <button type="button" data-regen="${i}" title="Regenerasi dengan AI" style="border:none;background:none;cursor:pointer;font-size:1.1rem;">🔄</button>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.in-metode').forEach((el) => el.addEventListener('change', (ev) => {
    kktps[Number(ev.target.dataset.i)].metode = ev.target.value;
    persist();
  }));
  tbody.querySelectorAll('.in-kriteria').forEach((el) => el.addEventListener('input', (ev) => {
    kktps[Number(ev.target.dataset.i)].kriteria = ev.target.value;
    persist();
  }));
  tbody.querySelectorAll('.in-instrumen').forEach((el) => el.addEventListener('input', (ev) => {
    kktps[Number(ev.target.dataset.i)].instrumen = ev.target.value;
    persist();
  }));
  tbody.querySelectorAll('[data-regen]').forEach((el) => el.addEventListener('click', (ev) => onRegenRow(container, Number(ev.currentTarget.dataset.regen))));
}

async function onRegenRow(container, i) {
  const k = kktps[i];
  if (!k) return;
  const tp = (state.spine.tps || []).find((t) => t.kode === k.tpKode) || {};
  toast('Meregenerasi ' + k.kode + '…');
  try {
    const r = await callAi('regenerate_item', {
      planId: state.planId,
      target: 'kktp',
      context: { tpKode: k.tpKode, tpRumusan: tp.rumusan || '' },
      current: { metode: k.metode, kriteria: k.kriteria },
    });
    kktps[i] = { ...k, metode: r.value.metode, kriteria: r.value.kriteria, instrumen: r.value.instrumen };
    persist();
    renderTable(container);
    toast(k.kode + ' berhasil diregenerasi.');
  } catch (e) {
    // already toasted
  }
}

async function onNext(container) {
  const tps = state.spine.tps || [];
  if (!kktps.length) return toast('Buat KKTP dulu sebelum lanjut.', { error: true });
  const missing = tps.filter((t) => !kktps.some((k) => k.tpKode === t.kode));
  if (missing.length) return toast(`${missing.length} TP belum punya KKTP.`, { error: true });

  const btn = container.querySelector('#btn-next');
  btn.disabled = true; btn.textContent = 'Menyimpan…';
  const ok = await setStage('atp');
  btn.disabled = false; btn.textContent = 'Simpan & Lanjut →';
  if (ok) location.hash = '#/atp';
}
