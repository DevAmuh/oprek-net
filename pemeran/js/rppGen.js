// =============================================================
// Pemeran — shared RPP AI-generation core (V2a #3)
// -------------------------------------------------------------
// UI-agnostic per-meeting orchestration: one generate_rpp_base call (only
// when the unit-level fields still look blank/placeholder) + one
// generate_rpp_meeting call per meeting still needing content, each
// retried once (silently on the first attempt, so a transient hiccup
// doesn't toast twice before the real, final-failure message). Used by
// BOTH stages/rpp.js (per-meeting tabs, progress banner, cancel/resume UI)
// and oneshot.js (the owner-only full-AI chain's per-unit RPP step) so the
// two entry points can never drift on retry/resume semantics — this is
// the file pipeline.js's own comments already anticipated ("see
// js/rppGen.js's 'already generated' check") but that a previous pass
// never got around to creating.
//
// No DOM, no spine/state.js coupling — callers own persistence (via
// onStepDone) and progress UI (via onProgress); this file only knows how
// to talk to /api/pemeran-ai and fill a content object.
// =============================================================

import { callAi } from './aiApi.js';
import { splitMeetings, chunkList, RPP_PLACEHOLDER } from './pipeline.js';

// Unit-level fields a fresh draftRppSkeleton()/AI base call fills — used to
// detect "still needs (re)generation" for the resume flow. Excludes the two
// array fields (graduate_profile_selected/santri_kitab_selected) since 0
// selections is a legitimate real answer, not a sign of missing content.
const BASE_FIELDS = [
  'peserta_didik', 'materi_pelajaran', 'internalisasi_nilai_agama',
  'capaian_element', 'capaian_competence', 'capaian_content', 'lintas_disiplin_ilmu',
  'model', 'strategy', 'method', 'kemitraan', 'lingkungan', 'digital',
  'asesmen_awal', 'asesmen_proses', 'asesmen_akhir', 'learning_media',
];
const MEETING_FIELDS = ['opening', 'memahami', 'mengaplikasi', 'merefleksi', 'closing'];

export const GENERATION_CANCELLED = '__pemeran_rpp_gen_cancelled__';

export function isBlankOrPlaceholder(v) {
  return !v || !String(v).trim() || v === RPP_PLACEHOLDER;
}

export function meetingNeedsFill(m) {
  if (!m) return true;
  return MEETING_FIELDS.some((f) => isBlankOrPlaceholder(m[f]));
}

/**
 * Null when `content` is fully AI-generated for `unit`; otherwise where to
 * resume from — { firstMissing, baseNeeds, total }. Shared by stages/rpp.js
 * (the "Lanjutkan dari Pertemuan N" banner) and available to any other
 * caller that needs to know "is this RPP entry actually done".
 */
export function findResumeState(unit, content) {
  const total = (unit && unit.pertemuanCount) || 1;
  const pertemuan = (content && content.pertemuan) || [];
  let firstMissing = -1;
  for (let i = 0; i < total; i++) {
    if (meetingNeedsFill(pertemuan[i])) { firstMissing = i; break; }
  }
  const baseNeeds = BASE_FIELDS.some((f) => isBlankOrPlaceholder(content && content[f]));
  if (firstMissing === -1 && !baseNeeds) return null;
  return { firstMissing, baseNeeds, total };
}

function unitForRequest(unit, header) {
  return {
    topik: unit.topik,
    mapel: header && header.mapel,
    kelas: header && header.kelas,
    semester: unit.semester,
    jp: unit.jp,
    jpPerPertemuan: unit.jpPerPertemuan,
    pertemuanCount: unit.pertemuanCount,
    cpElemen: unit.cpElemen,
    tpList: unit.tpList,
    kktpList: unit.kktpList,
  };
}

async function callAiRetryOnce(action, payload) {
  try {
    return await callAi(action, payload, { silent: true });
  } catch (e1) {
    try {
      return await callAi(action, payload); // second attempt — toasts on failure
    } catch (e2) {
      return null;
    }
  }
}

