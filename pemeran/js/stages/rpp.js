// =============================================================
// Pemeran — Stage: RPP
// -------------------------------------------------------------
// Flow: topic stub (manual) or a real ATP unit -> "Buat dengan AI"
// (per-meeting orchestration: one generate_rpp_base call + N sequential
// generate_rpp_meeting calls, resumable) or "Isi Contoh" (local dummy,
// no backend) -> per-meeting tab preview (click-to-edit cells + per-field
// 🔄 regenerate) -> MHT/DOCX/PDF/HTML export per meeting, or one combined
// paginated PDF across all meetings.
//
// Persistence: each RPP is stored as {id, unit, content} in spine.rpps
// (state.js's setRpps). Meetings arrive one at a time during AI
// generation and are persisted AS THEY ARRIVE (persistOneEntry below,
// merged against the CURRENT state.spine.rpps rather than a possibly-
// stale local snapshot — see persistOneEntry's doc comment) so a later
// meeting's failure never loses earlier ones, and navigating away and
// back mid-generation never clobbers progress. In-preview edits
// (contenteditable cells + checkbox toggles) are reverse-parsed back into
// the stored `content` object on debounced input/blur, so they survive a
// reload — not just captured live by exports as before.
// =============================================================

import { state, setRpps, flushSave } from '../state.js';
import { toast } from '../api.js';
import { callAi } from '../aiApi.js';
import { renderRppHtml, renderRppCombinedHtml } from '../render/rpp.js';
import { downloadMht } from '../export/mht.js';
import { printRppHtml } from '../export/pdf.js';
import { exportRppHtml } from '../export/html.js';
import { downloadDocx } from '../export/docx.js';
import { splitMeetings, computePertemuanCount, draftRppSkeleton } from '../pipeline.js';
import { badgeHtml } from '../validate.js';
import { withExportGate } from '../validatorPanel.js';
import { generateRppContentForUnit, findResumeState, GENERATION_CANCELLED } from '../rppGen.js';

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

// ---- rich-text mini-syntax DOM -> text serializer (V2a #5) -----------------
// Best-effort reverse of render/docHtml/richTextHtml.js's forward parser:
// walks the (possibly hand-edited) cell DOM and reconstructs the ✓/•/-/o/N.
// line-prefix + **bold**/*italic* mini-syntax it started from. Handles both
// the unmodified richTextToHtml() output (one <p class="rt-line..."> per
// line) and typical contenteditable edits (browsers split lines into new
// <p>/<div> on Enter, or use <br> for soft breaks) — not a full round-trip
// guarantee for arbitrarily mangled DOM, but covers what a teacher actually
// does when editing text in place.
const NBSP_RE = / /g;

function inlineNodeToMiniSyntax(node) {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName;
      if (tag === 'STRONG' || tag === 'B') {
        out += '**' + inlineNodeToMiniSyntax(child).trim() + '**';
      } else if (tag === 'EM' || tag === 'I') {
        out += '*' + inlineNodeToMiniSyntax(child).trim() + '*';
      } else if (tag === 'BR') {
        out += '\n';
      } else {
        out += inlineNodeToMiniSyntax(child);
      }
    }
  });
  return out;
}

function stripLinePrefix(rawLine) {
  const t = rawLine.replace(NBSP_RE, ' ');
  let m;
  if ((m = t.match(/^\s*✓\s+([\s\S]*)$/))) return '✓ ' + m[1].trim();
  if ((m = t.match(/^\s*[•\-]\s+([\s\S]*)$/))) return '• ' + m[1].trim();
  if ((m = t.match(/^\s*[○o]\s+([\s\S]*)$/))) return 'o ' + m[1].trim();
  if ((m = t.match(/^\s*(\d+)\.\s+([\s\S]*)$/))) return m[1] + '. ' + m[2].trim();
  return t.trim();
}

/** Serialize one editable RPP cell's current DOM back into the mini-syntax
 *  string entry.content[field] (or entry.content.pertemuan[i][field])
 *  stores. */
