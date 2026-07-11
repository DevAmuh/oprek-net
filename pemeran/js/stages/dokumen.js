// =============================================================
// Pemeran — Stage: Dokumen (V2b — replaces "Ekspor")
// -------------------------------------------------------------
// A grid of ALL document previews (TP&KKTP, Prota/ATP, Prosem x2
// semesters, each RPP) — not just a bare button list like the old Ekspor
// screen: every card renders a live iframe preview alongside its
// export buttons, so a teacher can see what's about to download before
// committing to a file. TP&KKTP's preview is in-place editable (V2b #6 —
// render/docHtml/editable.js, same engine RPP's preview uses) so a
// last-look typo fix doesn't require a trip back to the Data stage.
// Keeps V2a's de-gated exports (withExportGate — errors show a confirm
// sheet, never a hard block) + the shared validator panel + "Unduh Semua"
// zip + the owner-only cost readout. Adds a clearly-labeled placeholder
// card for the V2d gradebook (not built this phase).
// =============================================================

import { state, setTps, setKktps } from '../state.js';
import { toast, call } from '../api.js';
import { takeValidatorFocusArea } from '../validate.js';
import { renderValidatorPanel as renderSharedValidatorPanel, withExportGate } from '../validatorPanel.js';
import { renderTpKktpHtml } from '../render/tpkktp.js';
import { renderProtaHtml } from '../render/prota.js';
import { renderProsemHtml } from '../render/prosem.js';
import { renderRppHtml, renderRppCombinedHtml } from '../render/rpp.js';
import { distributeProsemWithOverrides } from '../pipeline.js';
import { downloadMht, buildMht } from '../export/mht.js';
import { printRppHtml } from '../export/pdf.js';
import { exportRppHtml } from '../export/html.js';
import { downloadDocx } from '../export/docx.js';
import { buildDocxBlob } from '../render/docHtml/toDocx.js';
import { wireEditable } from '../render/docHtml/editable.js';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// One entry per exportable document: { key, label, build() -> {html}, [combine], [editable] }
async function collectDocs() {
  const { header, cp, tps, kktps, units, sumatif, config, rpps, prosem } = state.spine;
  const docs = [];

  if (tps.length || kktps.length) {
    docs.push({
      key: 'tpkktp', label: 'TP & KKTP',
      build: () => renderTpKktpHtml({ header, tps, kktps }),
      editable: 'tpkktp',
    });
  }
  if (units.length) {
    docs.push({ key: 'prota', label: 'Prota & ATP', build: () => renderProtaHtml({ header, cpElemen: cp.elemen, tps, units, sumatif }) });

    const computed = distributeProsemWithOverrides(units, sumatif, config, header.kelas, prosem.overrides);
    docs.push({
      key: 'prosem1', label: 'Prosem — Semester Ganjil',
      build: () => renderProsemHtml({ header, config, semesterNum: 1, semesterData: computed.semester1, units, tps, cpElemen: cp.elemen }),
    });
    docs.push({
      key: 'prosem2', label: 'Prosem — Semester Genap',
      build: () => renderProsemHtml({ header, config, semesterNum: 2, semesterData: computed.semester2, units, tps, cpElemen: cp.elemen }),
    });
  }
  for (const entry of (rpps || [])) {
    const total = (entry.unit && entry.unit.pertemuanCount) || 1;
    docs.push({
      key: 'rpp_' + entry.id, label: 'RPP — ' + (entry.unit && entry.unit.topik),
      build: () => renderRppHtml({ header, unit: entry.unit, content: entry.content, menitPerJp: config.menitPerJp }),
      combine: total > 1
        ? () => renderRppCombinedHtml({ header, unit: entry.unit, content: entry.content, menitPerJp: config.menitPerJp })
        : null,
    });
  }
  return docs;
}

