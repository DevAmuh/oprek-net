// =============================================================
// Pemeran — Stage: ATP/Prota
// -------------------------------------------------------------
// AI groups TPs into 3-5-per-unit units (pipeline.buildUnits verifies
// coverage + computes JP). Manual editing (rename, move TP chips
// between units, reorder, change semester) re-runs buildUnits so JP
// figures stay correct after every edit. "Tampilan Prota" toggles to
// the aggregated per-semester view (pipeline.aggregateProta).
// =============================================================

import { state, setUnits, setSumatif, setStage } from '../state.js';
import { toast } from '../api.js';
import { callAi } from '../aiApi.js';
import { buildUnits, aggregateProta } from '../pipeline.js';
import { badgeHtml } from '../validate.js';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let units = [];
let sumatif = [];
let showProta = false;
let rootEl = null;

const SUMATIF_DEFAULT_FALLBACK = [
  { jenis: 'STS1', jp: 2, semester: 1 },
  { jenis: 'SAS', jp: 2, semester: 1 },
  { jenis: 'STS2', jp: 2, semester: 2 },
  { jenis: 'SAT', jp: 2, semester: 2 },
];

async function loadKonstanta() {
  try {
    const res = await fetch('data/konstanta.json', { cache: 'no-store' });
    if (!res.ok) return null;
    return res.json();
  } catch (e) {
    return null;
  }
}

function persistUnits() { setUnits(units); }
function persistSumatif() { setSumatif(sumatif); }

