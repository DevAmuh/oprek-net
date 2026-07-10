// =============================================================
// Pemeran — RPP renderer: spine + unit + AI/dummy content
// -> fully substituted paper-template HTML.
// -------------------------------------------------------------
// Owns the one piece of "logic" the ported docHtml engine doesn't
// have out of the box: expanding templates/rpp.html's
// <template data-repeat="pertemuan"> into N per-meeting row groups
// (one per meeting), each with uniquely-suffixed data-field names
// so substitute.js's single-field-name-per-marker model still works
// unmodified. Everything else is a thin values-builder around
// docHtml/substitute.js.
// =============================================================

import { substitute } from './docHtml/substitute.js';

const ROMAN = { 7: 'VII', 8: 'VIII', 9: 'IX' };

function toRoman(kelas) {
  return ROMAN[Number(kelas)] || String(kelas || '');
}

function semesterLabel(semester) {
  return Number(semester) === 2 ? 'Genap' : 'Ganjil';
}

/** Split tpList into `count` roughly-even, contiguous chunks (simple M2
 *  approximation — the real TP-per-meeting assignment is an ATP/pipeline.js
 *  concern from M3 onward). */
function chunkTpForMeetings(tpList, count) {
  const list = Array.isArray(tpList) ? tpList : [];
  if (!list.length || count <= 1) return Array.from({ length: count }, () => list);
  const out = Array.from({ length: count }, () => []);
  list.forEach((tp, i) => { out[Math.min(count - 1, Math.floor((i * count) / list.length))].push(tp); });
  return out;
}

/** Fix the one spelling mismatch between konstanta.json's canonical
 *  "Ketakwaan" and older SMPI-AHA docx exports' "Ketaqwaan" so the
 *  template's exact-substring checkbox matcher (substitute.js
 *  applyCheckboxList) reliably ticks the right box regardless of which
 *  spelling the caller passes in. Template li[data-item] text now also
 *  uses "Ketakwaan" (see templates/rpp.html) so this is mostly a safety
 *  net for values coming from older data. */
function normalizeDimensiLabel(label) {
  return String(label || '').replace(/Ketaqwaan/gi, 'Ketakwaan');
}

/** Expand the <template data-repeat="pertemuan"> block in the parsed
 *  template DOM into `count` copies, each with data-field attributes
 *  suffixed "__<index>" so every marker has a globally-unique field name.
 *  Returns the list of per-meeting field-name maps so the caller can
 *  build the `ai` value bucket with matching keys. */
function expandPertemuanRepeat(doc, unit) {
  const tbody = doc.getElementById('rpp-tbody');
  const template = doc.querySelector('template[data-repeat="pertemuan"]');
  const pengalamanCell = doc.getElementById('pengalaman-cell');
  if (!tbody || !template) return [];

  const count = Math.max(1, Number(unit.pertemuanCount) || 1);
  const jpPerPertemuan = Number(unit.jpPerPertemuan) || 2;
  const tpChunks = chunkTpForMeetings(unit.tpList, count);

  const perMeetingFields = [];
  const insertionPoint = template; // insert clones just before the <template>, in order

  for (let i = 0; i < count; i++) {
    const clone = template.content.cloneNode(true);
    const totalJp = Number(unit.jp) || jpPerPertemuan * count;
    const jpThisMeeting = i === count - 1
      ? Math.max(1, totalJp - jpPerPertemuan * (count - 1))
      : jpPerPertemuan;
    const tpCodes = (tpChunks[i] || []).map((t) => t.kode).filter(Boolean).join(', ');

    const titleCell = clone.querySelector('[data-pertemuan-title]');
    if (titleCell) {
      titleCell.textContent = `Pertemuan ${i + 1} dari ${count} (${jpThisMeeting} JP)` + (tpCodes ? ` — TP: ${tpCodes}` : '');
    }

    const fieldMap = {};
    clone.querySelectorAll('[data-field]').forEach((el) => {
      const base = el.getAttribute('data-field');
      const suffixed = `${base}__${i}`;
      el.setAttribute('data-field', suffixed);
      fieldMap[base] = suffixed;
    });
    perMeetingFields.push(fieldMap);

    insertionPoint.parentNode.insertBefore(clone, insertionPoint);
  }

  template.remove();

  if (pengalamanCell) {
    pengalamanCell.setAttribute('rowspan', String(1 + 12 * count));
  }

  return perMeetingFields;
}

