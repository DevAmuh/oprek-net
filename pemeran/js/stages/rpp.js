// =============================================================
// Pemeran — Stage: RPP (M2 vertical slice)
// -------------------------------------------------------------
// ATP/units don't exist until M3, so this stage works from a manual
// "topic stub" mini-form (topik, TP/KKTP pasted as lines, JP,
// semester) instead of a real unit list. Flow:
//   topic stub -> "Buat dengan AI" (generate_rpp) or "Isi Contoh"
//   (local dummy, no backend needed) -> paper preview (iframe) with
//   click-to-edit cells + per-field 🔄 regenerate -> MHT/PDF/HTML export.
//
// Persistence: each generated RPP is stored as {id, unit, content} in
// spine.rpps (see state.js's setRpps — a deliberately ad-hoc M2 shape;
// M3's pipeline.js will reconcile it with the plan's formal
// {unitId, judul, pertemuanCount, fields, pertemuan} spine shape).
// Contenteditable edits made directly in the preview are captured live
// by every export (each export serializes the iframe's current DOM),
// but are NOT reverse-parsed back into the stored `content` object —
// reopening a saved RPP restores the last generated/regenerated
// content, not hand-edits. Full round-tripping of arbitrary
// contenteditable HTML back into the ✓/•/-/**/* mini-syntax is
// deferred; see the M2 report for details.
// =============================================================

import { state, setRpps } from '../state.js';
import { toast } from '../api.js';
import { callAi } from '../aiApi.js';
import { renderRppHtml } from '../render/rpp.js';
import { downloadMht } from '../export/mht.js';
import { printRppHtml } from '../export/pdf.js';
import { exportRppHtml } from '../export/html.js';
import { downloadDocx } from '../export/docx.js';
import { splitMeetings } from '../pipeline.js';
import { badgeHtml, runValidator, overallLevel } from '../validate.js';

const FIELD_LABELS = {
  peserta_didik: 'Peserta Didik',
  materi_pelajaran: 'Materi Pelajaran',
  internalisasi_nilai_agama: 'Internalisasi Nilai Agama',
  capaian_element: 'Capaian — Elemen',
  capaian_competence: 'Capaian — Kompetensi',
  capaian_content: 'Capaian — Konten',
  lintas_disiplin_ilmu: 'Lintas Disiplin Ilmu',
  model: 'Model',
  strategy: 'Strategy',
  method: 'Method',
  kemitraan: 'Kemitraan Pembelajaran',
  lingkungan: 'Lingkungan Pembelajaran',
  digital: 'Pemanfaatan Digital',
  asesmen_awal: 'Asesmen Awal',
  asesmen_proses: 'Asesmen Proses',
  asesmen_akhir: 'Asesmen Akhir',
  learning_media: 'Media, Alat, dan Bahan',
  opening: 'Opening',
  memahami: 'Memahami',
  mengaplikasi: 'Mengaplikasi',
  merefleksi: 'Merefleksikan',
  closing: 'Penutup',
};

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// ---- topic-stub parsing -----------------------------------------------------
function parseCodeLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^([^\s:][^:]*):\s*(.*)$/);
      return m ? { kode: m[1].trim(), rest: m[2].trim() } : { kode: '', rest: line };
    });
}

function parseTpLines(text) {
  return parseCodeLines(text).map((r) => ({ kode: r.kode, rumusan: r.rest }));
}
function parseKktpLines(text) {
  return parseCodeLines(text).map((r) => ({ kode: r.kode, kriteria: r.rest }));
}

function computePertemuanCount(jp, jpPerPertemuan) {
  const jpp = Number(jpPerPertemuan) > 0 ? Number(jpPerPertemuan) : 2;
  return Math.max(1, Math.ceil((Number(jp) || jpp) / jpp));
}

