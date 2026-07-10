// =============================================================
// Pemeran — one-shot owner mode ("⚡ Generate Semuanya")
// -------------------------------------------------------------
// Visible ONLY when the signed-in teacher has is_owner === true (the
// pemeran_teachers row carried through list_teachers -> setTeacher() ->
// sessionStorage, read back as state.teacher.is_owner — see state.js).
//
// Runs the whole chain — CP -> TP -> KKTP -> ATP -> Prosem (no AI) ->
// RPP per unit — SEQUENTIALLY, one request per stage/unit (never a
// single mega-request, which would blow the 60s serverless function
// limit per the plan). Each step mirrors exactly what the corresponding
// manual stage screen (stages/{cp,tp,kktp,atp,prosem,rpp}.js) does when
// the teacher clicks "Buatkan ... dengan AI", just headless — same
// pipeline.js functions, same callAi() actions, same state.js setters.
//
// Progress is surfaced via a simple full-screen overlay ("Membuat TP…
// 2/8"). Each completed stage is flushed to Supabase immediately
// (flushSave, not the debounced scheduleSave autosave) so a later
// failure never loses earlier progress — "keep what succeeded" per the
// plan. On the FIRST error anywhere in the chain, the run aborts
// cleanly and surfaces which stage failed; nothing after that stage
// runs. On full success, the app navigates to Ekspor with the
// validator panel showing.
//
// Design choice: re-running one-shot always regenerates CP-through-RPP
// fresh (no partial-resume bookkeeping) — simpler, and matches the
// plan's framing of this as an owner-only "viability testing" tool
// rather than a general resumable pipeline. CP is the one exception:
// if spine.cp.elemen is already populated (e.g. a national mapel's CP
// auto-loaded on an earlier visit to the CP stage, or a prior one-shot
// run), it's left as-is rather than re-fetched, since CP has no AI call
// to redo anyway.
// =============================================================

import {
  state, setStage, updateCp, setTps, setKktps, setUnits, setSumatif,
  setProsem, setRpps, flushSave,
} from './state.js';
import { toast } from './api.js';
import { callAi } from './aiApi.js';
import { assignTpCodes, assignKktpCodes, buildUnits, distributeProsem, splitMeetings } from './pipeline.js';

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

function flattenProsemRows(computed) {
  const rows = [];
  for (const sem of [1, 2]) {
    const data = sem === 1 ? computed.semester1 : computed.semester2;
    for (const row of data.rows) {
      for (const cell of row.cells) {
        rows.push({ semester: sem, bulan: cell.bulan, minggu: cell.minggu, materi: row.materi, jp: cell.jp, keterangan: '' });
      }
    }
  }
  return rows;
}

// ---- the six sequential steps ----------------------------------------------
async function stepCp() {
  const cp = state.spine.cp;
  if (Array.isArray(cp.elemen) && cp.elemen.length) return; // already populated — nothing to do
  const mapelRec = await findMapelRecord(state.spine.header.mapel);
  if (!mapelRec || !mapelRec.cpFile) {
    throw new Error('CP mata pelajaran ini belum tersedia (Muatan Lokal tanpa CP tersimpan) — isi CP secara manual di tahap CP dulu, baru jalankan mode satu-klik.');
  }
  const data = await loadJson('data/cp/' + mapelRec.cpFile);
  if (!data) throw new Error('Tidak bisa memuat data CP nasional (data/cp/' + mapelRec.cpFile + ').');
  updateCp({
    sumber: data.sumber || '',
    redaksi: data.redaksi || 'nasional',
    elemen: (data.elemen || []).map((e) => ({ nama: e.nama, teks: e.teks })),
  });
}

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

