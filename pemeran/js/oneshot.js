// =============================================================
// Pemeran — one-click chains: "⚡ Kerangka Instan" (everyone, no AI)
// and "✨ Generate Semuanya dengan AI" (owner only)
// -------------------------------------------------------------
// Two sequential chains, both CP -> TP -> KKTP -> ATP -> Prosem -> RPP,
// sharing the same zero-AI steps (CP load, Prosem) and the same unit-shape
// helpers, differing only in how TP/KKTP/ATP/RPP content is produced:
//
//   runKerangkaInstan — V2a #9: 100% client-side, no network AI call at
//   all. Uses pipeline.js's rule-based draft* builders (draftTpFromCp,
//   draftKktp, draftUnits, draftRppSkeleton) so EVERY teacher (not just
//   the owner) can see a fully-shaped document set in under 3 seconds,
//   for free, before ever touching the AI. RPP content lands as
//   pipeline.RPP_PLACEHOLDER text ("klik untuk mengisi, atau 🔄 untuk
//   membuat dengan AI") — fill by hand or regenerate per-field/per-meeting
//   from the RPP stage afterwards.
//
//   runOneshot — the pre-existing owner-only "viability testing" chain:
//   one request per stage/unit (never a single mega-request, which would
//   blow the 60s serverless function limit), now using rppGen.js's shared
//   generateRppContentForUnit for its RPP step (one generate_rpp_base call
//   + one generate_rpp_meeting call per meeting, each retried once) — the
//   SAME per-meeting orchestration stages/rpp.js's manual "Buat dengan AI"
//   button drives, so the two entry points can't drift on retry/resume
//   semantics.
//
// Progress is surfaced via a simple full-screen overlay ("Membuat TP…
// 2/8"). Each completed step is flushed to Supabase immediately
// (flushSave, not the debounced scheduleSave autosave) so a later
// failure never loses earlier progress — "keep what succeeded" per the
// plan. On the FIRST error anywhere in the chain, the run aborts cleanly
// and surfaces which step failed; nothing after that step runs. On full
// success, the app navigates to Ekspor with the validator panel showing.
//
// Design choice: re-running either chain always regenerates CP-through-RPP
// fresh (no partial-resume bookkeeping across STAGES) — simpler, and
// matches the plan's framing of these as fast whole-device rebuilds rather
// than a general resumable pipeline (per-meeting RPP resume WITHIN one RPP
// generation run is handled by rppGen.js/stages/rpp.js, a different,
// finer-grained concern). CP is the one exception: if spine.cp.elemen is
// already populated (e.g. a national mapel's CP auto-loaded on an earlier
// visit to the CP stage, or a prior run), it's left as-is rather than
// re-fetched, since CP has no AI/draft step to redo anyway.
// =============================================================

import {
  state, setStage, updateCp, setTps, setKktps, setUnits, setSumatif,
  setProsem, setRpps, flushSave,
} from './state.js';
import { toast } from './api.js';
import { callAi } from './aiApi.js';
import {
  assignTpCodes, assignKktpCodes, buildUnits, distributeProsem, splitMeetings,
  flattenProsemRows, draftTpFromCp, draftKktp, draftUnits, draftRppSkeleton,
} from './pipeline.js';
import { generateRppContentForUnit } from './rppGen.js';

const SUMATIF_DEFAULT_FALLBACK = [
  { jenis: 'STS1', jp: 2, semester: 1 },
  { jenis: 'SAS', jp: 2, semester: 1 },
  { jenis: 'STS2', jp: 2, semester: 2 },
  { jenis: 'SAT', jp: 2, semester: 2 },
];

export function isOwner() {
  return !!(state.teacher && state.teacher.is_owner);
}

// ---- data helpers (small, self-contained duplicates of what
// stages/{cp,atp,prosem}.js do inline — kept local so oneshot.js has no
// dependency on any stage module's internals) --------------------------------
async function loadJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function findMapelRecord(mapelName) {
  if (!mapelName) return null;
  const json = await loadJson('data/mapel.json');
  if (!json) return null;
  const list = Array.isArray(json) ? json : (json.mapel || []);
  return list.find((m) => (m.nama || m.mapel) === mapelName) || null;
}