// ---- M3: build the RPP "unit" shape from a real spine.units entry ---------
// (spine.units doesn't exist until the ATP stage runs pipeline.buildUnits —
// until then this stage falls back to the M2 manual topic-stub form below.)
function unitFromAtp(unit) {
  const config = state.spine.config;
  const tps = (state.spine.tps || []).filter((t) => unit.tpKodes.includes(t.kode));
  const kktps = (state.spine.kktps || []).filter((k) => unit.tpKodes.includes(k.tpKode));
  const cpElemenNames = [...new Set(tps.map((t) => t.elemen))];
  const cpElemen = cpElemenNames
    .map((n) => (state.spine.cp.elemen.find((e) => e.nama === n) || {}).teks)
    .filter(Boolean)
    .join('\n\n');
  const { pertemuanCount } = splitMeetings(unit, config);

  return {
    unitId: unit.id,
    topik: unit.nama,
    jp: unit.jp,
    jpPerPertemuan: Number(config.jpPerPertemuan) || 2,
    pertemuanCount,
    semester: unit.semester,
    cpElemen,
    tpList: tps.map((t) => ({ kode: t.kode, rumusan: t.rumusan })),
    kktpList: kktps.map((k) => ({ kode: k.kode, kriteria: k.kriteria })),
  };
}

// ---- local "contoh" fallback (no backend / no API key needed) -------------
function dummyContent(unit) {
  const n = unit.pertemuanCount;
  const pertemuan = Array.from({ length: n }, (_, i) => ({
    opening: `✓ Sapa peserta didik, sampaikan pertanyaan pemantik tentang **${unit.topik}** (Pertemuan ${i + 1}).`,
    memahami: `Perkenalkan konsep inti *${unit.topik}* melalui contoh konkret.\n• Diskusikan istilah kunci bersama.`,
    mengaplikasi: `• Peserta didik mengerjakan latihan singkat terkait ${unit.topik}.\n- Kerja berpasangan/kelompok kecil.`,
    merefleksi: `Pair-share: peserta didik menjelaskan kembali dengan kata sendiri.`,
    closing: `Rangkuman cepat (tanya-jawab) & apresiasi partisipasi.`,
  }));
  return {
    peserta_didik: `Cek pemahaman awal peserta didik tentang **${unit.topik}** melalui tanya jawab singkat.`,
    materi_pelajaran: unit.topik,
    graduate_profile_selected: ['Penalaran Kritis', 'Kemandirian'],
    santri_kitab_selected: ['Komunikasi'],
    internalisasi_nilai_agama: 'QS. Al-Baqarah (2): 164\n"Sesungguhnya dalam penciptaan langit dan bumi... terdapat tanda-tanda bagi kaum yang berpikir."\nMengaitkan fenomena yang dipelajari dengan tanda kekuasaan Allah.',
    capaian_element: `**Elemen contoh**\n*terkait ${unit.topik}*`,
    capaian_competence: 'Menjelaskan, menganalisis, menerapkan',
    capaian_content: `Konsep dasar ${unit.topik}`,
    lintas_disiplin_ilmu: '(contoh) mapel serumpun — konsep terkait',
    model: '**Inquiry-Based Learning (IBL)** — belajar melalui pertanyaan & penyelidikan',
    strategy: 'Cooperative Learning',
    method: 'Demonstrasi, diskusi, tanya jawab',
    kemitraan: 'Koordinasi dengan guru mapel serumpun bila relevan.',
    lingkungan: 'Kerja kelompok kecil di dalam kelas.',
    digital: 'Slide/gambar pendukung materi.',
    asesmen_awal: 'Tanya jawab lisan',
    asesmen_proses: 'Observasi kerja kelompok',
    asesmen_akhir: 'Lembar kerja singkat',
    learning_media: '1. Slide presentasi\n2. Lembar kerja\n3. Papan tulis\n4. Spidol warna',
    pertemuan,
  };
}

function unitForRequest(unit) {
  return {
    topik: unit.topik,
    mapel: state.spine.header.mapel,
    kelas: state.spine.header.kelas,
    semester: unit.semester,
    jp: unit.jp,
    jpPerPertemuan: unit.jpPerPertemuan,
    pertemuanCount: unit.pertemuanCount,
    cpElemen: unit.cpElemen,
    tpList: unit.tpList,
    kktpList: unit.kktpList,
  };
}

// ---- module-local session state (not persisted verbatim — spine.rpps is) --
let entries = []; // [{id, unit, content}]
let activeId = null;
let rootEl = null;

function currentEntry() {
  return entries.find((e) => e.id === activeId) || null;
}

function persistEntries() {
  setRpps(entries.map((e) => ({ id: e.id, unit: e.unit, content: e.content })));
}