async function stepRppForUnit(atpUnit) {
  const config = state.spine.config;
  const tps = (state.spine.tps || []).filter((t) => atpUnit.tpKodes.includes(t.kode));
  const kktps = (state.spine.kktps || []).filter((k) => atpUnit.tpKodes.includes(k.tpKode));
  const cpElemenNames = [...new Set(tps.map((t) => t.elemen))];
  const cpElemen = cpElemenNames
    .map((n) => (state.spine.cp.elemen.find((e) => e.nama === n) || {}).teks)
    .filter(Boolean)
    .join('\n\n');
  const { pertemuanCount } = splitMeetings(atpUnit, config);

  const unit = {
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

  const r = await callAi('generate_rpp', {
    planId: state.planId,
    unit: {
      topik: unit.topik, mapel: state.spine.header.mapel, kelas: state.spine.header.kelas,
      semester: unit.semester, jp: unit.jp, jpPerPertemuan: unit.jpPerPertemuan,
      pertemuanCount: unit.pertemuanCount, cpElemen: unit.cpElemen, tpList: unit.tpList, kktpList: unit.kktpList,
    },
  });
  if (r.pertemuanCount) unit.pertemuanCount = r.pertemuanCount;

  const existing = Array.isArray(state.spine.rpps) ? state.spine.rpps.slice() : [];
  const existingIdx = existing.findIndex((e) => e.unit && e.unit.unitId === unit.unitId);
  const entry = {
    id: existingIdx >= 0 ? existing[existingIdx].id : 'rpp_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    unit,
    content: r.data,
  };
  if (existingIdx >= 0) existing[existingIdx] = entry; else existing.push(entry);
  setRpps(existing);
}

/**
 * Run the full chain. `onProgress({ label, index, total })` is called
 * before each step starts — `total` is null until the ATP step resolves
 * (unit count, hence RPP step count, is unknown before then).
 * Throws on the first failure (message identifies which stage failed);
 * whatever succeeded before that point has already been flushed to
 * Supabase (kept, per the plan).
 */
export async function runOneshot(onProgress) {
  const report = (label, index, total) => { if (onProgress) onProgress({ label, index, total }); };
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
    report('Membuat RPP: ' + unit.nama + '…', ++i, total);
    await stepRppForUnit(unit);
    await flushSave(); // persist each RPP immediately — a later unit's failure must not lose this one
  }

  await setStage('ekspor');
  return { ok: true, unitCount: units.length };
}

// =============================================================
// UI — a small card (Data screen) with the button + a full-screen
// progress overlay. Exported so stages/setup.js can mount it; renders
// nothing at all when the signed-in teacher isn't the owner.
// =============================================================
function overlayHtml() {
  return `
    <div id="oneshot-overlay" style="position:fixed; inset:0; z-index:2000; background:rgba(43,36,32,0.55); display:flex; align-items:center; justify-content:center; padding:24px;">
      <div class="card card-pad-lg" style="max-width:420px; width:100%; text-align:center;">
        <div style="font-size:2rem; margin-bottom:8px;">⚡</div>
        <h3 id="oneshot-label" style="margin:0 0 8px;">Memulai…</h3>
        <p class="muted small" id="oneshot-sub"></p>
      </div>
    </div>
  `;
}

export function mountOneshotButton(container) {
  if (!isOwner()) return;

  const host = document.createElement('div');
  host.className = 'card card-pad-lg';
  host.innerHTML = `
    <div class="row-between">
      <div>
        <h3 style="margin:0 0 4px;">Mode Satu-Klik (khusus pemilik)</h3>
        <p class="muted small" style="margin:0;">Menjalankan CP → TP → KKTP → ATP → Prosem → RPP tiap unit secara berurutan (satu permintaan per tahap) untuk uji kelayakan cepat. Data yang sudah ada di tahap-tahap ini akan ditimpa.</p>
      </div>
      <button class="btn btn-primary" id="btn-oneshot">⚡ Generate Semuanya</button>
    </div>
  `;
  container.appendChild(host);

  host.querySelector('#btn-oneshot').addEventListener('click', async () => {
    if (!state.spine.header.mapel || !state.spine.header.kelas || !state.spine.header.tahunAjaran) {
      toast('Lengkapi Mata Pelajaran, Kelas, dan Tahun Ajaran dulu di tahap Data.', { error: true });
      return;
    }
    // Oneshot needs a real plan row to attach generations/snapshots to —
    // save once up front (same guard flushSave() already applies).
    const saved = await flushSave();
    if (!saved && !state.planId) {
      toast('Tidak bisa menyimpan draf awal — sesi guru tidak ditemukan.', { error: true });
      return;
    }

    const overlay = document.createElement('div');
    overlay.innerHTML = overlayHtml();
    document.body.appendChild(overlay);
    const labelEl = overlay.querySelector('#oneshot-label');
    const subEl = overlay.querySelector('#oneshot-sub');

    try {
      await runOneshot(({ label, index, total }) => {
        labelEl.textContent = label;
        subEl.textContent = total ? `Langkah ${index} dari ${total}` : `Langkah ${index}`;
      });
      overlay.remove();
      toast('Selesai — seluruh perangkat berhasil dibuat.');
      location.hash = '#/ekspor';
    } catch (e) {
      overlay.remove();
      toast('Mode satu-klik berhenti: ' + String((e && e.message) || e) + ' (langkah sebelumnya yang sudah berhasil tetap tersimpan.)', { error: true });
    }
  });
}
