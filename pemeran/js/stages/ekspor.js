// =============================================================
// Pemeran — Stage: Ekspor
// -------------------------------------------------------------
// Per-document MHT/PDF/HTML/DOCX buttons (TP&KKTP, Prota/ATP, Prosem x2
// semester, each RPP) + the validator panel (SOP §12.A, validate.js).
// Red errors block export with an explanation (plan's Validator section).
// M4: DOCX export added (render/docHtml/toDocx.js + export/docx.js),
// "Unduh Semua (.zip)" (fflate, client-side), and an owner-only
// gen_log cost readout.
// =============================================================

import { state } from '../state.js';
import { toast, call } from '../api.js';
import { runValidator, overallLevel } from '../validate.js';
import { renderTpKktpHtml } from '../render/tpkktp.js';
import { renderProtaHtml } from '../render/prota.js';
import { renderProsemHtml } from '../render/prosem.js';
import { renderRppHtml } from '../render/rpp.js';
import { distributeProsem } from '../pipeline.js';
import { downloadMht, buildMht } from '../export/mht.js';
import { printRppHtml } from '../export/pdf.js';
import { exportRppHtml } from '../export/html.js';
import { downloadDocx } from '../export/docx.js';
import { buildDocxBlob } from '../render/docHtml/toDocx.js';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const LEVEL_ICON = { ok: '✓', warn: '⚠', error: '✗' };
const LEVEL_BG = { ok: 'var(--good-soft)', warn: 'var(--warn-soft)', error: 'var(--bad-soft)' };
const LEVEL_FG = { ok: 'var(--good)', warn: 'var(--warn)', error: 'var(--bad)' };

// One entry per exportable document: { key, label, build() -> {html} }
async function collectDocs() {
  const { header, cp, tps, kktps, units, sumatif, config, rpps } = state.spine;
  const docs = [];

  if (tps.length || kktps.length) {
    docs.push({ key: 'tpkktp', label: 'TP & KKTP', build: () => renderTpKktpHtml({ header, tps, kktps }) });
  }
  if (units.length) {
    docs.push({ key: 'prota', label: 'Prota & ATP', build: () => renderProtaHtml({ header, cpElemen: cp.elemen, tps, units, sumatif }) });

    const computed = distributeProsem(units, sumatif, config, header.kelas);
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
    docs.push({
      key: 'rpp_' + entry.id, label: 'RPP — ' + (entry.unit && entry.unit.topik),
      build: () => renderRppHtml({ header, unit: entry.unit, content: entry.content, menitPerJp: config.menitPerJp }),
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
          <h2>Ekspor Dokumen</h2>
          <button class="btn btn-outline" id="btn-download-all">⬇ Unduh Semua (.zip)</button>
        </div>
        <p class="muted small">Setiap dokumen dapat diunduh sebagai MHT (dibuka langsung di Word), DOCX, dicetak/disimpan sebagai PDF, atau diunduh sebagai HTML mandiri. "Unduh Semua" membundel MHT + DOCX tiap dokumen dalam satu berkas .zip.</p>
      </div>
      <div class="card card-pad-lg" id="validator-panel"></div>
      ${isOwner ? '<div class="card card-pad-lg" id="cost-panel"></div>' : ''}
      <div class="stack" id="docs-list"></div>
    </div>
  `;

  const results = runValidator(state.spine);
  const level = overallLevel(results);
  renderValidatorPanel(container, results, level);

  const docs = await collectDocs();
  renderDocsList(container, docs, level);

  if (isOwner) renderCostPanel(container);

  container.querySelector('#btn-download-all').addEventListener('click', () => onDownloadAllZip(container, docs, level));
}

function renderValidatorPanel(container, results, level) {
  const panel = container.querySelector('#validator-panel');
  const grouped = { error: [], warn: [], ok: [] };
  results.forEach((r) => grouped[r.level].push(r));

  panel.innerHTML = `
    <div class="row-between">
      <h3 style="margin:0;">Validator (SOP §12.A)</h3>
      <span class="chip" style="background:${LEVEL_BG[level]}; color:${LEVEL_FG[level]};">
        ${level === 'ok' ? '✓ Semua pemeriksaan lolos' : level === 'warn' ? '⚠ Ada peringatan' : '✗ Ada kesalahan — ekspor diblokir'}
      </span>
    </div>
    <div class="stack" style="margin-top:var(--space-3);">
      ${['error', 'warn', 'ok'].flatMap((lv) => grouped[lv].map((r) => `
        <div style="display:flex; gap:8px; align-items:flex-start; padding:6px 0; border-bottom:1px solid var(--line);">
          <span style="color:${LEVEL_FG[lv]}; font-weight:700;">${LEVEL_ICON[lv]}</span>
          <span>${escapeHtml(r.pesan)}</span>
        </div>
      `)).join('')}
    </div>
  `;
}

function renderDocsList(container, docs, level) {
  const list = container.querySelector('#docs-list');
  if (!docs.length) {
    list.innerHTML = '<div class="card"><p class="muted">Belum ada dokumen untuk diekspor — lengkapi tahap-tahap sebelumnya dulu.</p></div>';
    return;
  }
  const blocked = level === 'error';
  const blockAttrs = 'disabled title="Perbaiki kesalahan validator (tanda merah) dulu sebelum mengekspor."';

  list.innerHTML = docs.map((d) => `
    <div class="card row-between" data-doc="${d.key}">
      <strong>${escapeHtml(d.label)}</strong>
      <div class="row">
        <button class="btn btn-outline" data-action="mht" data-key="${d.key}" ${blocked ? blockAttrs : ''}>Unduh MHT</button>
        <button class="btn btn-outline" data-action="docx" data-key="${d.key}" ${blocked ? blockAttrs : ''}>Unduh DOCX</button>
        <button class="btn btn-outline" data-action="pdf" data-key="${d.key}" ${blocked ? blockAttrs : ''}>Cetak / PDF</button>
        <button class="btn btn-outline" data-action="html" data-key="${d.key}" ${blocked ? blockAttrs : ''}>Unduh HTML</button>
      </div>
    </div>
  `).join('');

  list.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const doc = docs.find((d) => d.key === btn.dataset.key);
      if (!doc) return;
      btn.disabled = true;
      try {
        const { html } = await doc.build();
        await runExport(btn.dataset.action, html, doc.label);
      } catch (e) {
        toast('Gagal mengekspor ' + doc.label + ': ' + String((e && e.message) || e), { error: true });
      } finally {
        btn.disabled = level === 'error';
      }
    });
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
// module graph, so this doesn't violate it. Sequential-individual-
// download was the fallback option; a real zip was chosen because it's a
// single click/download instead of 2×N popup-triggered downloads (MHT+
// DOCX per doc), which browsers often throttle/block as a "download
// flood" past a handful of files.
async function onDownloadAllZip(container, docs, level) {
  if (level === 'error') return toast('Perbaiki kesalahan validator dulu sebelum mengunduh semua dokumen.', { error: true });
  if (!docs.length) return toast('Belum ada dokumen untuk diunduh.', { error: true });

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
    if (btn) { btn.disabled = level === 'error'; btn.textContent = '⬇ Unduh Semua (.zip)'; }
  }
}

// ---- Owner-only estimated cost readout (pemeran_gen_log aggregate) --------
// Haiku 4.5 published pricing: $1/MTok input, $5/MTok output; prompt-cache
// read ~0.1x input, cache write ~1.25x input (per the plan's own figures).
// Labeled "Estimasi" throughout — gen_log's per-call token counts are exact,
// but the USD->IDR conversion below uses a fixed approximate rate, not a
// live FX feed.
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
