// =============================================================
// Pemeran — deterministic pipeline (M3)
// -------------------------------------------------------------
// Pure functions only (no fetch, no DOM, no state.js import) so this
// file is unit-testable with plain `node pipeline.test.js` and
// side-effect-free everywhere else it's imported from (stage screens,
// validate.js, render/*.js). AI (Haiku) fills content slots; this
// file owns codes, JP math, aggregation, ordering — the SOP's §11
// consistency matrix holds "by construction" per the plan.
//
// Fallback constants below (BLOOM_LEVELS, MINGGU_EFEKTIF_DEFAULT) are
// kept in sync with pemeran/data/konstanta.json — same duplication
// pattern already used by api/pemeran-ai.js (DIMENSI_PROFIL_LULUSAN),
// since this file must stay fetch-free to run under plain `node`.
// =============================================================

const BLOOM_LEVELS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];

const MINGGU_EFEKTIF_DEFAULT = { ganjil: 18, genap: 17, genapKelas9: 14 };

const BULAN_SEMESTER = {
  1: ['Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'],
  2: ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni'],
};

// ---- small pure helpers -----------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Prefix "Peserta didik dapat " onto a TP rumusan unless it's already there
 *  (case-insensitive), per SOP §5.2's required sentence pattern. */
export function ensurePesertaDidikDapat(text) {
  const s = String(text || '').trim();
  if (!s) return 'Peserta didik dapat …';
  if (/^peserta didik dapat\b/i.test(s)) return s;
  const first = s.charAt(0).toLowerCase() + s.slice(1);
  return `Peserta didik dapat ${first}`;
}

export function clampBloom(level) {
  const s = String(level || '').trim().toUpperCase();
  return BLOOM_LEVELS.includes(s) ? s : null;
}

// =============================================================
// TP — assign codes: D.<kelas>.<noCP>.<noTP>
// =============================================================

/**
 * @param {Array<{nama:string, teks:string}>} cpElemen  spine.cp.elemen, in order
 * @param {Array<Array<{rumusan:string, bloom?:string}>>} aiTpsPerElemen  parallel
 *        to cpElemen — the AI's per-elemen TP list, in the SAME order the
 *        request was sent (the caller controls that order, so no name-matching
 *        is needed/attempted here).
 * @param {number|string} kelas
 * @returns {{ tps: Array, warnings: string[] }}
 */
export function assignTpCodes(cpElemen, aiTpsPerElemen, kelas) {
  const elemenList = Array.isArray(cpElemen) ? cpElemen : [];
  const perElemen = Array.isArray(aiTpsPerElemen) ? aiTpsPerElemen : [];
  const warnings = [];
  const tps = [];

  elemenList.forEach((el, elIdx) => {
    const noCP = elIdx + 1;
    const list = Array.isArray(perElemen[elIdx]) ? perElemen[elIdx] : [];
    if (!list.length) {
      warnings.push(`Elemen "${el && el.nama}" tidak mendapat TP sama sekali — periksa hasil AI atau tambahkan manual.`);
    }
    list.forEach((item, tpIdx) => {
      const noTP = tpIdx + 1;
      const kode = `D.${kelas}.${noCP}.${noTP}`;
      const bloom = clampBloom(item && item.bloom);
      if (!bloom) warnings.push(`TP ${kode}: level Bloom tidak dikenali ("${item && item.bloom}") — pilih manual.`);
      tps.push({
        kode,
        elemen: (el && el.nama) || '',
        rumusan: ensurePesertaDidikDapat(item && item.rumusan),
        bloom,
      });
    });
  });

  return { tps, warnings };
}

// =============================================================
// KKTP — assign codes: KKTP-<tpKode>
// =============================================================

/**
 * @param {Array<{kode:string}>} tps
 * @param {Array<{metode:string, kriteria?:string, instrumen?:string}>} aiKktps
 *        parallel to tps (same order/length expected — the caller sends tps
 *        in this exact order in the generation request).
 * @param {Array<{max?:number,min?:number,label:string}>} [intervalDefault]  from konstanta.json
 * @param {number} [kktpThreshold]  from konstanta.json / spine.config
 */