// ---- shared unit-shape helper (both chains' RPP step build the same
// {topik, jp, jpPerPertemuan, pertemuanCount, semester, cpElemen, tpList,
// kktpList} shape from a spine.units entry — kept in one place so they
// can't drift) ----------------------------------------------------------------
function buildRppUnitShape(atpUnit, config) {
  const tps = (state.spine.tps || []).filter((t) => atpUnit.tpKodes.includes(t.kode));
  const kktps = (state.spine.kktps || []).filter((k) => atpUnit.tpKodes.includes(k.tpKode));
  const cpElemenNames = [...new Set(tps.map((t) => t.elemen))];
  const cpElemen = cpElemenNames
    .map((n) => (state.spine.cp.elemen.find((e) => e.nama === n) || {}).teks)
    .filter(Boolean)
    .join('\n\n');
  const { pertemuanCount } = splitMeetings(atpUnit, config);

  return {
    unitId: atpUnit.id,
    topik: atpUnit.nama,
    jp: atpUnit.jp,
    jpPerPertemuan: Number(config.jpPerPertemuan) || 2,
    pertemuanCount,
    semester: atpUnit.semester,
    cpElemen,
    tpList: tps.map((t) => ({ kode: t.kode, rumusan: t.rumusan })),
    kktpList: kktps.map((k) => ({ kode: k.kode, kriteria: k.kriteria })),
  };
}

/** Insert-or-replace-by-unitId into spine.rpps, returning the entry. */
function upsertRppEntry(unit, content) {
  const existing = Array.isArray(state.spine.rpps) ? state.spine.rpps.slice() : [];
  const idx = existing.findIndex((e) => e.unit && e.unit.unitId === unit.unitId);
  const entry = {
    id: idx >= 0 ? existing[idx].id : 'rpp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    unit,
    content,
  };
  if (idx >= 0) existing[idx] = entry; else existing.push(entry);
  setRpps(existing);
  return entry;
}

// ---- steps shared by BOTH chains -------------------------------------------
async function stepCp() {
  const cp = state.spine.cp;
  if (Array.isArray(cp.elemen) && cp.elemen.length) return; // already populated — nothing to do
  const mapelRec = await findMapelRecord(state.spine.header.mapel);
  if (!mapelRec || !mapelRec.cpFile) {
    throw new Error('CP mata pelajaran ini belum tersedia (Muatan Lokal tanpa CP tersimpan) — isi CP secara manual di tahap CP dulu, baru jalankan mode ini.');
  }
  const data = await loadJson('data/cp/' + mapelRec.cpFile);
  if (!data) throw new Error('Tidak bisa memuat data CP nasional (data/cp/' + mapelRec.cpFile + ').');
  updateCp({
    sumber: data.sumber || '',
    redaksi: data.redaksi || 'nasional',
    elemen: (data.elemen || []).map((e) => ({ nama: e.nama, teks: e.teks })),
  });
}

async function stepProsem(units) {
  const { sumatif, config, header } = state.spine;
  if (!state.spine.prosem.rows.length) {
    const k = await loadJson('data/konstanta.json');
    const d = (k && k.mingguEfektifDefault) || {};
    setProsem({ mingguEfektif: { ganjil: d.ganjil ?? 18, genap: Number(header.kelas) === 9 ? (d.genapKelas9 ?? 14) : (d.genap ?? 17) } });
  }
  const computed = distributeProsem(units, sumatif, state.spine.config, header.kelas);
  setProsem({ rows: flattenProsemRows(computed) });
}

// ---- AI chain's steps (runOneshot) -----------------------------------------
async function stepTp() {
  const cp = state.spine.cp;
  if (!cp.elemen.length) throw new Error('CP kosong — tidak bisa membuat TP.');
  const kelas = state.spine.header.kelas;
  const r = await callAi('generate_tp', { planId: state.planId, cp: { elemen: cp.elemen }, kelas, mapel: state.spine.header.mapel });
  const perElemenTps = (r.perElemen || []).map((e) => e.tps);
  const { tps, warnings } = assignTpCodes(cp.elemen, perElemenTps, kelas);
  if (!tps.length) throw new Error('AI tidak menghasilkan TP apa pun.');
  setTps(tps);
  if (warnings.length) toast(warnings[0], { error: true });
  return tps;
}

