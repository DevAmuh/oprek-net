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
import { normalizeConfig, splitMeetings } from '../pipeline.js';

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
 *  template DOM into per-meeting copies, each with data-field attributes
 *  suffixed "__<absoluteIndex>" so every marker has a globally-unique field
 *  name. Normally expands ALL meetings (full multi-meeting document); when
 *  `opts.meetingIndex` is a number, only THAT one meeting is cloned (single-
 *  meeting document — V2a #4's per-meeting tab/export). The "__<index>"
 *  suffix always uses the meeting's ABSOLUTE index (never a relative 0),
 *  so field names — and therefore wireEditableCells()'s parsing of them in
 *  stages/rpp.js — are identical whether the caller asked for the full
 *  document or a single meeting.
 *  Returns [{ index, fieldMap }] (one entry per expanded meeting) so the
 *  caller can build the `ai` value bucket keyed by the right suffixed names. */
function expandPertemuanRepeat(doc, unit, opts) {
  const tbody = doc.getElementById('rpp-tbody');
  const template = doc.querySelector('template[data-repeat="pertemuan"]');
  const pengalamanCell = doc.getElementById('pengalaman-cell');
  if (!tbody || !template) return [];

  const totalCount = Math.max(1, Number(unit.pertemuanCount) || 1);
  const single = opts && Number.isInteger(opts.meetingIndex);
  const indices = single
    ? [Math.min(Math.max(0, opts.meetingIndex), totalCount - 1)]
    : Array.from({ length: totalCount }, (_, i) => i);

  const jpPerPertemuan = Number(unit.jpPerPertemuan) || 2;
  const tpChunks = chunkTpForMeetings(unit.tpList, totalCount);

  const perMeetingFields = [];
  const insertionPoint = template; // insert clones just before the <template>, in order

  for (const i of indices) {
    const clone = template.content.cloneNode(true);
    const totalJp = Number(unit.jp) || jpPerPertemuan * totalCount;
    const jpThisMeeting = i === totalCount - 1
      ? Math.max(1, totalJp - jpPerPertemuan * (totalCount - 1))
      : jpPerPertemuan;
    const tpCodes = (tpChunks[i] || []).map((t) => t.kode).filter(Boolean).join(', ');

    const titleCell = clone.querySelector('[data-pertemuan-title]');
    if (titleCell) {
      titleCell.textContent = `Pertemuan ${i + 1} dari ${totalCount} (${jpThisMeeting} JP)` + (tpCodes ? ` — TP: ${tpCodes}` : '');
    }

    const fieldMap = {};
    clone.querySelectorAll('[data-field]').forEach((el) => {
      const base = el.getAttribute('data-field');
      const suffixed = `${base}__${i}`;
      el.setAttribute('data-field', suffixed);
      fieldMap[base] = suffixed;
    });
    perMeetingFields.push({ index: i, fieldMap });

    insertionPoint.parentNode.insertBefore(clone, insertionPoint);
  }

  template.remove();

  if (pengalamanCell) {
    pengalamanCell.setAttribute('rowspan', String(1 + 12 * indices.length));
  }

  return perMeetingFields;
}

/** Build the {manual, system, ai} bucket substitute.js expects.
 *  When `meetingIndex` (absolute, 0-based) is given, the identity fields
 *  describe just THAT one meeting (V2a #4 single-meeting doc) instead of
 *  the whole unit — same {jp, menit} numbers splitMeetings()/normalizeConfig()
 *  give the meeting-tab UI and the validator, so the three never disagree. */
function buildFieldValues(header, unit, content, perMeetingFields, menitPerJp, meetingIndex) {
  const isSingleMeeting = Number.isInteger(meetingIndex);
  let duration; let meetingNumber;
  if (isSingleMeeting) {
    const { meetings } = splitMeetings({ jp: unit.jp }, { jpPerPertemuan: unit.jpPerPertemuan, menitPerJp });
    const m = meetings[meetingIndex] || {};
    const jpThis = Number(m.jp) > 0 ? m.jp : (Number(unit.jpPerPertemuan) || 2);
    duration = `${jpThis} JP @${menitPerJp}'`;
    meetingNumber = `Pertemuan ${meetingIndex + 1} dari ${unit.pertemuanCount}`;
  } else {
    // menitPerJp: M3 config (spine.config.menitPerJp, default 40) — the SOP
    // default is 40'/JP but a school's KOSP can set 45' instead (see the
    // M2->M3 handoff note about the school's filled RPPs using 45').
    duration = `${unit.pertemuanCount} Pertemuan x ${unit.jpPerPertemuan} JP @${menitPerJp}' (Total ${unit.jp} JP)`;
    meetingNumber = `${unit.pertemuanCount} Pertemuan`;
  }

  const manual = {
    topic: unit.topik || '',
    subject: header.mapel || '',
    grade: toRoman(header.kelas),
    semester: semesterLabel(unit.semester),
    cp_phase: 'D',
    duration,
    meeting_number: meetingNumber,
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
  perMeetingFields.forEach(({ index, fieldMap }) => {
    const meeting = pertemuan[index] || {};
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
 * @param {number} [opts.meetingIndex]  0-based, absolute — when given, only
 *        THAT one meeting is rendered (V2a #4 single-meeting tab/export doc)
 *        with meeting-specific identity fields; omitted = full document
 *        (every meeting, unchanged from the original M2/M3 behavior).
 * @returns {Promise<{html: string, warnings: string[]}>}
 */
export async function renderRppHtml({ header, unit, content, menitPerJp, meetingIndex }) {
  const templateHtml = await fetchTemplateHtml();
  const doc = new DOMParser().parseFromString(templateHtml, 'text/html');
  const menit = Number(menitPerJp) > 0 ? Number(menitPerJp) : 40;

  const perMeetingFields = expandPertemuanRepeat(doc, unit, { meetingIndex });
  const expandedHtml = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;

  const values = buildFieldValues(header, unit, content, perMeetingFields, menit, meetingIndex);
  const { html, warnings } = substitute(expandedHtml, values);
  return { html, warnings };
}

/**
 * "Gabungkan semua → PDF" (V2a #4): every meeting rendered as its own
 * standalone renderRppHtml({meetingIndex}) page (own identity header —
 * Meeting Number/Time Allocation for THAT meeting), concatenated into ONE
 * HTML document with `page-break-after:always` between pages, ready for
 * export/pdf.js's existing print path. Reused as-is by both the RPP stage's
 * per-unit combine button and the Dokumen screen's per-RPP combine button —
 * single source of truth so the two never drift.
 * @returns {Promise<{html: string, warnings: string[]}>}
 */
export async function renderRppCombinedHtml({ header, unit, content, menitPerJp }) {
  const total = Math.max(1, Number(unit.pertemuanCount) || 1);
  const parser = new DOMParser();
  const warnings = [];
  let baseDoc = null;

  for (let i = 0; i < total; i++) {
    const result = await renderRppHtml({ header, unit, content, menitPerJp, meetingIndex: i });
    if (result.warnings && result.warnings.length) warnings.push(...result.warnings);
    const doc = parser.parseFromString(result.html, 'text/html');
    const page = doc.querySelector('.rpp-page');
    if (!page) continue;
    page.style.pageBreakAfter = i === total - 1 ? 'auto' : 'always';
    if (!baseDoc) {
      baseDoc = doc;
    } else {
      baseDoc.body.appendChild(baseDoc.adoptNode(page));
    }
  }

  if (!baseDoc) throw new Error('Tidak ada pertemuan untuk digabungkan.');
  return { html: '<!DOCTYPE html>\n' + baseDoc.documentElement.outerHTML, warnings };
}

export { toRoman, semesterLabel };
