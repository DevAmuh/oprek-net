// =============================================================
// Pemeran — Prosem renderer: spine + pipeline.distributeProsem() output
// -> fully substituted landscape paper-template HTML, one semester
// at a time (matches the school's real docx, which ships as two
// separate per-semester files).
// -------------------------------------------------------------
// The header block uses the ported docHtml substitute() engine; the
// weekly matrix (dynamic month/week columns) is built programmatically
// with plain DOM calls and mounted into #prosem-table-mount — simpler
// than shoehorning a variable-width grid into the marker system (per
// the plan: "pick the simpler path per doc").
// =============================================================

import { substitute } from './docHtml/substitute.js';

const ROMAN = { 7: 'VII', 8: 'VIII', 9: 'IX' };
function toRoman(kelas) { return ROMAN[Number(kelas)] || String(kelas || ''); }

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function buildMatrixHtml(semesterData, unitMetaById) {
  const { calendar, rows, totalJp } = semesterData;
  const totalWeeks = calendar.reduce((s, m) => s + m.mingguCount, 0);

  let html = '<table class="prosem-table"><thead>';
  html += '<tr>'
    + '<th rowspan="3" style="width:24px;">No</th>'
    + '<th rowspan="3" style="width:170px;">Capaian Pembelajaran</th>'
    + '<th rowspan="3" style="width:90px;">Elemen</th>'
    + '<th rowspan="3" style="width:150px;">Materi</th>'
    + '<th rowspan="3" style="width:50px;">Alokasi Waktu</th>'
    + `<th colspan="${totalWeeks || 1}">Bulan</th>`
    + '</tr>';
  html += '<tr>' + (calendar.length
    ? calendar.map((m) => `<th colspan="${Math.max(1, m.mingguCount)}">${escapeHtml(m.bulan)}</th>`).join('')
    : '<th></th>') + '</tr>';
  html += '<tr>' + (calendar.length
    ? calendar.flatMap((m) => Array.from({ length: m.mingguCount }, (_, i) => `<th>${i + 1}</th>`)).join('')
    : '<th></th>') + '</tr>';
  html += '</thead><tbody>';

  // Flat ordered list of {bulan,minggu} slots, matching pipeline's own
  // flattening order, so a row's `cells` line up with the right column.
  const slots = [];
  for (const m of calendar) for (let w = 1; w <= m.mingguCount; w++) slots.push({ bulan: m.bulan, minggu: w });
  const slotIndex = (bulan, minggu) => slots.findIndex((s) => s.bulan === bulan && s.minggu === minggu);

  rows.forEach((row, i) => {
    const isSumatif = row.tipe === 'sumatif';
    const meta = (!isSumatif && unitMetaById[row.id]) || { elemen: '', cpText: '' };
    html += `<tr class="${isSumatif ? 'sumatif-row' : ''}">`;
    html += `<td>${i + 1}</td>`;
    html += `<td class="cp-cell">${escapeHtml(isSumatif ? row.materi : meta.cpText)}</td>`;
    html += `<td>${escapeHtml(isSumatif ? '' : meta.elemen)}</td>`;
    html += `<td class="materi-cell">${escapeHtml(row.materi)}</td>`;
    html += `<td>${row.totalJp}</td>`;
    // V2b #4 — each week cell carries its row/week identity so
    // stages/prosem.js can attach a click-to-move-JP handler directly to
    // the live iframe DOM (this matrix is built programmatically outside
    // the data-marker system, so the shared editable.js engine doesn't
    // apply here — a bespoke handler is the documented approach).
    const jpBySlot = new Array(slots.length).fill(0);
    for (const c of row.cells) {
      const idx = slotIndex(c.bulan, c.minggu);
      if (idx >= 0) jpBySlot[idx] = c.jp;
    }
    html += slots.map((slot, si) => {
      const jp = jpBySlot[si];
      const filled = jp > 0;
      return `<td class="mark${filled ? ' is-filled' : ''}" data-row-id="${escapeHtml(String(row.id))}" data-bulan="${escapeHtml(slot.bulan)}" data-minggu="${slot.minggu}" data-jp="${filled ? jp : ''}">${filled ? 'v' : ''}</td>`;
    }).join('');
    html += '</tr>';
  });

  html += `<tr class="total-row"><td colspan="4">Total JP</td><td>${totalJp}</td>${new Array(totalWeeks).fill('<td></td>').join('')}</tr>`;
  html += '</tbody></table>';
  return html;
}

/** Best-effort "Elemen" + "Capaian Pembelajaran" text per unit, for the
 *  matrix's leading columns — derived from the unit's TPs' elemen (majority
 *  vote if mixed), not stored on the unit itself (display only). */
function buildUnitMeta(units, tps, cpElemen) {
  const out = {};
  for (const u of units) {
    const elemenNames = (u.tpKodes || [])
      .map((k) => (tps.find((t) => t.kode === k) || {}).elemen)
      .filter(Boolean);
    const counts = {};
    elemenNames.forEach((n) => { counts[n] = (counts[n] || 0) + 1; });
    const topElemen = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
    const cpEntry = cpElemen.find((e) => e.nama === topElemen);
    const cpText = cpEntry ? cpEntry.teks.slice(0, 140) + (cpEntry.teks.length > 140 ? '…' : '') : '';
    out[u.id] = { elemen: topElemen, cpText };
  }
  return out;
}

let templateHtmlCache = null;
async function fetchTemplateHtml() {
  if (templateHtmlCache) return templateHtmlCache;
  const res = await fetch('templates/prosem.html', { cache: 'no-store' });
  if (!res.ok) throw new Error('Tidak bisa memuat templates/prosem.html (kode ' + res.status + ').');
  templateHtmlCache = await res.text();
  return templateHtmlCache;
}

/**
 * @param {object} opts
 * @param {object} opts.header  spine.header
 * @param {object} opts.config  spine.config (jpPerMinggu, menitPerJp, kktpThreshold)
 * @param {number} opts.semesterNum  1 or 2
 * @param {object} opts.semesterData  pipeline.distributeProsem(...).semester1|2
 * @param {Array}  [opts.units]  spine.units — used to look up each row's elemen/CP text (best-effort, display only)
 * @param {Array}  [opts.tps]    spine.tps
 * @param {Array}  [opts.cpElemen]  spine.cp.elemen
 */
export async function renderProsemHtml({ header, config, semesterNum, semesterData, units, tps, cpElemen }) {
  const templateHtml = await fetchTemplateHtml();
  const unitMetaById = buildUnitMeta(units || [], tps || [], cpElemen || []);

  const manual = {
    subject: header.mapel || '',
    fase_kelas: `D/ Kelas ${header.kelas || ''} (${toRoman(header.kelas)})`,
    semester: semesterNum === 2 ? '2 (Genap)' : '1 (Ganjil)',
    school_year: header.tahunAjaran || '',
    alokasi_waktu: `${config.jpPerMinggu || '?'} JP @${config.menitPerJp || 40} menit`,
    kktp_threshold: String(config.kktpThreshold ?? 78),
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
  const mount = doc.getElementById('prosem-table-mount');
  if (mount) mount.innerHTML = buildMatrixHtml(semesterData, unitMetaById);

  return { html: '<!DOCTYPE html>\n' + doc.documentElement.outerHTML, warnings };
}