async function stepKktp(tps) {
  const r = await callAi('generate_kktp', { planId: state.planId, tps });
  const { kktps, warnings } = assignKktpCodes(tps, r.items, undefined, state.spine.config.kktpThreshold);
  setKktps(kktps);
  if (warnings.length) toast(warnings[0], { error: true });
  return kktps;
}

async function stepAtp(tps) {
  const config = state.spine.config;
  const mapel = state.spine.header.mapel;
  const kelas = state.spine.header.kelas;
  const nUnitsHint = Math.max(1, Math.round(tps.length / 4));

  let sumatif = Array.isArray(state.spine.sumatif) && state.spine.sumatif.length
    ? state.spine.sumatif.map((s) => ({ ...s }))
    : null;
  if (!sumatif) {
    const k = await loadJson('data/konstanta.json');
    sumatif = (k && Array.isArray(k.sumatifDefault) ? k.sumatifDefault : SUMATIF_DEFAULT_FALLBACK).map((s) => ({ ...s }));
    setSumatif(sumatif);
  }

  let r = await callAi('generate_atp', { planId: state.planId, tps, nUnitsHint, mapel, kelas });
  let attempt = buildUnits(r.units, tps, config, sumatif);
  if (attempt.errors.length) {
    // Plan: "reject+retry once, else surface" — same as stages/atp.js.
    r = await callAi('generate_atp', { planId: state.planId, tps, nUnitsHint, mapel, kelas, retryFeedback: attempt.errors.join('; ') });
    attempt = buildUnits(r.units, tps, config, sumatif);
  }
  if (attempt.errors.length) throw new Error('ATP tidak valid setelah 2 percobaan: ' + attempt.errors[0]);
  setUnits(attempt.units);
  return attempt.units;
}

/** One unit's RPP, via rppGen.js's shared per-meeting orchestration (one
 *  generate_rpp_base call + one generate_rpp_meeting call per meeting).
 *  `onSub(detail)` reports meeting-level progress WITHIN this one unit's
 *  step, without moving the outer step counter. */
async function stepRppForUnit(atpUnit, onSub) {
  const config = state.spine.config;
  const unit = buildRppUnitShape(atpUnit, config);
  const skeleton = draftRppSkeleton(unit, config); // zero-AI starting shape (valid pertemuan[] etc.), then AI fills it in below
  unit.pertemuanCount = skeleton.pertemuanCount;
  const content = skeleton.content;

  await generateRppContentForUnit({
    unit,
    content,
    header: state.spine.header,
    planId: state.planId,
    config,
    onProgress: (info) => { if (onSub) onSub(`${info.label} (${info.step}/${info.total})`); },
    onStepDone: async () => { upsertRppEntry(unit, content); },
  });

  upsertRppEntry(unit, content);
}

/**
 * Run the full AI chain. `onProgress({ label, index, total, detail })` is
 * called before each step starts (and, during the per-unit RPP steps,
 * again with a `detail` string as each meeting completes) — `total` is
 * null until the ATP step resolves (unit count, hence RPP step count, is
 * unknown before then). Throws on the first failure (message identifies
 * which stage failed); whatever succeeded before that point has already
 * been flushed to Supabase (kept, per the plan).
 */
export async function runOneshot(onProgress) {
  const report = (label, index, total, detail) => { if (onProgress) onProgress({ label, index, total, detail }); };
  const FIXED_STAGES = 5; // CP, TP, KKTP, ATP, Prosem
  let i = 0;

  report('Menyiapkan CP…', ++i, null);
  await stepCp();
  await setStage('tp');

  report('Membuat TP dengan AI…', ++i, null);
  const tps = await stepTp();
  await setStage('kktp');

  report('Membuat KKTP dengan AI…', ++i, null);
  await stepKktp(tps);
  await setStage('atp');

  report('Membuat ATP dengan AI…', ++i, null);
  const units = await stepAtp(tps);
  const total = FIXED_STAGES + units.length;
  await setStage('prosem');

  report('Menyusun Prosem…', ++i, total);
  await stepProsem(units);
  await setStage('rpp');

  for (const unit of units) {
    const stepIndex = ++i;
    report('Membuat RPP: ' + unit.nama + '…', stepIndex, total);
    await stepRppForUnit(unit, (detail) => report('Membuat RPP: ' + unit.nama + '…', stepIndex, total, detail));
    await flushSave(); // persist each RPP immediately — a later unit's failure must not lose this one
  }

  await setStage('ekspor');
  return { ok: true, unitCount: units.length };
}