/** Build the {manual, system, ai} bucket substitute.js expects. */
function buildFieldValues(header, unit, content, perMeetingFields, menitPerJp) {
  const manual = {
    topic: unit.topik || '',
    subject: header.mapel || '',
    grade: toRoman(header.kelas),
    semester: semesterLabel(unit.semester),
    cp_phase: 'D',
    // menitPerJp: M3 config (spine.config.menitPerJp, default 40) — the SOP
    // default is 40'/JP but a school's KOSP can set 45' instead (see the
    // M2->M3 handoff note about the school's filled RPPs using 45').
    duration: `${unit.pertemuanCount} Pertemuan x ${unit.jpPerPertemuan} JP @${menitPerJp}' (Total ${unit.jp} JP)`,
    meeting_number: `${unit.pertemuanCount} Pertemuan`,
    school_year: header.tahunAjaran || '',
  };

  const system = {
    school_name: header.sekolah || '',
    teacher_name: header.guru || '',
    principal_name: header.kepsek || '',
    principal_nik: header.kepsekNik || '',
    city: header.kota || '',
    // school_logo_url / school_banner_url intentionally omitted — the
    // template's own src="assets/logo.gif" / "assets/banner.gif" default
    // is used (substitute.js only overwrites <img src> when a value is
    // actually supplied).
  };

  const tujuanPembelajaran = (unit.tpList || [])
    .map((t) => `**${t.kode}**: ${t.rumusan}`)
    .join('\n') || '(belum ada TP)';

  const ai = {
    peserta_didik: content.peserta_didik || '',
    materi_pelajaran: content.materi_pelajaran || '',
    graduate_profile_selected: (content.graduate_profile_selected || []).map(normalizeDimensiLabel),
    santri_kitab_selected: content.santri_kitab_selected || [],
    internalisasi_nilai_agama: content.internalisasi_nilai_agama || '',
    capaian_element: content.capaian_element || '',
    capaian_competence: content.capaian_competence || '',
    capaian_content: content.capaian_content || '',
    lintas_disiplin_ilmu: content.lintas_disiplin_ilmu || '',
    tujuan_pembelajaran: tujuanPembelajaran,
    model: content.model || '',
    strategy: content.strategy || '',
    method: content.method || '',
    kemitraan: content.kemitraan || '',
    lingkungan: content.lingkungan || '',
    digital: content.digital || '',
    asesmen_awal: content.asesmen_awal || '',
    asesmen_proses: content.asesmen_proses || '',
    asesmen_akhir: content.asesmen_akhir || '',
    learning_media: content.learning_media || '',
  };

  const pertemuan = Array.isArray(content.pertemuan) ? content.pertemuan : [];
  perMeetingFields.forEach((fieldMap, i) => {
    const meeting = pertemuan[i] || {};
    ai[fieldMap.opening] = meeting.opening || '';
    ai[fieldMap.memahami] = meeting.memahami || '';
    ai[fieldMap.mengaplikasi] = meeting.mengaplikasi || '';
    ai[fieldMap.merefleksi] = meeting.merefleksi || '';
    ai[fieldMap.closing] = meeting.closing || '';
  });

  return { manual, system, ai };
}

let templateHtmlCache = null;
async function fetchTemplateHtml() {
  if (templateHtmlCache) return templateHtmlCache;
  const res = await fetch('templates/rpp.html', { cache: 'no-store' });
  if (!res.ok) throw new Error('Tidak bisa memuat templates/rpp.html (kode ' + res.status + ').');
  templateHtmlCache = await res.text();
  return templateHtmlCache;
}

/**
 * Render one RPP unit into fully-substituted, standalone HTML.
 * @param {object} opts
 * @param {object} opts.header   spine.header
 * @param {object} opts.unit     {topik, jp, semester, jpPerPertemuan, pertemuanCount, tpList, kktpList}
 * @param {object} opts.content  AI/dummy RPP content (see api/pemeran-ai.js rppContentSchema)
 * @param {number} [opts.menitPerJp]  spine.config.menitPerJp (default 40 — SOP default, KOSP can override)
 * @returns {Promise<{html: string, warnings: string[]}>}
 */
export async function renderRppHtml({ header, unit, content, menitPerJp }) {
  const templateHtml = await fetchTemplateHtml();
  const doc = new DOMParser().parseFromString(templateHtml, 'text/html');

  const perMeetingFields = expandPertemuanRepeat(doc, unit);
  const expandedHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;

  const values = buildFieldValues(header, unit, content, perMeetingFields, Number(menitPerJp) > 0 ? Number(menitPerJp) : 40);
  const { html, warnings } = substitute(expandedHtml, values);
  return { html, warnings };
}

export { toRoman, semesterLabel };
