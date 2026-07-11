// =============================================================
// Pemeran — spine state: load/create a plan, debounced autosave,
// and the stage machine that drives the wizard's progress rail.
// =============================================================

import { call } from './api.js';

export const STAGES = [
  { id: 'setup',  label: 'Data' },
  { id: 'cp',     label: 'CP' },
  { id: 'tp',     label: 'TP' },
  { id: 'kktp',   label: 'KKTP' },
  { id: 'atp',    label: 'ATP/Prota' },
  { id: 'prosem', label: 'Prosem' },
  { id: 'rpp',    label: 'RPP' },
  { id: 'ekspor', label: 'Ekspor' },
];
const STAGE_IDS = STAGES.map((s) => s.id);

export function stageIndex(id) {
  const i = STAGE_IDS.indexOf(id);
  return i < 0 ? 0 : i;
}
export function stageLabel(id) {
  const s = STAGES.find((x) => x.id === id);
  return s ? s.label : id;
}

const TEACHER_KEY = 'pemeran_teacher';
export function getTeacher() {
  try { return JSON.parse(sessionStorage.getItem(TEACHER_KEY) || 'null'); } catch (e) { return null; }
}
export function setTeacher(teacher) {
  try { sessionStorage.setItem(TEACHER_KEY, JSON.stringify(teacher)); } catch (e) { /* ignore */ }
}

export function defaultSpine() {
  return {
    header: {
      sekolah: '', mapel: '', fase: 'D', kelas: null, tahunAjaran: '',
      guru: '', nik: '', kepsek: '', kepsekNik: '', kota: 'Depok',
    },
    cp: { sumber: '', redaksi: 'nasional', elemen: [] },
    tps: [],
    kktps: [],
    units: [],
    sumatif: [],
    prosem: { mingguEfektif: { ganjil: 18, genap: 17 }, rows: [] },
    rpps: [],
    config: {
      jpPerMinggu: null, jpPerPertemuan: null, totalJpTahun: null, kktpThreshold: 78,
      // M3: 1 JP in minutes — SOP default is 40, but the school's filled RPPs
      // use 45'/JP in practice; KOSP can override, hence the editable Data field.
      menitPerJp: 40,
    },
  };
}

export const state = {
  planId: null,
  teacher: null,
  plan: null,          // full row once loaded/created
  spine: defaultSpine(),
  stage: 'setup',
  loading: true,
  saveStatus: 'idle',  // 'idle' | 'saving' | 'saved' | 'error'
  saveError: null,
  saveTimer: null,
};

const listeners = new Set();
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() {
  for (const fn of listeners) {
    try { fn(state); } catch (e) { /* a broken listener must not break autosave */ }
  }
}

export async function init() {
  const params = new URLSearchParams(location.search);
  const planId = params.get('plan');
  state.teacher = getTeacher();
  if (!state.teacher) {
    // sessionStorage doesn't cross tabs — fall back to the URL's teacher id
    // (e.g. a middle-clicked "Buat Perangkat Baru" link) so creating a plan
    // still works even without the name-grid's sessionStorage write.
    const teacherIdParam = params.get('teacher');
    if (teacherIdParam) state.teacher = { id: teacherIdParam, name: '' };
  }

  if (planId) {
    const r = await call('load_plan', { planId });
    applyPlanRow(r.plan);
  } else {
    state.planId = null;
    state.plan = null;
    state.spine = defaultSpine();
    state.stage = 'setup';
    if (state.teacher) state.spine.header.guru = state.teacher.name || '';
    try {
      const s = await call('get_settings', {});
      if (s.school) {
        state.spine.header.sekolah = s.school.nama || '';
        state.spine.header.kota = s.school.kota || 'Depok';
        state.spine.header.kepsek = s.school.kepsek || '';
        state.spine.header.kepsekNik = s.school.kepsekNik || '';
      }
      if (s.tahunAjaran) state.spine.header.tahunAjaran = s.tahunAjaran;
    } catch (e) {
      // get_settings already toasted; keep going with blank defaults.
    }
  }
  state.loading = false;
  emit();
  return state;
}

function applyPlanRow(plan) {
  state.planId = plan.id;
  state.plan = plan;
  const defaults = defaultSpine();
  const saved = plan.spine || {};
  // Object.assign is shallow — a saved spine.config from before M3 (missing
  // menitPerJp) would otherwise wholesale-replace defaults.config and lose
  // the new field's default. Merge config (and prosem, another nested
  // object with a new-ish sub-field) one level deeper so older plans still
  // pick up new defaults for fields they never had.
  state.spine = Object.assign(defaults, saved, {
    config: Object.assign({}, defaults.config, saved.config || {}),
    prosem: Object.assign({}, defaults.prosem, saved.prosem || {}, {
      mingguEfektif: Object.assign({}, defaults.prosem.mingguEfektif, (saved.prosem || {}).mingguEfektif || {}),
    }),
  });
  state.stage = plan.stage || 'setup';
}