export function assignKktpCodes(tps, aiKktps, intervalDefault, kktpThreshold) {
  const list = Array.isArray(aiKktps) ? aiKktps : [];
  const warnings = [];
  const threshold = Number(kktpThreshold) > 0 ? Number(kktpThreshold) : 78;
  const interval = Array.isArray(intervalDefault) && intervalDefault.length ? intervalDefault : [
    { max: 60, label: 'Kurang' },
    { min: 61, max: 70, label: 'Cukup' },
    { min: 71, max: 80, label: 'Baik' },
    { min: 81, max: 100, label: 'Sangat Baik' },
  ];

  const kktps = tps.map((tp, i) => {
    const item = list[i] || {};
    let metode = ['Deskripsi', 'Rubrik', 'Interval'].includes(item.metode) ? item.metode : 'Deskripsi';
    let kriteria = String(item.kriteria || '').trim();
    if (metode === 'Interval' && !kriteria) {
      kriteria = `Skor ${threshold}-100 = tuntas (KKTP ${threshold}). ` +
        interval.map((r) => `${r.min ?? 0}-${r.max}: ${r.label}`).join('; ');
    }
    if (!kriteria) {
      warnings.push(`KKTP-${tp.kode}: kriteria kosong — isi manual.`);
      kriteria = '(belum diisi)';
    }
    return {
      kode: `KKTP-${tp.kode}`,
      tpKode: tp.kode,
      metode,
      kriteria,
      instrumen: String(item.instrumen || '').trim(),
    };
  });

  return { kktps, warnings };
}

// =============================================================
// ATP — build units from AI grouping + verify + JP math
// =============================================================

/**
 * @param {Array<{nama:string, tpKodes:string[], bobot?:number, semester?:number}>} aiUnits
 * @param {Array<{kode:string}>} tps  the full, authoritative TP list
 * @param {{totalJpTahun:number, jpPerPertemuan:number}} config
 * @param {Array<{jenis:string, jp:number, semester:number}>} sumatif
 * @returns {{ units: Array|null, errors: string[] }}
 */
export function buildUnits(aiUnits, tps, config, sumatif) {
  const errors = [];
  const list = Array.isArray(aiUnits) ? aiUnits : [];
  const allKodes = (Array.isArray(tps) ? tps : []).map((t) => t.kode);
  const allSet = new Set(allKodes);

  if (!list.length) {
    return { units: null, errors: ['ATP tidak berisi satu unit pun.'] };
  }

  const usedCount = new Map();
  for (const u of list) {
    for (const k of (u.tpKodes || [])) {
      usedCount.set(k, (usedCount.get(k) || 0) + 1);
    }
  }

  const missing = allKodes.filter((k) => !usedCount.has(k));
  const duplicated = [...usedCount.entries()].filter(([, c]) => c > 1).map(([k]) => k);
  const unknown = [...usedCount.keys()].filter((k) => !allSet.has(k));

  if (missing.length) errors.push(`TP belum dipakai di unit manapun: ${missing.join(', ')}`);
  if (duplicated.length) errors.push(`TP dipakai lebih dari satu unit: ${duplicated.join(', ')}`);
  if (unknown.length) errors.push(`Kode TP tidak dikenal: ${unknown.join(', ')}`);
  if (errors.length) return { units: null, errors };

  const totalJpTahun = Number(config.totalJpTahun) || 0;
  const jpPerPertemuan = Number(config.jpPerPertemuan) > 0 ? Number(config.jpPerPertemuan) : 1;
  const totalSumatifJp = (Array.isArray(sumatif) ? sumatif : []).reduce((s, x) => s + (Number(x.jp) || 0), 0);
  const availableJp = totalJpTahun - totalSumatifJp;

  if (!(totalJpTahun > 0)) return { units: null, errors: ['config.totalJpTahun belum diisi/tidak valid.'] };
  if (availableJp <= 0) return { units: null, errors: [`Total JP sumatif (${totalSumatifJp}) >= total JP tahun (${totalJpTahun}) — tidak ada JP tersisa untuk unit.`] };

  const bobot = list.map((u) => (Number(u.bobot) > 0 ? Number(u.bobot) : 1));
  const sumBobot = bobot.reduce((a, b) => a + b, 0);

  // raw[i] sums to availableJp exactly (before rounding) — bobot-weighted share.
  const raw = bobot.map((b) => (availableJp * b) / sumBobot);
  const rounded = raw.map((v) => Math.max(jpPerPertemuan, Math.round(v / jpPerPertemuan) * jpPerPertemuan));
  const roundedSum = rounded.reduce((a, b) => a + b, 0);
  const diff = availableJp - roundedSum;
  if (diff !== 0) {
    // Largest unit absorbs the rounding drift (documented exception to the
    // "multiple of jpPerPertemuan" rule — see plan's ATP row).
    let idxMax = 0;
    for (let i = 1; i < rounded.length; i++) if (rounded[i] > rounded[idxMax]) idxMax = i;
    rounded[idxMax] += diff;
  }

  const units = list.map((u, i) => ({
    // Preserve a caller-supplied id across recomputation (e.g. the ATP
    // stage re-running buildUnits after a manual edit) so unit identity
    // stays stable for anything that references it by id (RPP entries) —
    // only mint a fresh one the first time a unit is created.
    id: u.id || ('unit_' + (i + 1) + '_' + Math.random().toString(36).slice(2, 7)),
    nama: String(u.nama || '').trim() || `Unit ${i + 1}`,
    tpKodes: Array.isArray(u.tpKodes) ? u.tpKodes.slice() : [],
    bobot: bobot[i],
    jp: rounded[i],
    semester: Number(u.semester) === 2 ? 2 : 1,
    urutan: i + 1,
  }));

  return { units, errors: [] };
}