export async function render(container) {
  rootEl = container;
  const tps = state.spine.tps || [];
  if (!tps.length) {
    container.innerHTML = '<div class="placeholder card"><div class="big-icon">⚠️</div><h2>Belum ada TP</h2><p class="muted">Lengkapi tahap TP dan KKTP terlebih dahulu.</p></div>';
    return;
  }

  units = Array.isArray(state.spine.units) ? state.spine.units.map((u) => ({ ...u, tpKodes: [...u.tpKodes] })) : [];
  sumatif = Array.isArray(state.spine.sumatif) && state.spine.sumatif.length
    ? state.spine.sumatif.map((s) => ({ ...s }))
    : null;

  if (!sumatif) {
    const k = await loadKonstanta();
    sumatif = (k && Array.isArray(k.sumatifDefault) ? k.sumatifDefault : SUMATIF_DEFAULT_FALLBACK).map((s) => ({ ...s }));
    persistSumatif();
  }

  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg">
        <div class="row-between">
          <h2>ATP &amp; Prota</h2>
          <div class="row" style="gap:6px;"><span class="chip">${tps.length} TP</span>${badgeHtml(state.spine, 'atp')}</div>
        </div>
        <p class="muted small">AI mengelompokkan TP menjadi unit (3-5 TP/unit) terurut prasyarat→kesulitan, lalu JP dihitung otomatis agar totalnya persis sama dengan alokasi resmi.</p>
        <div class="row">
          <button class="btn btn-primary btn-lg" id="btn-generate">✨ Buatkan ATP dengan AI</button>
          <button class="btn btn-outline" id="btn-dummy">Isi Contoh (tanpa AI)</button>
          <button class="btn btn-ghost" id="btn-toggle-prota" type="button">${showProta ? 'Tampilan Unit' : 'Tampilan Prota'}</button>
        </div>
      </div>
      <div id="jp-bar"></div>
      <div id="atp-body"></div>
      <div class="row-between">
        <span></span>
        <button class="btn btn-primary btn-lg" id="btn-next">Simpan &amp; Lanjut →</button>
      </div>
    </div>
  `;

  renderAll(container);

  container.querySelector('#btn-generate').addEventListener('click', () => onGenerate(container, true));
  container.querySelector('#btn-dummy').addEventListener('click', () => onGenerate(container, false));
  container.querySelector('#btn-toggle-prota').addEventListener('click', () => {
    showProta = !showProta;
    render(container);
  });
  container.querySelector('#btn-next').addEventListener('click', () => onNext(container));
}

function renderAll(container) {
  renderJpBar(container);
  if (showProta) renderProtaView(container); else renderUnitCards(container);
}

function renderJpBar(container) {
  const el = container.querySelector('#jp-bar');
  const totalJpTahun = Number(state.spine.config.totalJpTahun) || 0;
  const sumUnits = units.reduce((s, u) => s + (Number(u.jp) || 0), 0);
  const sumSumatif = sumatif.reduce((s, x) => s + (Number(x.jp) || 0), 0);
  const total = sumUnits + sumSumatif;
  const good = totalJpTahun > 0 && total === totalJpTahun;
  el.innerHTML = `
    <div class="card" style="background:${good ? 'var(--good-soft)' : 'var(--warn-soft)'};">
      <strong>Total JP: ${total}</strong> ${totalJpTahun ? `/ target ${totalJpTahun} JP/tahun` : '(target JP/tahun belum diisi di tahap Data)'}
      ${good ? ' ✓ sesuai' : (totalJpTahun ? ' — belum sesuai target' : '')}
      <div class="muted small">Unit: ${sumUnits} JP &middot; Sumatif: ${sumSumatif} JP</div>
    </div>
  `;
}

function recompute() {
  const tps = state.spine.tps || [];
  const config = state.spine.config;
  const aiUnitsShape = units.map((u) => ({ id: u.id, nama: u.nama, tpKodes: u.tpKodes, bobot: u.bobot, semester: u.semester }));
  const { units: rebuilt, errors } = buildUnits(aiUnitsShape, tps, config, sumatif);
  if (errors.length) {
    toast('Gagal memperbarui ATP: ' + errors[0], { error: true });
    return false;
  }
  units = rebuilt;
  persistUnits();
  return true;
}

async function onGenerate(container, useAi) {
  const tps = state.spine.tps || [];
  const config = state.spine.config;
  const mapel = state.spine.header.mapel;
  const kelas = state.spine.header.kelas;
  const nUnitsHint = Math.max(1, Math.round(tps.length / 4));

  const btns = container.querySelectorAll('.card .row button');
  btns.forEach((b) => { b.disabled = true; });

  try {
    let aiUnitsShape;
    if (useAi) {
      let r = await callAi('generate_atp', { planId: state.planId, tps, nUnitsHint, mapel, kelas });
      let attempt = buildUnits(r.units, tps, config, sumatif);
      if (attempt.errors.length) {
        // Plan: "one retry, then surface" — resend with the validation
        // feedback baked into the prompt.
        toast('Validasi ATP gagal, mencoba ulang sekali…');
        r = await callAi('generate_atp', { planId: state.planId, tps, nUnitsHint, mapel, kelas, retryFeedback: attempt.errors.join('; ') });
        attempt = buildUnits(r.units, tps, config, sumatif);
      }
      if (attempt.errors.length) {
        toast('ATP tidak valid setelah 2 percobaan: ' + attempt.errors[0], { error: true });
        return;
      }
      units = attempt.units;
      persistUnits();
    } else {
      aiUnitsShape = dummyUnits(tps);
      const attempt = buildUnits(aiUnitsShape, tps, config, sumatif);
      if (attempt.errors.length) {
        toast('Gagal membuat contoh ATP: ' + attempt.errors[0], { error: true });
        return;
      }
      units = attempt.units;
      persistUnits();
    }
    renderAll(container);
    toast(useAi ? 'ATP berhasil dibuat oleh AI.' : 'ATP contoh berhasil diisi (offline, tanpa AI).');
  } catch (e) {
    // already toasted
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function dummyUnits(tps) {
  const chunkSize = 4;
  const out = [];
  for (let i = 0; i < tps.length; i += chunkSize) {
    const chunk = tps.slice(i, i + chunkSize);
    out.push({
      nama: `Unit ${out.length + 1} (contoh)`,
      tpKodes: chunk.map((t) => t.kode),
      bobot: 1,
      semester: out.length % 2 === 0 ? 1 : 2,
    });
  }
  // Rebalance semester roughly 50/50 by unit count rather than strict alternation
  // when there's an odd number of units, alternation above already does this well enough.
  return out;
}

function renderUnitCards(container) {
  const el = container.querySelector('#atp-body');
  const tps = state.spine.tps || [];
  if (!units.length) {
    el.innerHTML = '<div class="card"><p class="muted">Belum ada unit ATP. Klik "Buatkan ATP dengan AI" atau "Isi Contoh" di atas.</p></div>';
    return;
  }

  const unitOptions = (excludeId) => units.filter((u) => u.id !== excludeId).map((u) => `<option value="${u.id}">${escapeHtml(u.nama)}</option>`).join('');

  el.innerHTML = `
    <div class="stack">
      ${units.map((u, idx) => `
        <div class="card" data-unit="${u.id}">
          <div class="row-between">
            <input type="text" class="in-unit-nama" data-id="${u.id}" value="${escapeHtml(u.nama)}" style="font-weight:700; font-size:1.1rem; border:none; background:transparent; padding:2px 0;">
            <div class="row" style="gap:6px;">
              <button type="button" class="btn-arrow" data-up="${u.id}" title="Naikkan urutan" ${idx === 0 ? 'disabled' : ''}>▲</button>
              <button type="button" class="btn-arrow" data-down="${u.id}" title="Turunkan urutan" ${idx === units.length - 1 ? 'disabled' : ''}>▼</button>
              <select class="in-semester" data-id="${u.id}">
                <option value="1" ${u.semester === 1 ? 'selected' : ''}>Ganjil</option>
                <option value="2" ${u.semester === 2 ? 'selected' : ''}>Genap</option>
              </select>
              <span class="chip chip-accent">${u.jp} JP</span>
            </div>
          </div>
          <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:8px;">
            ${u.tpKodes.map((kode) => {
              const tp = tps.find((t) => t.kode === kode);
              return `
                <div class="chip" style="background:#fff; border:1px solid var(--line-strong); display:flex; gap:6px; align-items:center;">
                  <span title="${escapeHtml(tp ? tp.rumusan : '')}"><strong>${escapeHtml(kode)}</strong></span>
                  <select class="in-move-tp" data-kode="${kode}" data-from="${u.id}" style="min-height:28px; font-size:0.8rem;">
                    <option value="">pindah ke…</option>
                    ${unitOptions(u.id)}
                  </select>
                </div>`;
            }).join('') || '<span class="muted small">(unit ini belum berisi TP)</span>'}
          </div>
          <button type="button" class="btn-ghost" data-delete-unit="${u.id}" style="margin-top:8px; border:none; background:none; color:var(--bad); cursor:pointer;">Hapus unit (kosongkan dulu)</button>
        </div>
      `).join('')}
    </div>
    <div class="card" style="margin-top:var(--space-3);">
      <h3>Asesmen Sumatif</h3>
      <div class="grid grid-3">
        ${sumatif.map((s, i) => `
          <div class="field" style="margin-bottom:0;">
            <label>${escapeHtml(s.jenis)} (Semester ${s.semester === 2 ? 'Genap' : 'Ganjil'})</label>
            <input type="number" class="in-sumatif-jp" data-i="${i}" min="0" max="20" value="${s.jp}">
          </div>
        `).join('')}
      </div>
    </div>
    <button class="btn btn-ghost" id="btn-add-unit" type="button" style="margin-top:var(--space-3);">+ Tambah unit kosong</button>
  `;

  el.querySelectorAll('.in-unit-nama').forEach((inp) => inp.addEventListener('input', (ev) => {
    const u = units.find((x) => x.id === ev.target.dataset.id);
    if (u) { u.nama = ev.target.value; persistUnits(); }
  }));
  el.querySelectorAll('.in-semester').forEach((sel) => sel.addEventListener('change', (ev) => {
    const u = units.find((x) => x.id === ev.target.dataset.id);
    if (u) { u.semester = Number(ev.target.value); if (recompute()) renderAll(rootEl); }
  }));
  el.querySelectorAll('[data-up]').forEach((btn) => btn.addEventListener('click', (ev) => {
    moveUnit(ev.currentTarget.dataset.up, -1);
  }));
  el.querySelectorAll('[data-down]').forEach((btn) => btn.addEventListener('click', (ev) => {
    moveUnit(ev.currentTarget.dataset.down, 1);
  }));
  el.querySelectorAll('.in-move-tp').forEach((sel) => sel.addEventListener('change', (ev) => {
    const target = ev.target.value;
    if (!target) return;
    const kode = ev.target.dataset.kode;
    const fromId = ev.target.dataset.from;
    const fromUnit = units.find((u) => u.id === fromId);
    const toUnit = units.find((u) => u.id === target);
    if (!fromUnit || !toUnit) return;
    fromUnit.tpKodes = fromUnit.tpKodes.filter((k) => k !== kode);
    toUnit.tpKodes.push(kode);
    if (recompute()) renderAll(rootEl);
  }));
  el.querySelectorAll('[data-delete-unit]').forEach((btn) => btn.addEventListener('click', (ev) => {
    const id = ev.currentTarget.dataset.deleteUnit;
    const u = units.find((x) => x.id === id);
    if (u && u.tpKodes.length) return toast('Pindahkan semua TP di unit ini dulu sebelum menghapusnya.', { error: true });
    units = units.filter((x) => x.id !== id);
    persistUnits();
    renderAll(rootEl);
  }));
  el.querySelectorAll('.in-sumatif-jp').forEach((inp) => inp.addEventListener('input', (ev) => {
    sumatif[Number(ev.target.dataset.i)].jp = Number(ev.target.value) || 0;
    persistSumatif();
    if (recompute()) renderAll(rootEl); else renderJpBar(rootEl);
  }));
  const addBtn = el.querySelector('#btn-add-unit');
  if (addBtn) addBtn.addEventListener('click', () => {
    units.push({ id: 'unit_' + Date.now().toString(36), nama: `Unit ${units.length + 1}`, tpKodes: [], bobot: 1, jp: 0, semester: 1, urutan: units.length + 1 });
    persistUnits();
    renderAll(rootEl);
  });
}

function moveUnit(id, dir) {
  const i = units.findIndex((u) => u.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= units.length) return;
  const tmp = units[i];
  units[i] = units[j];
  units[j] = tmp;
  units.forEach((u, idx) => { u.urutan = idx + 1; });
  persistUnits();
  renderAll(rootEl);
}

function renderProtaView(container) {
  const el = container.querySelector('#atp-body');
  const prota = aggregateProta(units, sumatif);
  const semBlock = (sem, data) => `
    <div class="card">
      <h3>Semester ${sem === 1 ? 'Ganjil' : 'Genap'} — ${data.totalJp} JP</h3>
      <table style="width:100%; border-collapse:collapse;">
        <thead><tr style="text-align:left; border-bottom:2px solid var(--line-strong);">
          <th style="padding:6px;">Unit Pembelajaran</th><th style="padding:6px;">Kode TP Tercakup</th><th style="padding:6px; width:70px;">JP</th>
        </tr></thead>
        <tbody>
          ${data.items.map((it) => it.tipe === 'unit' ? `
            <tr style="border-bottom:1px solid var(--line);">
              <td style="padding:6px;">${escapeHtml(it.ref.nama)}</td>
              <td style="padding:6px;" class="small muted">${it.ref.tpKodes.map(escapeHtml).join(', ')}</td>
              <td style="padding:6px;">${it.jp}</td>
            </tr>` : `
            <tr style="border-bottom:1px solid var(--line); background:var(--bg-soft);">
              <td style="padding:6px;" colspan="2"><em>${escapeHtml(it.ref.jenis)}</em></td>
              <td style="padding:6px;">${it.jp}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
  el.innerHTML = `<div class="stack">${semBlock(1, prota.semester1)}${semBlock(2, prota.semester2)}
    <div class="card"><strong>Total JP Tahun: ${prota.totalJpTahun}</strong></div></div>`;
}

async function onNext(container) {
  if (!units.length) return toast('Buat ATP dulu sebelum lanjut.', { error: true });
  const btn = container.querySelector('#btn-next');
  btn.disabled = true; btn.textContent = 'Menyimpan…';
  const ok = await setStage('prosem');
  btn.disabled = false; btn.textContent = 'Simpan & Lanjut →';
  if (ok) location.hash = '#/prosem';
}