// ---- V2a #9 — zero-AI chain's steps (runKerangkaInstan), everyone -----------
function stepTpDraft() {
  const cp = state.spine.cp;
  if (!cp.elemen.length) throw new Error('CP kosong — tidak bisa menyusun TP.');
  const kelas = state.spine.header.kelas;
  const { tps, warnings } = draftTpFromCp(cp.elemen, kelas);
  if (!tps.length) throw new Error('Draf TP tidak menghasilkan TP apa pun — lengkapi CP secara manual dulu.');
  setTps(tps);
  if (warnings.length) toast(warnings[0], { error: true });
  return tps;
}

function stepKktpDraft(tps, konstanta) {
  const k = konstanta || {};
  const { kktps, warnings } = draftKktp(tps, { intervalDefault: k.intervalDefault, kktpThreshold: state.spine.config.kktpThreshold });
  setKktps(kktps);
  if (warnings.length) toast(warnings[0], { error: true });
  return kktps;
}

function stepAtpDraft(tps, konstanta) {
  const config = state.spine.config;
  let sumatif = Array.isArray(state.spine.sumatif) && state.spine.sumatif.length
    ? state.spine.sumatif.map((s) => ({ ...s }))
    : null;
  if (!sumatif) {
    sumatif = (konstanta && Array.isArray(konstanta.sumatifDefault) ? konstanta.sumatifDefault : SUMATIF_DEFAULT_FALLBACK).map((s) => ({ ...s }));
    setSumatif(sumatif);
  }
  const aiUnits = draftUnits(tps, config);
  const { units, errors } = buildUnits(aiUnits, tps, config, sumatif);
  if (errors.length) throw new Error('Kerangka ATP tidak valid: ' + errors[0]);
  setUnits(units);
  return units;
}

/** One unit's RPP skeleton — zero-AI, instant (draftRppSkeleton only). */
function stepRppSkeletonForUnit(atpUnit) {
  const config = state.spine.config;
  const unit = buildRppUnitShape(atpUnit, config);
  const skeleton = draftRppSkeleton(unit, config);
  unit.pertemuanCount = skeleton.pertemuanCount;
  upsertRppEntry(unit, skeleton.content);
}

/**
 * Run the full zero-AI "Kerangka Instan" chain — same shape/progress
 * contract as runOneshot() above, but every step is synchronous rule-based
 * logic (pipeline.js's draft* builders) with no network AI call, so the
 * whole chain typically finishes in well under 3 seconds.
 */
export async function runKerangkaInstan(onProgress) {
  const report = (label, index, total) => { if (onProgress) onProgress({ label, index, total }); };
  const FIXED_STAGES = 5; // CP, TP, KKTP, ATP, Prosem
  let i = 0;

  report('Memuat CP…', ++i, null);
  await stepCp();
  await setStage('tp');

  report('Menyusun TP dari CP…', ++i, null);
  const tps = stepTpDraft();
  await setStage('kktp');

  const konstanta = await loadJson('data/konstanta.json');

  report('Menyusun KKTP…', ++i, null);
  stepKktpDraft(tps, konstanta);
  await setStage('atp');

  report('Menyusun ATP…', ++i, null);
  const units = stepAtpDraft(tps, konstanta);
  const total = FIXED_STAGES + units.length;
  await setStage('prosem');

  report('Menyusun Prosem…', ++i, total);
  await stepProsem(units);
  await setStage('rpp');

  for (const unit of units) {
    report('Menyusun kerangka RPP: ' + unit.nama + '…', ++i, total);
    stepRppSkeletonForUnit(unit);
  }
  await flushSave();

  await setStage('ekspor');
  return { ok: true, unitCount: units.length };
}