export async function render(container) {
  const isOwner = !!(state.teacher && state.teacher.is_owner);

  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg">
        <div class="row-between">
          <h2>Dokumen</h2>
          <button class="btn btn-outline" id="btn-download-all">⬇ Unduh Semua (.zip)</button>
        </div>
        <p class="muted small">Setiap dokumen bisa dipratinjau langsung di bawah, lalu diunduh sebagai MHT (dibuka langsung di Word), DOCX, dicetak/disimpan sebagai PDF, atau HTML mandiri. "Unduh Semua" membundel MHT + DOCX tiap dokumen dalam satu berkas .zip. Sel TP &amp; KKTP di pratinjau bisa disunting langsung di sini.</p>
      </div>
      <div class="card card-pad-lg" id="validator-panel"></div>
      ${isOwner ? '<div class="card card-pad-lg" id="cost-panel"></div>' : ''}
      <div class="stack" id="docs-list"></div>
      <div class="card card-pad-lg" style="opacity:0.7;">
        <div class="row-between">
          <div>
            <h3 style="margin:0 0 4px;">📗 Buku Nilai (KKTP) — segera</h3>
            <p class="muted small" style="margin:0;">Workbook xlsx per rombel (kolom KKTP, ambang batas tuntas, kolom nilai kosong untuk diisi guru) — direncanakan untuk fase berikutnya (V2d). Belum tersedia di fase ini.</p>
          </div>
          <button class="btn btn-outline" disabled>Segera hadir</button>
        </div>
      </div>
    </div>
  `;

  let docsCache = [];
  const focusArea = takeValidatorFocusArea();
  renderSharedValidatorPanel(container.querySelector('#validator-panel'), {
    focusArea,
    // A fix (e.g. "Normalkan ulang JP") can change unit/RPP data the doc
    // list's own build() closures capture — re-collect so a re-export
    // reflects the just-applied fix, not stale pre-fix data.
    onChange: async () => { docsCache = await collectDocs(); await renderDocsList(container, docsCache); },
  });

  const docs = await collectDocs();
  docsCache = docs;
  await renderDocsList(container, docs);

  if (isOwner) renderCostPanel(container);

  container.querySelector('#btn-download-all').addEventListener('click', () => onDownloadAllZip(container, docsCache));
}

// V2a #6 — export buttons are ALWAYS enabled now (no more dead-end grey-out
// on any validator error); withExportGate() (validatorPanel.js) shows a
// confirm sheet listing the actual findings only when there's an
// error-level one, "Tetap ekspor" / "Perbaiki dulu" — never a silent block.
async function renderDocsList(container, docs) {
  const list = container.querySelector('#docs-list');
  if (!docs.length) {
    list.innerHTML = '<div class="card"><p class="muted">Belum ada dokumen untuk diekspor — lengkapi tahap-tahap sebelumnya dulu.</p></div>';
    return;
  }

  list.innerHTML = docs.map((d) => `
    <div class="card" data-doc="${d.key}">
      <div class="row-between">
        <strong>${escapeHtml(d.label)}</strong>
        <div class="row">
          <button class="btn btn-outline" data-action="mht" data-key="${d.key}">Unduh MHT</button>
          <button class="btn btn-outline" data-action="docx" data-key="${d.key}">Unduh DOCX</button>
          <button class="btn btn-outline" data-action="pdf" data-key="${d.key}">Cetak / PDF</button>
          <button class="btn btn-outline" data-action="html" data-key="${d.key}">Unduh HTML</button>
          ${d.combine ? `<button class="btn btn-outline" data-action="combine" data-key="${d.key}">Gabungkan → PDF</button>` : ''}
        </div>
      </div>
      <div class="doc-preview-frame">
        <iframe title="Pratinjau ${escapeHtml(d.label)}" data-preview="${d.key}" style="width:100%; min-height:480px; border:0; display:block;"></iframe>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const doc = docs.find((d) => d.key === btn.dataset.key);
      if (!doc) return;
      await withExportGate(async () => {
        btn.disabled = true;
        try {
          if (btn.dataset.action === 'combine') {
            const { html } = await doc.combine();
            printRppHtml(html);
          } else {
            const { html } = await doc.build();
            await runExport(btn.dataset.action, html, doc.label);
          }
        } catch (e) {
          toast('Gagal mengekspor ' + doc.label + ': ' + String((e && e.message) || e), { error: true });
        } finally {
          btn.disabled = false;
        }
      });
    });
  });

  // Render each doc's live preview iframe, wiring TP&KKTP's cells editable
  // (V2b #6) so a last-look fix doesn't require leaving this screen.
  for (const d of docs) {
    const iframe = list.querySelector(`iframe[data-preview="${d.key}"]`);
    if (!iframe) continue;
    try {
      const { html } = await d.build();
      await new Promise((resolve) => {
        iframe.addEventListener('load', resolve, { once: true });
        iframe.srcdoc = html;
      });
      if (d.editable === 'tpkktp') wireTpKktpEditable(iframe);
    } catch (e) {
      // leave that one preview blank; export buttons still work independently
    }
  }
}