// =============================================================
// PROTA — pure aggregation view of units + sumatif, per semester
// =============================================================

function orderSemesterItems(units, sumatif) {
  const bySem = { 1: [], 2: [] };
  for (const u of units) bySem[u.semester === 2 ? 2 : 1].push({ tipe: 'unit', ref: u, urutan: u.urutan, jp: u.jp });
  for (const s of sumatif) {
    const sem = Number(s.semester) === 2 ? 2 : 1;
    const isEnd = /^(SAS|SAT)$/i.test(s.jenis || '');
    bySem[sem].push({ tipe: 'sumatif', ref: s, isEnd, jp: Number(s.jp) || 0 });
  }

  const out = { 1: [], 2: [] };
  for (const sem of [1, 2]) {
    const unitItems = bySem[sem].filter((x) => x.tipe === 'unit').sort((a, b) => a.urutan - b.urutan);
    const midItems = bySem[sem].filter((x) => x.tipe === 'sumatif' && !x.isEnd);
    const endItems = bySem[sem].filter((x) => x.tipe === 'sumatif' && x.isEnd);
    const midPoint = Math.ceil(unitItems.length / 2);
    out[sem] = [
      ...unitItems.slice(0, midPoint),
      ...midItems,
      ...unitItems.slice(midPoint),
      ...endItems,
    ];
  }
  return out;
}

/**
 * @param {Array} units  from buildUnits()
 * @param {Array<{jenis:string, jp:number, semester:number}>} sumatif
 */
export function aggregateProta(units, sumatif) {
  const uList = Array.isArray(units) ? units : [];
  const sList = Array.isArray(sumatif) ? sumatif : [];
  const ordered = orderSemesterItems(uList, sList);

  const build = (sem) => {
    const items = ordered[sem];
    const totalJp = items.reduce((s, it) => s + (Number(it.jp) || 0), 0);
    return { items, totalJp };
  };

  const semester1 = build(1);
  const semester2 = build(2);
  return {
    semester1,
    semester2,
    totalJpTahun: semester1.totalJp + semester2.totalJp,
  };
}

// =============================================================
// PROSEM — sequential distribution over the semester's weeks (no AI, no kaldik)
// =============================================================

function resolveMingguEfektif(config, kelas) {
  const m = config && config.mingguEfektif;
  const ganjil = (m && Number(m.ganjil) > 0) ? Number(m.ganjil) : MINGGU_EFEKTIF_DEFAULT.ganjil;
  let genap = (m && Number(m.genap) > 0) ? Number(m.genap) : null;
  if (genap == null) {
    genap = Number(kelas) === 9 ? MINGGU_EFEKTIF_DEFAULT.genapKelas9 : MINGGU_EFEKTIF_DEFAULT.genap;
  }
  return { ganjil, genap };
}

/** Distribute `mingguCount` weeks across the semester's 6 months as evenly as
 *  possible (front-loaded) — kaldik is explicitly out of scope (plan §"owner
 *  decisions" #6), this is a generic calendar, not the real school calendar. */
function buildCalendar(semester, mingguCount) {
  const bulanNames = BULAN_SEMESTER[semester];
  const per = Math.floor(mingguCount / 6);
  const extra = mingguCount % 6;
  return bulanNames.map((nama, i) => ({ bulan: nama, mingguCount: per + (i < extra ? 1 : 0) }));
}