function setSaveStatus(status, err) {
  state.saveStatus = status;
  state.saveError = status === 'error' ? (err || 'Gagal menyimpan.') : null;
  emit();
}

export function updateHeader(partial) {
  Object.assign(state.spine.header, partial);
  scheduleSave();
}
export function updateConfig(partial) {
  Object.assign(state.spine.config, partial);
  scheduleSave();
}

/** Replace the spine's rpps array wholesale (M2: ad-hoc topic-stub RPP
 *  entries; M3's pipeline.js will own richer per-unit bookkeeping). */
export function setRpps(rpps) {
  state.spine.rpps = Array.isArray(rpps) ? rpps : [];
  scheduleSave();
}

// ---- M3 additions: one setter per spine section, same shape as setRpps ----
export function updateCp(partial) {
  Object.assign(state.spine.cp, partial);
  scheduleSave();
}
export function setTps(tps) {
  state.spine.tps = Array.isArray(tps) ? tps : [];
  scheduleSave();
}
export function setKktps(kktps) {
  state.spine.kktps = Array.isArray(kktps) ? kktps : [];
  scheduleSave();
}
export function setUnits(units) {
  state.spine.units = Array.isArray(units) ? units : [];
  scheduleSave();
}
export function setSumatif(sumatif) {
  state.spine.sumatif = Array.isArray(sumatif) ? sumatif : [];
  scheduleSave();
}
export function setProsem(partial) {
  Object.assign(state.spine.prosem, partial);
  scheduleSave();
}

/** V2a #7 — generic setter used by the validator panel's "⚡ Perbaiki"
 *  buttons: a fix's apply(spine) returns a whole mutated-clone spine (it
 *  works on a deep clone, never the live state.spine, so it stays a pure
 *  function per validate.js's contract); this is what actually commits
 *  that result back into live state + schedules the save. Top-level
 *  Object.assign is safe here (unlike applyPlanRow's load-time merge)
 *  because the fix functions always return a full spine shape (every
 *  top-level key present, deep-cloned from the current state.spine). */
export function replaceSpine(newSpine) {
  if (newSpine && typeof newSpine === 'object') Object.assign(state.spine, newSpine);
  scheduleSave();
}

export function scheduleSave() {
  if (state.saveTimer) clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { flushSave().catch(() => {}); }, 2000);
}

/**
 * Persist the current spine/stage now. Creates the plan row first if this
 * is still a fresh draft (no planId yet) and the required Data fields are
 * present — otherwise it's a silent no-op (nothing worth saving yet).
 * `opts.snapshot` also writes a pemeran_revisions row (stage approval).
 * `opts.stage` overrides state.stage for this write (used by setStage()).
 */
export async function flushSave(opts) {
  opts = opts || {};
  if (state.saveTimer) { clearTimeout(state.saveTimer); state.saveTimer = null; }
  const nextStage = opts.stage || state.stage;

  if (!state.planId) {
    const h = state.spine.header;
    const canCreate = h.mapel && h.kelas && h.tahunAjaran && state.teacher && state.teacher.id;
    if (!canCreate) return false;
    setSaveStatus('saving');
    try {
      const r = await call('create_plan', {
        teacherId: state.teacher.id,
        mapel: h.mapel,
        kelas: h.kelas,
        tahunAjaran: h.tahunAjaran,
      });
      state.planId = r.plan.id;
      state.plan = r.plan;
      const url = new URL(location.href);
      url.searchParams.delete('new');
      url.searchParams.delete('teacher');
      url.searchParams.set('plan', state.planId);
      history.replaceState(null, '', url.toString());
    } catch (e) {
      setSaveStatus('error', e.message);
      return false;
    }
  }

  setSaveStatus('saving');
  try {
    const r = await call('save_plan', {
      planId: state.planId,
      spine: state.spine,
      stage: nextStage,
      snapshot: !!opts.snapshot,
    });
    state.plan = r.plan;
    state.stage = r.plan.stage || nextStage;
    setSaveStatus('saved');
    return true;
  } catch (e) {
    setSaveStatus('error', e.message);
    return false;
  }
}

/** Advance (or otherwise change) the stage, snapshotting a revision. */
export function setStage(stageId) {
  return flushSave({ stage: stageId, snapshot: true });
}