function serializeCellToMiniSyntax(cellEl) {
  const clone = cellEl.cloneNode(true);
  clone.querySelectorAll('.pemeran-regen-btn').forEach((b) => b.remove());

  const blockChildren = Array.from(clone.children).filter((c) => ['P', 'DIV', 'LI'].includes(c.tagName));
  if (blockChildren.length) {
    return blockChildren
      .map((el) => stripLinePrefix(inlineNodeToMiniSyntax(el)))
      .filter((l) => l.length)
      .join('\n');
  }
  // No block children — plain text / <br>-separated lines typed directly
  // into a cell that started out empty (e.g. a fresh Kerangka Instan
  // placeholder before the teacher's first edit).
  return inlineNodeToMiniSyntax(clone)
    .split('\n')
    .map((l) => stripLinePrefix(l))
    .filter((l) => l.length)
    .join('\n');
}

function itemShortLabel(dataItem) {
  const s = String(dataItem || '');
  const idx = s.indexOf(' / ');
  return (idx >= 0 ? s.slice(0, idx) : s).trim();
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

// ---- build the RPP "unit" shape from a real spine.units entry --------------
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
let activeMeetingTab = 0; // number (0-based meeting index) | 'all'
let generatingEntryId = null; // entry.id currently mid-AI-generation, or null
let cancelRequested = false;

function currentEntry() {
  return entries.find((e) => e.id === activeId) || null;
}

/** Bulk replace — used right after entries/entries[i] is mutated directly
 *  (create/replace-in-place flows, always synchronous in direct response to
 *  a click, so the module-local `entries` snapshot is guaranteed fresh). */
function persistEntries() {
  setRpps(entries.map((e) => ({ id: e.id, unit: e.unit, content: e.content })));
}

/** Merge-by-id persistence for anything that can happen mid-async-flow
 *  (per-meeting AI generation, debounced cell edits) — reads the CURRENT
 *  state.spine.rpps rather than the possibly-stale module-local `entries`
 *  snapshot, so navigating away from the RPP stage and back (which rebuilds
 *  `entries` fresh from state.spine.rpps in render() below) can never
 *  clobber progress a still-running background generation already saved. */
function persistOneEntry(entry) {
  const current = Array.isArray(state.spine.rpps) ? state.spine.rpps.slice() : [];
  const idx = current.findIndex((e) => e.id === entry.id);
  const plain = { id: entry.id, unit: entry.unit, content: entry.content };
  if (idx >= 0) current[idx] = plain; else current.push(plain);
  setRpps(current);
  const localIdx = entries.findIndex((e) => e.id === entry.id);
  if (localIdx >= 0) entries[localIdx] = entry;
}

export async function render(container) {
  rootEl = container;
  entries = Array.isArray(state.spine.rpps) ? state.spine.rpps.map((e) => ({
    id: e.id, unit: e.unit, content: e.content,
  })) : [];
  activeId = entries.length ? entries[entries.length - 1].id : null;
  activeMeetingTab = 0;

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
      activeMeetingTab = 0;
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
  await createEntry(container, useAi, unit);
}

/** Shared by both the ATP-driven picker and the manual topic-stub form.
 *  AI path: creates/replaces the entry with a zero-AI skeleton (via
 *  pipeline.draftRppSkeleton — same shape the free "Kerangka Instan" path
 *  uses, so a mid-generation entry always has a valid, previewable shape)
 *  and immediately kicks off the per-meeting orchestration. Dummy path:
 *  fills instantly with illustrative example content, no network call. */
async function createEntry(container, useAi, unit) {
  const existingIdx = unit.unitId ? entries.findIndex((e) => e.unit.unitId === unit.unitId) : -1;
  if (existingIdx >= 0 && generatingEntryId === entries[existingIdx].id) {
    toast('Pembuatan RPP untuk unit ini sedang berjalan.', { error: true });
    return;
  }

  let content;
  if (useAi) {
    const skeleton = draftRppSkeleton(unit, state.spine.config);
    unit.pertemuanCount = skeleton.pertemuanCount;
    content = skeleton.content;
  } else {
    content = dummyContent(unit);
  }

  const entry = {
    id: existingIdx >= 0 ? entries[existingIdx].id : 'rpp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    unit,
    content,
  };
  if (existingIdx >= 0) entries[existingIdx] = entry; else entries.push(entry);
  activeId = entry.id;
  activeMeetingTab = 0;
  persistEntries();
  renderList(container);

  if (useAi) {
    toast('Membuat RPP dengan AI — mengisi bagian identitas lalu tiap pertemuan satu per satu…');
    await showPreview(container, entry);
    await generateAllMeetingsAi(container, entry);
  } else {
    toast('RPP contoh berhasil diisi (offline, tanpa AI).');
    await showPreview(container, entry);
  }
}

// ---- per-meeting AI orchestration (V2a #3) ---------------------------------
// Thin UI wrapper over rppGen.js's generateRppContentForUnit (shared with
// oneshot.js's owner-only full-AI chain, so the retry/resume/base+meeting
// call sequencing can never drift between the two entry points). This
// wrapper owns: the progress banner, the "Batal" cancel flag, and
// persisting each step AS IT ARRIVES via persistOneEntry + an immediate
// flushSave (not the debounced autosave) so a later meeting's failure never
// loses earlier ones and navigating away mid-generation never loses
// progress either.
async function generateAllMeetingsAi(container, entry, opts) {
  opts = opts || {};
  if (generatingEntryId === entry.id) {
    toast('Pembuatan RPP untuk unit ini sedang berjalan.', { error: true });
    return;
  }
  generatingEntryId = entry.id;
  cancelRequested = false;

  try {
    await generateRppContentForUnit({
      unit: entry.unit,
      content: entry.content,
      header: state.spine.header,
      planId: state.planId,
      config: state.spine.config,
      resume: !!opts.resume,
      onProgress: (info) => renderGenerationBanner(container, Object.assign({ active: true }, info)),
      isCancelled: () => cancelRequested,
      onStepDone: async () => {
        persistOneEntry(entry);
        await flushSave();
      },
    });
    generatingEntryId = null;
    toast('RPP berhasil dibuat oleh AI untuk seluruh pertemuan.');
  } catch (e) {
    generatingEntryId = null;
    const cancelled = e && e.message === GENERATION_CANCELLED;
    toast(cancelled
      ? 'Pembuatan RPP dibatalkan — bagian yang sudah selesai tetap tersimpan.'
      : 'Pembuatan RPP berhenti: ' + String((e && e.message) || e) + ' — bagian yang sudah selesai tetap tersimpan.',
    { error: !cancelled });
  }

  if (currentEntry() && currentEntry().id === entry.id) await showPreview(container, entry);
}

function renderGenerationBanner(container, info) {
  const el = container.querySelector('#rpp-progress');
  if (!el) return; // stage navigated away mid-generation — generation itself continues in the background
  el.innerHTML = `
    <div class="card" style="background:var(--accent-soft); border-color:var(--accent-line); margin-bottom:var(--space-3);">
      <div class="row-between">
        <strong>⚡ ${escapeHtml(info.label)}</strong>
        <button type="button" class="btn btn-ghost btn-sm" id="btn-cancel-gen">Batal</button>
      </div>
      <div class="muted small">Langkah ${info.step} dari ${info.total}</div>
    </div>
  `;
  const cancelBtn = el.querySelector('#btn-cancel-gen');
  if (cancelBtn) cancelBtn.addEventListener('click', () => { cancelRequested = true; });
}

function renderResumeBanner(container, entry) {
  const el = container.querySelector('#rpp-progress');
  if (!el) return;
  const rs = findResumeState(entry.unit, entry.content);
  if (!rs) { el.innerHTML = ''; return; }
  const label = rs.baseNeeds ? 'bagian identitas unit' : `Pertemuan ${rs.firstMissing + 1}`;
  el.innerHTML = `
    <div class="card" style="background:var(--warn-soft); border-color:var(--line); margin-bottom:var(--space-3);">
      <div class="row-between" style="gap:var(--space-3);">
        <span>RPP ini belum lengkap dibuat AI — lanjut dari <strong>${escapeHtml(label)}</strong>.</span>
        <button type="button" class="btn btn-primary btn-sm" id="btn-resume-gen">▶ Lanjutkan</button>
      </div>
    </div>
  `;
  const btn = el.querySelector('#btn-resume-gen');
  if (btn) btn.addEventListener('click', () => generateAllMeetingsAi(container, entry, { resume: true }));
}

// ---- preview: meeting tab strip + edit + export ----------------------------
function renderTabsHtml(total, active) {
  const meetingTabs = Array.from({ length: total }, (_, i) => (
    `<button type="button" class="tab-btn${active === i ? ' is-active' : ''}" data-tab="${i}">Pertemuan ${i + 1}</button>`
  )).join('');
  const allTab = total > 1
    ? `<button type="button" class="tab-btn${active === 'all' ? ' is-active' : ''}" data-tab="all">Semua</button>`
    : '';
  return meetingTabs + allTab;
}

async function showPreview(container, entry) {
  const wrap = container.querySelector('#rpp-preview-wrap');
  if (!entry) { wrap.innerHTML = ''; return; }

  const total = entry.unit.pertemuanCount || 1;
  if (activeMeetingTab !== 'all' && (typeof activeMeetingTab !== 'number' || activeMeetingTab >= total || activeMeetingTab < 0)) {
    activeMeetingTab = 0;
  }

  wrap.innerHTML = `
    <div class="card card-pad-lg">
      <div class="row-between">
        <h2>Pratinjau — ${escapeHtml(entry.unit.topik)}</h2>
        ${total > 1 ? '<button type="button" class="btn btn-outline" id="btn-combine-pdf">📎 Gabungkan semua → PDF</button>' : ''}
      </div>
      <div id="rpp-progress"></div>
      <div class="tab-strip" id="rpp-tabs">${renderTabsHtml(total, activeMeetingTab)}</div>
      <div class="row" style="margin-bottom:var(--space-3);">
        <button class="btn btn-outline" id="btn-export-mht">Unduh MHT (Word)</button>
        <button class="btn btn-outline" id="btn-export-docx">Unduh DOCX</button>
        <button class="btn btn-outline" id="btn-export-pdf">Cetak / Simpan PDF</button>
        <button class="btn btn-outline" id="btn-export-html">Unduh HTML</button>
      </div>
      <p class="muted small">Klik langsung pada sel berwarna putih untuk menyunting teks, atau pakai 🔄 di pojok sel untuk meregenerasi bagian itu dengan AI. Klik kotak ☐ untuk mencentang/batal.</p>
      <div id="rpp-warnings"></div>
      <div class="rpp-iframe-wrap" style="overflow:auto; border:1px solid var(--line); border-radius:8px; max-height:80vh;">
        <iframe id="rpp-iframe" title="Pratinjau RPP" style="width:100%; min-height:1400px; border:0; display:block;"></iframe>
      </div>
    </div>
  `;

  if (generatingEntryId !== entry.id) renderResumeBanner(container, entry);

  container.querySelectorAll('#rpp-tabs [data-tab]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const v = btn.dataset.tab;
      activeMeetingTab = v === 'all' ? 'all' : Number(v);
      await showPreview(container, entry);
    });
  });

  const combineBtn = container.querySelector('#btn-combine-pdf');
  if (combineBtn) combineBtn.addEventListener('click', () => onCombinePdf(container, entry));

  await renderActiveTab(container, entry);
}