// =============================================================
// UI — a card (Data screen) with both chains' buttons + a full-screen
// progress overlay. "Kerangka Instan" is shown to EVERY teacher; "Generate
// Semuanya dengan AI" only when the signed-in teacher is the owner.
// =============================================================
function overlayHtml(icon) {
  return `
    <div id="oneshot-overlay" style="position:fixed; inset:0; z-index:2000; background:rgba(43,36,32,0.55); display:flex; align-items:center; justify-content:center; padding:24px;">
      <div class="card card-pad-lg" style="max-width:420px; width:100%; text-align:center;">
        <div style="font-size:2rem; margin-bottom:8px;">${icon || '⚡'}</div>
        <h3 id="oneshot-label" style="margin:0 0 8px;">Memulai…</h3>
        <p class="muted small" id="oneshot-sub"></p>
      </div>
    </div>
  `;
}

async function runChainWithOverlay({ icon, runner, label, successMsg }) {
  if (!state.spine.header.mapel || !state.spine.header.kelas || !state.spine.header.tahunAjaran) {
    toast('Lengkapi Mata Pelajaran, Kelas, dan Tahun Ajaran dulu di tahap Data.', { error: true });
    return;
  }
  // Both chains need a real plan row to attach generations/snapshots/RPPs
  // to — save once up front.
  const saved = await flushSave();
  if (!saved && !state.planId) {
    toast('Tidak bisa menyimpan draf awal — sesi guru tidak ditemukan.', { error: true });
    return;
  }

  const overlay = document.createElement('div');
  overlay.innerHTML = overlayHtml(icon);
  document.body.appendChild(overlay);
  const labelEl = overlay.querySelector('#oneshot-label');
  const subEl = overlay.querySelector('#oneshot-sub');

  try {
    await runner(({ label: stepLabel, index, total, detail }) => {
      labelEl.textContent = stepLabel;
      subEl.textContent = (total ? `Langkah ${index} dari ${total}` : `Langkah ${index}`) + (detail ? ' — ' + detail : '');
    });
    overlay.remove();
    toast(successMsg);
    location.hash = '#/ekspor';
  } catch (e) {
    overlay.remove();
    toast(label + ' berhenti: ' + String((e && e.message) || e) + ' (langkah sebelumnya yang sudah berhasil tetap tersimpan.)', { error: true });
  }
}

export function mountOneshotButton(container) {
  const owner = isOwner();

  const host = document.createElement('div');
  host.className = 'card card-pad-lg';
  host.innerHTML = `
    <div class="stack">
      <div class="row-between">
        <div>
          <h3 style="margin:0 0 4px;">⚡ Kerangka Instan (tanpa AI)</h3>
          <p class="muted small" style="margin:0;">Menyusun TP → KKTP → ATP → Prosem → kerangka RPP tiap unit secara instan dari CP — tanpa AI, tanpa internet, dalam hitungan detik. Isi kontennya nanti secara manual atau dengan AI per bagian. Data yang sudah ada di tahap-tahap ini akan ditimpa.</p>
        </div>
        <button class="btn btn-primary" id="btn-kerangka-instan">⚡ Kerangka Instan (tanpa AI)</button>
      </div>
      ${owner ? `
      <div class="row-between" style="border-top:1px solid var(--line); padding-top:var(--space-3); margin-top:var(--space-1);">
        <div>
          <h3 style="margin:0 0 4px;">✨ Generate Semuanya dengan AI (khusus pemilik)</h3>
          <p class="muted small" style="margin:0;">Menjalankan CP → TP → KKTP → ATP → Prosem → RPP (tiap unit, tiap pertemuan) dengan AI secara berurutan untuk uji kelayakan cepat. Data yang sudah ada di tahap-tahap ini akan ditimpa.</p>
        </div>
        <button class="btn btn-outline" id="btn-oneshot">✨ Generate Semuanya dengan AI</button>
      </div>
      ` : ''}
    </div>
  `;
  container.appendChild(host);

  host.querySelector('#btn-kerangka-instan').addEventListener('click', () => runChainWithOverlay({
    icon: '⚡',
    runner: runKerangkaInstan,
    label: 'Kerangka Instan',
    successMsg: 'Selesai — kerangka lengkap berhasil disusun (tanpa AI).',
  }));

  if (owner) {
    host.querySelector('#btn-oneshot').addEventListener('click', () => runChainWithOverlay({
      icon: '✨',
      runner: runOneshot,
      label: 'Generate Semuanya dengan AI',
      successMsg: 'Selesai — seluruh perangkat berhasil dibuat dengan AI.',
    }));
  }
}