/** V2b #6 — TP&KKTP preview editability: writes straight back to
 *  spine.tps[i].rumusan / spine.kktps[i].kriteria via the __<i> suffix
 *  render/tpkktp.js's buildTpTable/buildKktpTable emit. Per the shared
 *  engine's caret-preservation rule, this never re-renders the iframe being
 *  edited — only the underlying spine changes; the doc list itself is only
 *  rebuilt on the next explicit action (export click, or a validator fix's
 *  onChange). */
function wireTpKktpEditable(iframe) {
  wireEditable(iframe, {
    writeField: (baseField, i, text) => {
      if (i == null) return;
      if (baseField === 'tp_rumusan') {
        const tps = (state.spine.tps || []).map((t, idx) => (idx === i ? Object.assign({}, t, { rumusan: text }) : t));
        setTps(tps);
      } else if (baseField === 'kktp_kriteria') {
        const kktps = (state.spine.kktps || []).map((k, idx) => (idx === i ? Object.assign({}, k, { kriteria: text }) : k));
        setKktps(kktps);
      }
    },
  });
}

async function runExport(action, html, label) {
  if (action === 'mht') {
    await downloadMht(html, label);
    toast('MHT "' + label + '" diunduh — buka dengan Microsoft Word.');
  } else if (action === 'docx') {
    await downloadDocx(html, label);
    toast('DOCX "' + label + '" diunduh — buka dengan Microsoft Word.');
  } else if (action === 'pdf') {
    printRppHtml(html);
  } else if (action === 'html') {
    await exportRppHtml(html, label);
    toast('HTML "' + label + '" diunduh.');
  }
}

