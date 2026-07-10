// =============================================================
// Pemeran — TP/KKTP renderer: spine -> fully substituted paper HTML.
// Columns per SOP §14.2 (see templates/tp_kktp.html header comment).
// =============================================================

import { substitute } from './docHtml/substitute.js';

const ROMAN = { 7: 'VII', 8: 'VIII', 9: 'IX' };
function toRoman(kelas) { return ROMAN[Number(kelas)] || String(kelas || ''); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function bloomLabel(bloom) {
  const labels = { C1: 'Mengingat', C2: 'Memahami', C3: 'Menerapkan', C4: 'Menganalisis', C5: 'Mengevaluasi', C6: 'Mencipta' };
  return bloom ? `${bloom} (${labels[bloom] || ''})` : '';
}

function buildTpTable(tps) {
  let html = '<table class="doc-table"><thead><tr>'
    + '<th style="width:90px;">Kode TP</th><th style="width:120px;">Elemen</th><th>Rumusan TP</th><th style="width:130px;">Kata Kerja (level Bloom)</th>'
    + '</tr></thead><tbody>';
  for (const t of tps) {
    html += `<tr><td class="center">${escapeHtml(t.kode)}</td><td>${escapeHtml(t.elemen)}</td><td>${escapeHtml(t.rumusan)}</td><td class="center">${escapeHtml(bloomLabel(t.bloom))}</td></tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function buildKktpTable(kktps) {
  let html = '<table class="doc-table"><thead><tr>'
    + '<th style="width:110px;">Kode KKTP</th><th style="width:90px;">Kode TP Induk</th><th style="width:80px;">Metode</th><th>Kriteria/Rentang</th><th style="width:140px;">Instrumen Rujukan</th>'
    + '</tr></thead><tbody>';
  for (const k of kktps) {
    html += `<tr><td class="center">${escapeHtml(k.kode)}</td><td class="center">${escapeHtml(k.tpKode)}</td><td class="center">${escapeHtml(k.metode)}</td><td>${escapeHtml(k.kriteria)}</td><td>${escapeHtml(k.instrumen)}</td></tr>`;
  }
  html += '</tbody></table>';
  return html;
}

let templateHtmlCache = null;
async function fetchTemplateHtml() {
  if (templateHtmlCache) return templateHtmlCache;
  const res = await fetch('templates/tp_kktp.html', { cache: 'no-store' });
  if (!res.ok) throw new Error('Tidak bisa memuat templates/tp_kktp.html (kode ' + res.status + ').');
  templateHtmlCache = await res.text();
  return templateHtmlCache;
}

/**
 * @param {object} opts
 * @param {object} opts.header  spine.header
 * @param {Array}  opts.tps  spine.tps
 * @param {Array}  opts.kktps  spine.kktps
 */
export async function renderTpKktpHtml({ header, tps, kktps }) {
  const templateHtml = await fetchTemplateHtml();

  const manual = {
    subject: header.mapel || '',
    fase_kelas: `D/ ${header.kelas || ''} (${toRoman(header.kelas)})`,
    school_year: header.tahunAjaran || '',
  };
  const system = {
    school_name: header.sekolah || '',
    teacher_name: header.guru || '',
    principal_name: header.kepsek || '',
    principal_nik: header.kepsekNik || '',
    city: header.kota || '',
  };

  const { html: substituted, warnings } = substitute(templateHtml, { manual, system, ai: {} });
  const doc = new DOMParser().parseFromString(substituted, 'text/html');

  const tpMount = doc.getElementById('tp-table-mount');
  if (tpMount) tpMount.innerHTML = buildTpTable(tps);
  const kktpMount = doc.getElementById('kktp-table-mount');
  if (kktpMount) kktpMount.innerHTML = buildKktpTable(kktps);

  return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, warnings };
}