export async function render(container) {
  rootEl = container;
  entries = Array.isArray(state.spine.rpps) ? state.spine.rpps.map((e) => ({
    id: e.id, unit: e.unit, content: e.content,
  })) : [];
  activeId = entries.length ? entries[entries.length - 1].id : null;

  const units = state.spine.units || [];
  const doneUnitIds = new Set(entries.filter((e) => e.unit.unitId).map((e) => e.unit.unitId));

  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg" id="rpp-list-card"></div>
      ${units.length ? `
      <div class="card card-pad-lg">
        <h2>Buat RPP dari Unit ATP</h2>
        <p class="muted">Topik, JP, TP, dan KKTP diisi otomatis dari ATP yang sudah disetujui.</p>
        <div class="field">
          <label for="in-unit">Unit</label>
          <select id="in-unit">
            ${units.map((u) => `<option value="${u.id}">${escapeHtml(u.nama)} — ${u.jp} JP, Semester ${u.semester === 2 ? 'Genap' : 'Ganjil'}${doneUnitIds.has(u.id) ? ' (RPP sudah ada)' : ''}</option>`).join('')}
          </select>
        </div>
        <div class="row">
          <button class="btn btn-primary btn-lg" id="btn-generate-unit">✨ Buat dengan AI</button>
          <button class="btn btn-outline" id="btn-dummy-unit">Isi Contoh (tanpa AI)</button>
        </div>
      </div>
      <details class="card card-pad-lg">
        <summary style="cursor:pointer; font-weight:700;">Atau buat RPP manual (tanpa ATP)</summary>
        ${manualFormHtml()}
      </details>
      ` : `
      <div class="card card-pad-lg">
        <h2>Buat RPP Baru</h2>
        <p class="muted">RPP mencakup satu topik/unit (1..N pertemuan). Belum ada ATP yang disetujui — isi topik ini secara manual, atau lengkapi tahap ATP/Prota dulu untuk mengisi otomatis.</p>
        ${manualFormHtml()}
      </div>
      `}
      <div id="rpp-preview-wrap"></div>
    </div>
  `;

  renderList(container);

  if (units.length) {
    container.querySelector('#btn-generate-unit').addEventListener('click', () => onCreateFromUnit(container, true));
    container.querySelector('#btn-dummy-unit').addEventListener('click', () => onCreateFromUnit(container, false));
  }
  wireManualForm(container);

  if (activeId) await showPreview(container, currentEntry());
}

function manualFormHtml() {
  return `
        <div class="field">
          <label for="in-topik">Topik / Judul Unit</label>
          <input type="text" id="in-topik" placeholder='mis. "Thermal Energy and Heat Transfer"'>
        </div>

        <div class="grid grid-2">
          <div class="field">
            <label for="in-jp">Total JP unit ini</label>
            <input type="number" id="in-jp" min="1" max="40" value="${Number(state.spine.config.jpPerPertemuan) || 2}">
          </div>
          <div class="field">
            <label for="in-semester">Semester</label>
            <select id="in-semester">
              <option value="1">Ganjil</option>
              <option value="2">Genap</option>
            </select>
          </div>
        </div>

        <div class="field">
          <label for="in-cp">Konteks Capaian Pembelajaran (elemen terkait — opsional, tempel dari CP)</label>
          <textarea id="in-cp" rows="3" placeholder="Tempel teks elemen CP yang relevan di sini (opsional)."></textarea>
        </div>

        <div class="field">
          <label for="in-tp">Tujuan Pembelajaran (TP) — satu per baris, format "kode: rumusan"</label>
          <textarea id="in-tp" rows="4" placeholder="7.3a: Peserta didik dapat menjelaskan ...&#10;7.3b: Peserta didik dapat ..."></textarea>
        </div>

        <div class="field">
          <label for="in-kktp">Kriteria Ketercapaian TP (KKTP) — satu per baris, format "kode: kriteria"</label>
          <textarea id="in-kktp" rows="3" placeholder="KKTP-7.3a: ..."></textarea>
        </div>

        <div class="row">
          <button class="btn btn-primary btn-lg" id="btn-generate">✨ Buat dengan AI</button>
          <button class="btn btn-outline" id="btn-dummy">Isi Contoh (tanpa AI)</button>
        </div>
        <p class="field-hint" id="rpp-jp-hint"></p>
  `;
}

function wireManualForm(container) {
  const jpInput = container.querySelector('#in-jp');
  if (!jpInput) return; // manual form not present (shouldn't happen — always rendered, collapsed or not)
  updateJpHint(container);
  jpInput.addEventListener('input', () => updateJpHint(container));
  container.querySelector('#btn-generate').addEventListener('click', () => onCreate(container, true));
  container.querySelector('#btn-dummy').addEventListener('click', () => onCreate(container, false));
}

async function onCreateFromUnit(container, useAi) {
  const unitId = container.querySelector('#in-unit').value;
  const atpUnit = (state.spine.units || []).find((u) => u.id === unitId);
  if (!atpUnit) return toast('Unit tidak ditemukan.', { error: true });
  await createEntry(container, useAi, unitFromAtp(atpUnit));
}

function updateJpHint(container) {
  const jp = Number(container.querySelector('#in-jp').value);
  const jpp = Number(state.spine.config.jpPerPertemuan) || 2;
  const menitPerJp = Number(state.spine.config.menitPerJp) || 40;
  const count = computePertemuanCount(jp, jpp);
  container.querySelector('#rpp-jp-hint').textContent =
    `= ${count} pertemuan x ${jpp} JP (JP/pertemuan dari tahap Data). 1 JP = ${menitPerJp} menit.`;
}

function renderList(container) {
  const listCard = container.querySelector('#rpp-list-card');
  if (!entries.length) {
    listCard.innerHTML = '<h2>RPP</h2><p class="muted">Belum ada RPP dibuat untuk perangkat ini.</p>';
    return;
  }
  listCard.innerHTML = `
    <div class="row-between"><h2>RPP</h2>${badgeHtml(state.spine, 'rpp')}</div>
    <div class="grid grid-2" id="rpp-cards"></div>
  `;
  const grid = listCard.querySelector('#rpp-cards');
  entries.forEach((e) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plan-card' + (e.id === activeId ? '' : '');
    btn.style.textAlign = 'left';
    btn.style.width = '100%';
    btn.style.border = 'none';
    btn.innerHTML = `<h3>${escapeHtml(e.unit.topik)}</h3>
      <div class="meta">${e.unit.pertemuanCount} pertemuan &middot; ${e.unit.jp} JP &middot; Semester ${e.unit.semester === 2 ? 'Genap' : 'Ganjil'}</div>`;
    btn.addEventListener('click', async () => {
      activeId = e.id;
      await showPreview(rootEl, currentEntry());
    });
    grid.appendChild(btn);
  });
}

async function onCreate(container, useAi) {
  const topik = container.querySelector('#in-topik').value.trim();
  if (!topik) return toast('Isi topik/judul unit dulu.', { error: true });

  const jp = Number(container.querySelector('#in-jp').value) || 2;
  const jpPerPertemuan = Number(state.spine.config.jpPerPertemuan) || 2;
  const unit = {
    topik,
    jp,
    jpPerPertemuan,
    pertemuanCount: computePertemuanCount(jp, jpPerPertemuan),
    semester: Number(container.querySelector('#in-semester').value) || 1,
    cpElemen: container.querySelector('#in-cp').value.trim(),
    tpList: parseTpLines(container.querySelector('#in-tp').value),
    kktpList: parseKktpLines(container.querySelector('#in-kktp').value),
  };
  await createEntry(container, useAi, unit, { genSel: '#btn-generate', dummySel: '#btn-dummy' });
}

/** Shared by both the ATP-driven picker and the manual topic-stub form. */
async function createEntry(container, useAi, unit, sel) {
  sel = sel || { genSel: '#btn-generate-unit', dummySel: '#btn-dummy-unit' };
  const genBtn = container.querySelector(sel.genSel);
  const dummyBtn = container.querySelector(sel.dummySel);
  if (genBtn) genBtn.disabled = true;
  if (dummyBtn) dummyBtn.disabled = true;
  const genLabel = genBtn && genBtn.textContent;
  const dummyLabel = dummyBtn && dummyBtn.textContent;
  if (useAi && genBtn) genBtn.textContent = 'Membuat…';
  if (!useAi && dummyBtn) dummyBtn.textContent = 'Membuat…';

  let content = null;
  try {
    if (useAi) {
      const r = await callAi('generate_rpp', { planId: state.planId, unit: unitForRequest(unit) });
      content = r.data;
      if (r.pertemuanCount) unit.pertemuanCount = r.pertemuanCount;
    } else {
      content = dummyContent(unit);
    }
  } catch (e) {
    if (genBtn) { genBtn.disabled = false; genBtn.textContent = genLabel; }
    if (dummyBtn) { dummyBtn.disabled = false; dummyBtn.textContent = dummyLabel; }
    return; // callAi/local error path already toasted where relevant
  }

  if (genBtn) { genBtn.disabled = false; genBtn.textContent = genLabel; }
  if (dummyBtn) { dummyBtn.disabled = false; dummyBtn.textContent = dummyLabel; }

  // Re-generating for a unit that already has an RPP replaces it in place
  // (same unitId) rather than piling up duplicate entries for that unit.
  const existingIdx = unit.unitId ? entries.findIndex((e) => e.unit.unitId === unit.unitId) : -1;
  const entry = { id: existingIdx >= 0 ? entries[existingIdx].id : 'rpp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), unit, content };
  if (existingIdx >= 0) entries[existingIdx] = entry; else entries.push(entry);
  activeId = entry.id;
  persistEntries();
  renderList(container);
  toast(useAi ? 'RPP berhasil dibuat oleh AI.' : 'RPP contoh berhasil diisi (offline, tanpa AI).');
  await showPreview(container, entry);
}

// ---- preview + edit + export ------------------------------------------------
async function showPreview(container, entry) {
  const wrap = container.querySelector('#rpp-preview-wrap');
  if (!entry) { wrap.innerHTML = ''; return; }

  // Export buttons are blocked whenever the validator has any error-level
  // finding (SOP §12.A red errors block export — plan's Validator section),
  // same rule the Ekspor screen's document list enforces.
  const level = overallLevel(runValidator(state.spine));
  const blocked = level === 'error';
  const blockAttrs = 'disabled title="Perbaiki kesalahan validator (tanda merah) dulu sebelum mengekspor — lihat tahap Ekspor."';

  wrap.innerHTML = `
    <div class="card card-pad-lg">
      <div class="row-between">
        <h2>Pratinjau — ${escapeHtml(entry.unit.topik)}</h2>
        <div class="row">
          <button class="btn btn-outline" id="btn-export-mht" ${blocked ? blockAttrs : ''}>Unduh MHT (Word)</button>
          <button class="btn btn-outline" id="btn-export-docx" ${blocked ? blockAttrs : ''}>Unduh DOCX</button>
          <button class="btn btn-outline" id="btn-export-pdf" ${blocked ? blockAttrs : ''}>Cetak / Simpan PDF</button>
          <button class="btn btn-outline" id="btn-export-html" ${blocked ? blockAttrs : ''}>Unduh HTML</button>
        </div>
      </div>
      <p class="muted small">Klik langsung pada sel berwarna putih untuk menyunting teks, atau pakai 🔄 di pojok sel untuk meregenerasi bagian itu dengan AI. Klik kotak ☐ untuk mencentang/batal.</p>
      <div id="rpp-warnings"></div>
      <div class="rpp-iframe-wrap" style="overflow:auto; border:1px solid var(--line); border-radius:8px; max-height:80vh;">
        <iframe id="rpp-iframe" title="Pratinjau RPP" style="width:100%; min-height:1400px; border:0; display:block;"></iframe>
      </div>
    </div>
  `;

  let html;
  try {
    const result = await renderRppHtml({ header: state.spine.header, unit: entry.unit, content: entry.content, menitPerJp: state.spine.config.menitPerJp });
    html = result.html;
    if (result.warnings && result.warnings.length) {
      container.querySelector('#rpp-warnings').innerHTML =
        '<p class="muted small">Catatan template: ' + result.warnings.map(escapeHtml).join(' · ') + '</p>';
    }
  } catch (e) {
    wrap.innerHTML = `<div class="placeholder card"><div class="big-icon">⚠️</div><h2>Gagal merender pratinjau</h2><p class="muted">${escapeHtml((e && e.message) || e)}</p></div>`;
    return;
  }

  const iframe = container.querySelector('#rpp-iframe');
  await new Promise((resolve) => {
    iframe.addEventListener('load', resolve, { once: true });
    iframe.srcdoc = html;
  });

  wireEditableCells(iframe, entry, container);

  container.querySelector('#btn-export-mht').addEventListener('click', () => exportCurrent(iframe, entry, 'mht'));
  container.querySelector('#btn-export-docx').addEventListener('click', () => exportCurrent(iframe, entry, 'docx'));
  container.querySelector('#btn-export-pdf').addEventListener('click', () => exportCurrent(iframe, entry, 'pdf'));
  container.querySelector('#btn-export-html').addEventListener('click', () => exportCurrent(iframe, entry, 'html'));
}

function wireEditableCells(iframe, entry, container) {
  const doc = iframe.contentDocument;
  if (!doc) return;

  const style = doc.createElement('style');
  style.textContent = `
    .pemeran-editable{ outline-offset:1px; cursor:text; }
    .pemeran-editable:hover{ outline:1.5px dashed #146b64; }
    .pemeran-editable:focus{ outline:1.5px solid #146b64; background:#f5fbfa; }
    .pemeran-regen-btn{
      position:absolute; top:1px; right:1px; z-index:5;
      border:none; background:#fff; border-radius:999px; width:18px; height:18px;
      font-size:10px; line-height:18px; padding:0; cursor:pointer; text-align:center;
      box-shadow:0 1px 3px rgba(0,0,0,0.3); opacity:0.55;
    }
    .pemeran-regen-btn:hover{ opacity:1; }
    ul.checkbox-list li{ cursor:pointer; }
    @media print{ .pemeran-regen-btn{ display:none !important; } }
  `;
  doc.head.appendChild(style);

  // Checkbox toggles — click a dimensi/santri-kitab item to check/uncheck it.
  Array.from(doc.querySelectorAll('ul.checkbox-list li[data-item]')).forEach((li) => {
    li.addEventListener('click', () => {
      const chk = li.querySelector('.chk');
      if (!chk) return;
      chk.textContent = chk.textContent.trim() === '☑' ? '☐' : '☑';
    });
  });

  // Editable content cells + per-field regenerate button.
  const cells = Array.from(doc.querySelectorAll('[data-marker="3"][data-field]'));
  for (const cell of cells) {
    if (cell.classList.contains('checkbox-list')) continue;
    const rawField = cell.getAttribute('data-field');
    if (!rawField || rawField === 'tujuan_pembelajaran') continue;
    const m = rawField.match(/^(.+)__(\d+)$/);
    const baseField = m ? m[1] : rawField;
    const meetingIndex = m ? Number(m[2]) : null;

    cell.setAttribute('contenteditable', 'true');
    cell.classList.add('pemeran-editable');
    cell.style.position = 'relative';

    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'pemeran-regen-btn';
    btn.textContent = '\u{1F504}';
    btn.title = 'Regenerasi bagian "' + (FIELD_LABELS[baseField] || baseField) + '" dengan AI';
    btn.addEventListener('click', (evt) => {
      evt.preventDefault();
      evt.stopPropagation();
      regenerateField(container, entry, baseField, meetingIndex);
    });
    cell.appendChild(btn);
  }
}

async function regenerateField(container, entry, baseField, meetingIndex) {
  const current = meetingIndex != null
    ? ((entry.content.pertemuan && entry.content.pertemuan[meetingIndex]) || {})[baseField] || ''
    : entry.content[baseField];

  toast('Meregenerasi ' + (FIELD_LABELS[baseField] || baseField) + '…');
  let r;
  try {
    r = await callAi('regenerate_field', {
      planId: state.planId,
      unit: unitForRequest(entry.unit),
      field: baseField,
      current,
      meetingIndex,
    });
  } catch (e) {
    return; // already toasted
  }

  if (meetingIndex != null) {
    entry.content.pertemuan = entry.content.pertemuan || [];
    entry.content.pertemuan[meetingIndex] = entry.content.pertemuan[meetingIndex] || {};
    entry.content.pertemuan[meetingIndex][baseField] = r.value;
  } else {
    entry.content[baseField] = r.value;
  }
  persistEntries();
  toast('Bagian berhasil diregenerasi.');
  await showPreview(container, entry);
}

// ---- exports (always serialize the LIVE iframe DOM, so any hand-edits or
// checkbox toggles the teacher just made are captured) -----------------------
function liveHtml(iframe) {
  return '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
}

async function exportCurrent(iframe, entry, kind) {
  const html = liveHtml(iframe);
  const label = 'RPP - ' + entry.unit.topik;
  try {
    if (kind === 'mht') {
      await downloadMht(html, label);
      toast('MHT diunduh — buka dengan Microsoft Word.');
    } else if (kind === 'docx') {
      await downloadDocx(html, label);
      toast('DOCX diunduh — buka dengan Microsoft Word.');
    } else if (kind === 'pdf') {
      printRppHtml(html);
    } else if (kind === 'html') {
      await exportRppHtml(html, label);
      toast('HTML diunduh.');
    }
  } catch (e) {
    toast('Gagal mengekspor: ' + String((e && e.message) || e), { error: true });
  }
}