async function renderActiveTab(container, entry) {
  const iframe = container.querySelector('#rpp-iframe');
  const total = entry.unit.pertemuanCount || 1;
  const meetingIndex = activeMeetingTab === 'all' ? undefined : activeMeetingTab;

  let html;
  try {
    const result = await renderRppHtml({
      header: state.spine.header, unit: entry.unit, content: entry.content,
      menitPerJp: state.spine.config.menitPerJp, meetingIndex,
    });
    html = result.html;
    const warnEl = container.querySelector('#rpp-warnings');
    if (warnEl) {
      warnEl.innerHTML = (result.warnings && result.warnings.length)
        ? '<p class="muted small">Catatan template: ' + result.warnings.map(escapeHtml).join(' · ') + '</p>'
        : '';
    }
  } catch (e) {
    const wrap = container.querySelector('#rpp-preview-wrap');
    wrap.innerHTML = `<div class="placeholder card"><div class="big-icon">⚠️</div><h2>Gagal merender pratinjau</h2><p class="muted">${escapeHtml((e && e.message) || e)}</p></div>`;
    return;
  }

  await new Promise((resolve) => {
    iframe.addEventListener('load', resolve, { once: true });
    iframe.srcdoc = html;
  });

  wireEditableCells(iframe, entry, container);

  const label = meetingIndex == null
    ? 'RPP - ' + entry.unit.topik
    : `RPP - ${entry.unit.topik} - Pertemuan ${meetingIndex + 1} dari ${total}`;
  container.querySelector('#btn-export-mht').addEventListener('click', () => withExportGate(() => exportCurrent(iframe, label, 'mht')));
  container.querySelector('#btn-export-docx').addEventListener('click', () => withExportGate(() => exportCurrent(iframe, label, 'docx')));
  container.querySelector('#btn-export-pdf').addEventListener('click', () => withExportGate(() => exportCurrent(iframe, label, 'pdf')));
  container.querySelector('#btn-export-html').addEventListener('click', () => withExportGate(() => exportCurrent(iframe, label, 'html')));
}

