// =============================================================
// Pemeran — Prota/ATP renderer: spine -> fully substituted paper HTML.
// -------------------------------------------------------------
// Combined single document: CP-per-elemen table, then "Alur Tujuan
// Pembelajaran (ATP) Semester 1/2" sections, each with one sub-table
// per unit (Kode TP | Rumusan TP | Kompetensi | Konten | JP) plus
// sumatif bands and a semester Total row — matches the school's real
// docx structure (verified against Prota - ESP - Grade 7 docx).
//
// Simplification vs. the real doc: JP is a UNIT-level figure in this
// app's spine (not per-TP as the source ESP doc happens to show for its
// 4-skill breakdown) — shown once per unit (rowspan over its TP rows).
// =============================================================

import { substitute } from './docHtml/substitute.js';
import { aggregateProta } from '../pipeline.js';

const ROMAN = { 7: 'VII', 8: 'VIII', 9: 'IX' };
function toRoman(kelas) { return ROMAN[Number(kelas)] || String(kelas || ''); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function bloomShort(bloom) {
  const labels = { C1: 'Mengingat', C2: 'Memahami', C3: 'Menerapkan', C4: 'Menganalisis', C5: 'Mengevaluasi', C6: 'Mencipta' };
  return bloom ? `${bloom} — ${labels[bloom] || ''}` : '';
}

function buildCpTable(cpElemen) {
  let html = '<table class="doc-table"><thead><tr><th style="width:120px;">Elemen</th><th>Capaian Pembelajaran</th></tr></thead><tbody>';
  for (const e of cpElemen) {
    html += `<tr><td><strong>${escapeHtml(e.nama)}</strong></td><td>${escapeHtml(e.teks)}</td></tr>`;
  }
  html += '</tbody></table>';
  return html;
}

function sumatifLabel(jenis) {
  const map = { STS1: 'Sumatif Tengah Semester 1', SAS: 'Sumatif Akhir Semester (Ganjil)', STS2: 'Sumatif Tengah Semester 2', SAT: 'Sumatif Akhir Tahun (Genap)' };
  return map[jenis] || jenis;
}

function buildSemesterSection(semLabel, semData, tps, cpElemen) {
  let html = `<h2 class="section-title" data-marker="0">Alur Tujuan Pembelajaran (ATP) Semester ${semLabel}</h2>`;

  for (const item of semData.items) {
    if (item.tipe === 'sumatif') {
      html += `<table class="doc-table"><tbody><tr class="sumatif-band"><td colspan="4">${escapeHtml(sumatifLabel(item.ref.jenis))}</td><td>${item.jp} JP</td></tr></tbody></table>`;
      continue;
    }

    const unit = item.ref;
    // V2b #6 — `unit.urutan` (1-based, dense, assigned by pipeline.buildUnits)
    // doubles as a stable GLOBAL numeric suffix for data-field: a per-
    // semester loop index would collide (semester 1's unit #1 and semester
    // 2's unit #1 would both emit "__0"), since this function is called
    // once per semester with its own local item list.
    const fieldIdx = (Number(unit.urutan) || 1) - 1;
    const unitTps = unit.tpKodes.map((k) => tps.find((t) => t.kode === k)).filter(Boolean);
    const elemenNames = [...new Set(unitTps.map((t) => t.elemen))];
    const cpText = elemenNames.map((n) => (cpElemen.find((e) => e.nama === n) || {}).teks).filter(Boolean).join(' / ');

    html += '<table class="doc-table"><thead>';
    html += `<tr class="cp-band"><td colspan="5">Capaian Pembelajaran: ${escapeHtml(cpText || elemenNames.join(', '))}</td></tr>`;
    html += '<tr><th style="width:80px;">Kode TP</th><th>Rumusan Tujuan Pembelajaran</th><th style="width:110px;">Kompetensi</th><th style="width:110px;">Konten/Unit</th><th style="width:50px;">JP</th></tr>';
    html += '</thead><tbody>';
    unitTps.forEach((tp, i) => {
      html += '<tr>'
        + `<td>${escapeHtml(tp.kode)}</td>`
        + `<td>${escapeHtml(tp.rumusan)}</td>`
        + `<td class="center">${escapeHtml(bloomShort(tp.bloom))}</td>`
        + (i === 0 ? `<td class="center" data-marker="3" data-field="unit_nama__${fieldIdx}" rowspan="${unitTps.length}">${escapeHtml(unit.nama)}</td>` : '')
        + (i === 0 ? `<td class="center" data-marker="3" data-field="unit_jp__${fieldIdx}" rowspan="${unitTps.length}">${unit.jp}</td>` : '')
        + '</tr>';
    });
    html += `<tr class="total-band"><td colspan="5">Total Unit "${escapeHtml(unit.nama)}": ${unit.jp} JP</td></tr>`;
    html += '</tbody></table>';
  }

  html += `<table class="doc-table"><tbody><tr class="semester-total-band"><td colspan="5">Total JP Semester ${semLabel}: ${semData.totalJp} JP</td></tr></tbody></table>`;
  return html;
}

let templateHtmlCache = null;
async function fetchTemplateHtml() {
  if (templateHtmlCache) return templateHtmlCache;
  const res = await fetch('templates/prota_atp.html', { cache: 'no-store' });
  if (!res.ok) throw new Error('Tidak bisa memuat templates/prota_atp.html (kode ' + res.status + ').');
  templateHtmlCache = await res.text();
  return templateHtmlCache;
}

/**
 * @param {object} opts
 * @param {object} opts.header  spine.header
 * @param {Array}  opts.cpElemen  spine.cp.elemen
 * @param {Array}  opts.tps  spine.tps
 * @param {Array}  opts.units  spine.units
 * @param {Array}  opts.sumatif  spine.sumatif
 */
export async function renderProtaHtml({ header, cpElemen, tps, units, sumatif }) {
  const templateHtml = await fetchTemplateHtml();
  const prota = aggregateProta(units, sumatif);

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

  const cpMount = doc.getElementById('cp-table-mount');
  if (cpMount) cpMount.innerHTML = buildCpTable(cpElemen);
  const s1Mount = doc.getElementById('atp-semester1-mount');
  if (s1Mount) s1Mount.innerHTML = buildSemesterSection('1 (Ganjil)', prota.semester1, tps, cpElemen);
  const s2Mount = doc.getElementById('atp-semester2-mount');
  if (s2Mount) s2Mount.innerHTML = buildSemesterSection('2 (Genap)', prota.semester2, tps, cpElemen);

  return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, warnings, prota };
}