function sanitizeFilename(name) {
  return String(name || '').replace(/[\\/:*?"<>|]/g, '').trim() || 'Dokumen';
}

// ---- "Unduh Semua" — real .zip via fflate (CDN ESM), bundling BOTH MHT
// (the proven Word-open path) and DOCX (this milestone's new, not-yet-
// real-Word-validated path) per document, so the teacher/owner has a
// fallback if a DOCX ever fails to open cleanly in Word. A CDN ESM zip
// lib is a client-only dependency — the zero-npm-deps constraint in the
// plan applies to the serverless functions (api/*.js), not the browser
// module graph, so this doesn't violate it.
async function onDownloadAllZip(container, docs) {
  if (!docs.length) return toast('Belum ada dokumen untuk diunduh.', { error: true });
  await withExportGate(() => runDownloadAllZip(container, docs));
}

async function runDownloadAllZip(container, docs) {
  const btn = container.querySelector('#btn-download-all');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyiapkan zip…'; }
  toast(`Menyiapkan zip untuk ${docs.length} dokumen…`);

  try {
    const { zipSync } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8/+esm');
    const files = {};
    const usedNames = new Set();

    const uniqueName = (base, ext) => {
      let name = sanitizeFilename(base) + ext;
      let n = 2;
      while (usedNames.has(name)) { name = sanitizeFilename(base) + ' (' + n + ')' + ext; n++; }
      usedNames.add(name);
      return name;
    };

    for (const doc of docs) {
      let html;
      try {
        ({ html } = await doc.build());
      } catch (e) {
        toast('Gagal merender ' + doc.label + ': ' + String((e && e.message) || e), { error: true });
        continue;
      }
      try {
        const mhtBlob = await buildMht(html);
        files[uniqueName(doc.label, '.mht')] = new Uint8Array(await mhtBlob.arrayBuffer());
      } catch (e) {
        toast('Gagal membuat MHT untuk ' + doc.label + ': ' + String((e && e.message) || e), { error: true });
      }
      try {
        const docxBlob = await buildDocxBlob(html);
        files[uniqueName(doc.label, '.docx')] = new Uint8Array(await docxBlob.arrayBuffer());
      } catch (e) {
        toast('Gagal membuat DOCX untuk ' + doc.label + ': ' + String((e && e.message) || e), { error: true });
      }
    }

    const zipped = zipSync(files, { level: 6 });
    const blob = new Blob([zipped], { type: 'application/zip' });
    const h = state.spine.header;
    const zipName = sanitizeFilename(`Perangkat - ${h.mapel || ''} Kelas ${h.kelas || ''}`) + '.zip';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast(`Zip "${zipName}" berhasil diunduh (${docs.length} dokumen × MHT+DOCX).`);
  } catch (e) {
    toast('Gagal membuat zip: ' + String((e && e.message) || e), { error: true });
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Unduh Semua (.zip)'; }
  }
}

// ---- Owner-only estimated cost readout (pemeran_gen_log aggregate) --------
const HAIKU_PRICE_PER_MTOK = { input: 1.0, output: 5.0, cacheRead: 0.1, cacheWrite: 1.25 };
const USD_TO_IDR_APPROX = 16000;

function estimateCostUsd(stats) {
  return (
    (stats.input / 1e6) * HAIKU_PRICE_PER_MTOK.input +
    (stats.output / 1e6) * HAIKU_PRICE_PER_MTOK.output +
    (stats.cacheRead / 1e6) * HAIKU_PRICE_PER_MTOK.cacheRead +
    (stats.cacheWrite / 1e6) * HAIKU_PRICE_PER_MTOK.cacheWrite
  );
}

async function renderCostPanel(container) {
  const panel = container.querySelector('#cost-panel');
  if (!panel) return;
  panel.innerHTML = '<h3 style="margin:0 0 8px;">Estimasi Biaya AI (khusus pemilik)</h3><p class="muted small">Memuat…</p>';

  if (!state.planId) {
    panel.innerHTML = '<h3 style="margin:0 0 8px;">Estimasi Biaya AI (khusus pemilik)</h3><p class="muted small">Dokumen belum tersimpan — belum ada statistik untuk ditampilkan.</p>';
    return;
  }

  let stats;
  try {
    const r = await call('gen_stats', { planId: state.planId, teacherId: state.teacher.id });
    stats = r.stats;
  } catch (e) {
    panel.innerHTML = '<h3 style="margin:0 0 8px;">Estimasi Biaya AI (khusus pemilik)</h3><p class="muted small">Gagal memuat statistik.</p>';
    return;
  }

  const usd = estimateCostUsd(stats);
  const idr = usd * USD_TO_IDR_APPROX;

  panel.innerHTML = `
    <h3 style="margin:0 0 8px;">Estimasi Biaya AI (khusus pemilik)</h3>
    <div class="grid grid-3">
      <div><strong>${stats.calls}</strong><div class="muted small">panggilan AI</div></div>
      <div><strong>${stats.input.toLocaleString('id-ID')}</strong><div class="muted small">token input</div></div>
      <div><strong>${stats.output.toLocaleString('id-ID')}</strong><div class="muted small">token output</div></div>
      <div><strong>${stats.cacheRead.toLocaleString('id-ID')}</strong><div class="muted small">cache read</div></div>
      <div><strong>${stats.cacheWrite.toLocaleString('id-ID')}</strong><div class="muted small">cache write</div></div>
      <div><strong>~$${usd.toFixed(4)}</strong><div class="muted small">≈ Rp${Math.round(idr).toLocaleString('id-ID')} (estimasi)</div></div>
    </div>
    <p class="field-hint">Estimasi berdasarkan tarif Haiku 4.5 ($1/$5 per MTok input/output, cache read ≈0.1×, cache write ≈1.25×) dan kurs perkiraan Rp${USD_TO_IDR_APPROX.toLocaleString('id-ID')}/USD — bukan kurs atau tagihan real-time.</p>
  `;
}