/** Flatten a calendar into a linear list of {bulan, minggu} week slots. */
function flattenWeeks(calendar) {
  const slots = [];
  for (const { bulan, mingguCount } of calendar) {
    for (let w = 1; w <= mingguCount; w++) slots.push({ bulan, minggu: w });
  }
  return slots;
}

/**
 * @param {Array} units  from buildUnits()
 * @param {Array} sumatif
 * @param {{jpPerMinggu:number, mingguEfektif?:{ganjil?:number, genap?:number}}} config
 * @param {number|string} kelas  used only to pick the genap default (kelas 9 uses a shorter genap calendar)
 */
export function distributeProsem(units, sumatif, config, kelas) {
  const jpPerMinggu = Number(config.jpPerMinggu) > 0 ? Number(config.jpPerMinggu) : 1;
  const mingguEfektif = resolveMingguEfektif(config, kelas);
  const ordered = orderSemesterItems(Array.isArray(units) ? units : [], Array.isArray(sumatif) ? sumatif : []);

  const buildSemester = (sem, mingguCount) => {
    const calendar = buildCalendar(sem, mingguCount);
    const slots = flattenWeeks(calendar);
    let slotIdx = 0;
    const rows = [];

    for (const item of ordered[sem]) {
      const totalJp = Number(item.jp) || 0;
      let remaining = totalJp;
      const cells = [];
      while (remaining > 0) {
        const slot = slots[slotIdx] || slots[slots.length - 1] || { bulan: calendar[calendar.length - 1].bulan, minggu: 99 };
        const jpThis = Math.min(jpPerMinggu, remaining);
        cells.push({ bulan: slot.bulan, minggu: slot.minggu, jp: jpThis });
        remaining -= jpThis;
        slotIdx++;
      }
      if (item.tipe === 'unit') {
        rows.push({
          tipe: 'unit', id: item.ref.id, materi: item.ref.nama, elemen: '', totalJp, cells,
        });
      } else {
        rows.push({
          tipe: 'sumatif', id: item.ref.jenis, materi: sumatifLabel(item.ref.jenis), elemen: '', totalJp, cells,
        });
      }
    }
    return { calendar, rows, totalJp: rows.reduce((s, r) => s + r.totalJp, 0) };
  };

  return {
    semester1: buildSemester(1, mingguEfektif.ganjil),
    semester2: buildSemester(2, mingguEfektif.genap),
    mingguEfektif,
  };
}

function sumatifLabel(jenis) {
  const map = {
    STS1: 'Sumatif Tengah Semester 1',
    SAS: 'Sumatif Akhir Semester (Ganjil)',
    STS2: 'Sumatif Tengah Semester 2',
    SAT: 'Sumatif Akhir Tahun (Genap)',
  };
  return map[jenis] || jenis || 'Sumatif';
}

// =============================================================
// RPP meeting split — pertemuan count + per-meeting minute plan
// =============================================================

// Opening/Main(3 phases)/Closing weighting — approximates the plan's
// "10/20/30/20/10-style" split while summing to exactly 100%.
const MEETING_PCT = { opening: 10, memahami: 20, mengaplikasi: 30, merefleksi: 20, closing: 20 };

/**
 * @param {{jp:number}} unit
 * @param {{jpPerPertemuan:number, menitPerJp?:number}} config
 */
export function splitMeetings(unit, config) {
  const jpp = Number(config.jpPerPertemuan) > 0 ? Number(config.jpPerPertemuan) : 1;
  const menitPerJp = Number(config.menitPerJp) > 0 ? Number(config.menitPerJp) : 40;
  const totalJp = Number(unit.jp) || 0;
  const count = Math.max(1, Math.ceil(totalJp / jpp));

  let remaining = totalJp;
  const meetings = [];
  for (let i = 0; i < count; i++) {
    const jpThis = i === count - 1 ? remaining : Math.min(jpp, remaining);
    remaining -= jpThis;
    const totalMenit = jpThis * menitPerJp;

    const menit = { total: totalMenit };
    let sum = 0;
    for (const k of Object.keys(MEETING_PCT)) {
      menit[k] = Math.round((totalMenit * MEETING_PCT[k]) / 100);
      sum += menit[k];
    }
    const drift = totalMenit - sum;
    if (drift !== 0) menit.mengaplikasi += drift; // largest bucket absorbs rounding drift

    meetings.push({ index: i, jp: jpThis, menit });
  }

  return { pertemuanCount: count, meetings };
}

export { round2 };