async function onCombinePdf(container, entry) {
  await withExportGate(async () => {
    const btn = container.querySelector('#btn-combine-pdf');
    if (btn) { btn.disabled = true; btn.textContent = 'Menyiapkan…'; }
    try {
      const { html } = await renderRppCombinedHtml({
        header: state.spine.header, unit: entry.unit, content: entry.content, menitPerJp: state.spine.config.menitPerJp,
      });
      printRppHtml(html);
    } catch (e) {
      toast('Gagal menggabungkan PDF: ' + String((e && e.message) || e), { error: true });
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '📎 Gabungkan semua → PDF'; }
    }
  });
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

  // Checkbox toggles — click a dimensi/santri-kitab item to check/uncheck
  // it, persisting the selected labels straight back into
  // entry.content[baseField] (V2a #5 — must survive reload).
  Array.from(doc.querySelectorAll('ul.checkbox-list[data-field]')).forEach((ul) => {
    const baseField = ul.getAttribute('data-field'); // unit-level only, never suffixed
    Array.from(ul.querySelectorAll('li[data-item]')).forEach((li) => {
      li.addEventListener('click', () => {
        const chk = li.querySelector('.chk');
        if (!chk) return;
        chk.textContent = chk.textContent.trim() === '☑' ? '☐' : '☑';
        const selected = Array.from(ul.querySelectorAll('li[data-item]'))
          .filter((x) => { const c = x.querySelector('.chk'); return c && c.textContent.trim() === '☑'; })
          .map((x) => itemShortLabel(x.getAttribute('data-item')));
        entry.content[baseField] = selected;
        persistOneEntry(entry);
        flushSave().catch(() => {});
      });
    });
  });

  // Editable content cells + per-field regenerate button + debounced
  // save-back-to-spine (V2a #5).
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

    let debounceTimer = null;
    const commit = () => {
      const text = serializeCellToMiniSyntax(cell);
      if (meetingIndex != null) {
        entry.content.pertemuan = entry.content.pertemuan || [];
        entry.content.pertemuan[meetingIndex] = entry.content.pertemuan[meetingIndex] || {};
        entry.content.pertemuan[meetingIndex][baseField] = text;
      } else {
        entry.content[baseField] = text;
      }
      persistOneEntry(entry);
    };
    cell.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(commit, 300);
    });
    cell.addEventListener('blur', () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      commit();
      flushSave().catch(() => {}); // deliberate "done editing this cell" signal — save NOW, don't wait for the 2s autosave debounce
    });
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
  persistOneEntry(entry);
  await flushSave();
  toast('Bagian berhasil diregenerasi.');
  await showPreview(container, entry);
}

// ---- exports (always serialize the LIVE iframe DOM, so any hand-edits or
// checkbox toggles the teacher just made are captured even before the
// debounced save-back above commits them to entry.content) -----------------
function liveHtml(iframe) {
  return '<!DOCTYPE html>\n' + iframe.contentDocument.documentElement.outerHTML;
}

async function exportCurrent(iframe, label, kind) {
  const html = liveHtml(iframe);
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