/**
 * Fill `content` (mutated in place) with AI-generated RPP content for
 * `unit`, via one generate_rpp_base call + one generate_rpp_meeting call
 * per meeting. Throws (message describing which step failed, or
 * GENERATION_CANCELLED) on the first unrecoverable failure/cancellation —
 * whatever was already assigned to `content` before that point stays, and
 * `onStepDone` will already have been called for it, so the caller's own
 * persistence isn't lost.
 *
 * @param {object} params
 * @param {object} params.unit     {topik, jp, jpPerPertemuan, pertemuanCount, semester, cpElemen, tpList, kktpList}
 * @param {object} params.content  mutated in place — `content.pertemuan` is
 *        padded/truncated to unit.pertemuanCount here if needed.
 * @param {object} params.header   spine.header (only .mapel/.kelas read)
 * @param {string} params.planId
 * @param {object} [params.config]  spine.config (only .menitPerJp read — the
 *        per-meeting jp/JP-count math uses unit.jpPerPertemuan, same as
 *        render/rpp.js's single-meeting identity fields, so the numbers the
 *        AI is told never disagree with what's shown on-page)
 * @param {boolean} [params.resume]  only (re)generate fields that still look
 *        blank/placeholder (per findResumeState) instead of unconditionally
 *        regenerating everything from scratch.
 * @param {(info:{label:string, step:number, total:number}) => void} [params.onProgress]
 * @param {(info:{type:'base'|'meeting', index?:number}) => (void|Promise<void>)} [params.onStepDone]
 *        called right after each successful step is assigned into
 *        `content` — the hook callers use to persist incrementally.
 * @param {() => boolean} [params.isCancelled]  polled between calls.
 * @returns {Promise<object>} the same `content` object, for convenience.
 */
export async function generateRppContentForUnit({
  unit, content, header, planId, config, resume, onProgress, onStepDone, isCancelled,
}) {
  const total = (unit && unit.pertemuanCount) || 1;
  content.pertemuan = Array.isArray(content.pertemuan) ? content.pertemuan.slice() : [];
  while (content.pertemuan.length < total) content.pertemuan.push(null);
  if (content.pertemuan.length > total) content.pertemuan.length = total;

  const tpChunks = chunkList(unit.tpList || [], total);
  const { meetings } = splitMeetings(
    { jp: unit.jp },
    { jpPerPertemuan: unit.jpPerPertemuan, menitPerJp: config && config.menitPerJp },
  );

  const baseNeedsFill = !resume || BASE_FIELDS.some((f) => isBlankOrPlaceholder(content[f]));
  const meetingIndices = [];
  for (let i = 0; i < total; i++) {
    if (resume && !meetingNeedsFill(content.pertemuan[i])) continue;
    meetingIndices.push(i);
  }

  const totalSteps = (baseNeedsFill ? 1 : 0) + meetingIndices.length;
  let step = 0;
  const report = (label) => { if (onProgress) onProgress({ label, step, total: totalSteps }); };
  const checkCancelled = () => { if (isCancelled && isCancelled()) throw new Error(GENERATION_CANCELLED); };

  report('Menyiapkan…');

  if (baseNeedsFill) {
    checkCancelled();
    report('Membuat bagian identitas unit…');
    const r = await callAiRetryOnce('generate_rpp_base', { planId, unit: unitForRequest(unit, header) });
    checkCancelled();
    if (!r) throw new Error('Gagal membuat bagian identitas unit setelah dicoba ulang.');
    Object.assign(content, r.data);
    step += 1;
    if (onStepDone) await onStepDone({ type: 'base' });
  }

  for (const i of meetingIndices) {
    checkCancelled();
    report(`Membuat Pertemuan ${i + 1}/${total}…`);
    const meetingInfo = meetings[i] || {};
    const r = await callAiRetryOnce('generate_rpp_meeting', {
      planId,
      unit: unitForRequest(unit, header),
      meetingIndex: i,
      tpChunk: (tpChunks[i] || []).map((t) => ({ kode: t.kode, rumusan: t.rumusan })),
      jp: meetingInfo.jp,
      menit: meetingInfo.menit && meetingInfo.menit.total,
    });
    checkCancelled();
    if (!r) throw new Error(`Gagal membuat Pertemuan ${i + 1} setelah dicoba ulang.`);
    content.pertemuan[i] = r.data;
    step += 1;
    if (onStepDone) await onStepDone({ type: 'meeting', index: i });
  }

  return content;
}
