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

// Kept in sync with pemeran/data/konstanta.json's "bloom.<level>.verba" —
// used by draftTpFromCp() to guess a Bloom level from a clause's verb when
// building the zero-AI "Kerangka Instan" draft (V2a #9). Same duplication
// pattern as api/pemeran-ai.js's BLOOM_VERBS (this file must stay
// fetch-free to run under plain `node`).
const BLOOM_VERBS = {
  C1: ['mengidentifikasi', 'menyebutkan', 'mendaftar', 'mendefinisikan', 'mengenali'],
  C2: ['menjelaskan', 'mendeskripsikan', 'menginterpretasi', 'merangkum', 'membandingkan', 'mencontohkan'],
  C3: ['menerapkan', 'menggunakan', 'mendemonstrasikan', 'menghitung', 'melaksanakan', 'mengoperasikan'],
  C4: ['menganalisis', 'membedakan', 'mengorganisasi', 'menguji', 'mendekonstruksi'],
  C5: ['mengevaluasi', 'menilai', 'mengkritik', 'memutuskan', 'memverifikasi'],
  C6: ['merancang', 'menyusun', 'mengkreasikan', 'memproduksi', 'merumuskan', 'mengembangkan'],
};

const MINGGU_EFEKTIF_DEFAULT = { ganjil: 18, genap: 17, genapKelas9: 14 };

const BULAN_SEMESTER = {
  1: ['Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'],
  2: ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni'],
};

// Placeholder text dropped into every field of a zero-AI "Kerangka Instan"
// RPP skeleton (V2a #9) — also doubles as the sentinel generateRppEntry()
// (js/rppGen.js) uses to tell "already has real AI content" apart from
// "still awaiting AI" when resuming/filling a skeleton.
export const RPP_PLACEHOLDER = '(klik untuk mengisi, atau \u{1F504} untuk membuat dengan AI)';

// ---- small pure helpers -----------------------------------------------------

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Canonical config defaults (V2a #1 — root cause of the "15 pertemuan"
 * bug was THREE different fallback values for jpPerPertemuan scattered
 * across pipeline.js/stages/rpp.js/render/rpp.js). Every call site that
 * needs a default for these three numbers MUST go through this function.
 */
export function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {};
  const jpPerPertemuan = Number(c.jpPerPertemuan) > 0 ? Number(c.jpPerPertemuan) : 2;
  const menitPerJp = Number(c.menitPerJp) > 0 ? Number(c.menitPerJp) : 40;
  const maxPertemuanPerUnit = Number(c.maxPertemuanPerUnit) > 0 ? Number(c.maxPertemuanPerUnit) : 4;
  return { jpPerPertemuan, menitPerJp, maxPertemuanPerUnit };
}

/** ceil(jp / jpp), the ONE formula every meeting-count/duration string derives from. */
export function computePertemuanCount(jp, jpPerPertemuan) {
  const jpp = Number(jpPerPertemuan) > 0 ? Number(jpPerPertemuan) : 2;
  return Math.max(1, Math.ceil((Number(jp) || 0) / jpp));
}

/** The RPP identity pane's "Time Allocation" string for the FULL unit (all
 *  meetings) — derived from the same {jp, jpp, count} triple everywhere. */
export function formatDurationLabel(jp, jpPerPertemuan, menitPerJp) {
  const jpNum = Number(jp) || 0;
  const count = computePertemuanCount(jpNum, jpPerPertemuan);
  return `${count} Pertemuan × ${jpPerPertemuan} JP @${menitPerJp}′ (Total ${jpNum} JP)`;
}

/** Split `list` into `count` roughly-even, contiguous, order-preserving
 *  chunks. Shared by unit-cap splitting (buildUnits), per-meeting TP
 *  chunking (render/rpp.js, js/rppGen.js) — one implementation everywhere
 *  a "spread N items evenly across M buckets, in order" is needed. */
export function chunkList(list, count) {
  const arr = Array.isArray(list) ? list : [];
  const n = Math.max(1, Number(count) || 1);
  if (!arr.length || n <= 1) return Array.from({ length: n }, () => arr.slice());
  const out = Array.from({ length: n }, () => []);
  arr.forEach((item, i) => { out[Math.min(n - 1, Math.floor((i * n) / arr.length))].push(item); });
  return out;
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
  const { jpPerPertemuan, maxPertemuanPerUnit } = normalizeConfig(config);
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

  const rawUnits = list.map((u, i) => ({
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
  }));

  // V2a #2 — unit caps: buildUnits used to have a floor (jpPerPertemuan
  // minimum above) but no ceiling, so a heavily-weighted unit could land at
  // e.g. 30 JP -> 15 pertemuan. Any unit over the cap is deterministically
  // split into consecutive "— Bagian N" chunks, TPs and JP divided in order,
  // so RPP generation/preview never has to handle a mega-unit.
  const maxJpPerUnit = jpPerPertemuan * maxPertemuanPerUnit;
  const units = [];
  for (const u of rawUnits) {
    if (u.jp > maxJpPerUnit) units.push(...splitOversizedUnit(u, maxJpPerUnit));
    else units.push(u);
  }
  units.forEach((u, i) => { u.urutan = i + 1; });

  return { units, errors: [] };
}

function makeUnitChunk(unit, i, tpKodes, jp) {
  return {
    id: i === 0 ? unit.id : `${unit.id}_b${i + 1}`,
    nama: i === 0 ? unit.nama : `${unit.nama} — Bagian ${i + 1}`,
    tpKodes: tpKodes || [],
    bobot: unit.bobot,
    jp,
    semester: unit.semester,
  };
}

/** Split one over-cap unit into consecutive "Bagian" chunks: TPs divided in
 *  order across the chunks, JP re-split with the LAST chunk absorbing
 *  whatever remains (mirrors buildUnits' own rounding-drift convention
 *  above) so Σjp across chunks == the original unit's jp exactly and every
 *  TP is still used exactly once.
 *
 *  chunkCount is capped at unit.tpKodes.length: a "Bagian" with ZERO TPs is
 *  a broken RPP entry (nothing to teach, no CP/TP linkage). A TP-sparse,
 *  JP-heavy unit is a realistic input — e.g. draftUnits() (V2a #9
 *  "Kerangka Instan") merges any too-small trailing group into the
 *  previous one, which can leave a single unit holding just a handful of
 *  TPs but (via buildUnits' bobot-weighted split) the bulk of the year's
 *  JP, since draftUnits gives every group equal bobot regardless of TP
 *  count — discovered via V2a #9's offline end-to-end test producing
 *  several TP-empty "Bagian N" units. When TP count is the binding
 *  constraint instead of JP count, staying under maxJpPerUnit per chunk is
 *  relaxed (unavoidable — there's nothing to split further) in favor of
 *  never emitting a contentless chunk, and the JP is spread as evenly as
 *  possible across the smaller chunk count rather than maxing out early
 *  chunks and dumping the whole excess on the last one. */
function splitOversizedUnit(unit, maxJpPerUnit) {
  const tpCount = Array.isArray(unit.tpKodes) ? unit.tpKodes.length : 0;
  const jpDrivenChunks = Math.max(1, Math.ceil(unit.jp / maxJpPerUnit));
  const chunkCount = Math.min(jpDrivenChunks, tpCount || 1);
  if (chunkCount <= 1) return [unit];

  const tpChunks = chunkList(unit.tpKodes, chunkCount);
  const chunks = [];

  if (chunkCount === jpDrivenChunks) {
    // Normal case: JP volume is the binding constraint — every chunk stays
    // at/under maxJpPerUnit, last chunk absorbs the rounding remainder.
    let remaining = unit.jp;
    for (let i = 0; i < chunkCount; i++) {
      const isLast = i === chunkCount - 1;
      const jpThis = isLast ? remaining : Math.min(maxJpPerUnit, remaining);
      remaining -= jpThis;
      chunks.push(makeUnitChunk(unit, i, tpChunks[i], jpThis));
    }
  } else {
    // TP count is the binding constraint — split JP as evenly as possible
    // across the (smaller) chunk count instead; still sums to unit.jp
    // exactly (base*chunkCount + extra, by definition of floor division).
    const base = Math.floor(unit.jp / chunkCount);
    const extra = unit.jp % chunkCount;
    for (let i = 0; i < chunkCount; i++) {
      chunks.push(makeUnitChunk(unit, i, tpChunks[i], base + (i < extra ? 1 : 0)));
    }
  }
  return chunks;
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
// V2b #4 — Prosem manual overrides (click-a-cell-to-move-JP)
// =============================================================

/**
 * Apply teacher-made manual cell placements on top of distributeProsem()'s
 * auto-computed rows. A row is only overridden when its stored override's
 * cells still sum to that row's totalJp (a unit whose JP changed elsewhere
 * — e.g. an ATP edit — silently falls back to auto-distribution for that
 * row rather than showing a JP total that no longer adds up; the teacher
 * re-does the manual placement if they still want it, same "surface, don't
 * silently misreport" spirit as the rest of the validator).
 * @param {Array} units
 * @param {Array} sumatif
 * @param {object} config
 * @param {number|string} kelas
 * @param {object} [overrides]  spine.prosem.overrides — { [rowId]: { manual, cells } }
 */
export function distributeProsemWithOverrides(units, sumatif, config, kelas, overrides) {
  const computed = distributeProsem(units, sumatif, config, kelas);
  if (!overrides || typeof overrides !== 'object') return computed;

  for (const sem of [1, 2]) {
    const data = sem === 1 ? computed.semester1 : computed.semester2;
    data.rows = data.rows.map((row) => {
      const ov = overrides[row.id];
      if (!ov || !ov.manual || !Array.isArray(ov.cells)) return row;
      const sum = ov.cells.reduce((s, c) => s + (Number(c.jp) || 0), 0);
      if (sum !== row.totalJp) return row; // stale override — fall back to auto silently
      return Object.assign({}, row, { cells: ov.cells.map((c) => ({ ...c })), manual: true });
    });
  }
  return computed;
}

/**
 * Move one week-slot's JP allocation within the SAME row (unit or sumatif
 * band) from `from` {bulan,minggu} to `to` {bulan,minggu} — the row's total
 * JP is always preserved (the moved cell keeps its jp value; nothing else
 * about the row changes). Returns the row's new `cells` array (for the
 * caller to persist into spine.prosem.overrides[rowId]), or null if the
 * move is invalid (no such source cell, or destination already occupied).
 * @param {object} semesterData  distributeProsem(...).semester1|2 (post-
 *        override, i.e. what's currently on screen — so a second move
 *        composes on top of the first)
 * @param {string} rowId
 * @param {{bulan:string, minggu:number}} from
 * @param {{bulan:string, minggu:number}} to
 * @returns {Array|null}
 */
export function moveProsemCell(semesterData, rowId, from, to) {
  const row = (semesterData.rows || []).find((r) => r.id === rowId);
  if (!row) return null;
  const cells = row.cells.map((c) => ({ ...c }));
  const fromIdx = cells.findIndex((c) => c.bulan === from.bulan && c.minggu === from.minggu);
  if (fromIdx < 0) return null;
  const destOccupied = cells.some((c) => c.bulan === to.bulan && c.minggu === to.minggu);
  if (destOccupied) return null;
  cells[fromIdx] = { bulan: to.bulan, minggu: to.minggu, jp: cells[fromIdx].jp };
  return cells;
}

// =============================================================
// V2b #7 — cascade a TP-code rename (KKTP prefix, units.tpKodes, rpps refs)
// =============================================================

/**
 * TP codes are shown as an editable field in the merged Data stage (V2b) —
 * renaming one must cascade everywhere the OLD code is referenced, so
 * nothing goes "orphaned" the way validate.js's checkTpNoOrphans would
 * otherwise flag: the TP's own kode, its KKTP's kode ("KKTP-"+kode) and
 * tpKode, every unit.tpKodes entry, and every RPP entry's cached
 * unit.tpList/kktpList (RPP entries snapshot TP/KKTP text at creation time
 * rather than re-reading spine.tps live, so they need the same rewrite).
 * Pure function — never mutates `spine`, returns a NEW spine object
 * (shallow-immutable per touched array/object) so callers can feed it
 * straight into state.js's replaceSpine() the same way validate.js's
 * fix.apply() results do.
 * @param {object} spine
 * @param {string} oldKode
 * @param {string} newKode
 * @returns {object} a new spine
 */
export function renameTpKode(spine, oldKode, newKode) {
  const s = spine || {};
  const oldK = String(oldKode || '').trim();
  const newK = String(newKode || '').trim();
  if (!oldK || !newK || oldK === newK) return s;

  const tps = (s.tps || []).map((t) => (t.kode === oldK ? Object.assign({}, t, { kode: newK }) : t));

  const oldKktpKode = `KKTP-${oldK}`;
  const newKktpKode = `KKTP-${newK}`;
  const kktps = (s.kktps || []).map((k) => {
    if (k.tpKode !== oldK) return k;
    return Object.assign({}, k, {
      tpKode: newK,
      kode: k.kode === oldKktpKode ? newKktpKode : k.kode,
    });
  });

  const units = (s.units || []).map((u) => (
    Array.isArray(u.tpKodes) && u.tpKodes.includes(oldK)
      ? Object.assign({}, u, { tpKodes: u.tpKodes.map((k) => (k === oldK ? newK : k)) })
      : u
  ));

  const rpps = (s.rpps || []).map((entry) => {
    const unit = entry.unit || {};
    let changed = false;
    const tpList = Array.isArray(unit.tpList) ? unit.tpList.map((t) => {
      if (t.kode !== oldK) return t;
      changed = true;
      return Object.assign({}, t, { kode: newK });
    }) : unit.tpList;
    const kktpList = Array.isArray(unit.kktpList) ? unit.kktpList.map((k) => {
      if (k.kode !== oldKktpKode) return k;
      changed = true;
      return Object.assign({}, k, { kode: newKktpKode });
    }) : unit.kktpList;
    if (!changed) return entry;
    return Object.assign({}, entry, { unit: Object.assign({}, unit, { tpList, kktpList }) });
  });

  return Object.assign({}, s, { tps, kktps, units, rpps });
}

/** Flatten distributeProsem()'s {semester1,semester2} shape into the flat
 *  row-per-week-cell list spine.prosem.rows actually stores. Shared by
 *  oneshot.js (initial build) and validate.js's "Susun ulang Prosem" fix
 *  (V2a #7) — previously duplicated inline in oneshot.js. */
export function flattenProsemRows(computed) {
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
  const { jpPerPertemuan: jpp, menitPerJp } = normalizeConfig(config);
  const totalJp = Number(unit.jp) || 0;
  const count = computePertemuanCount(totalJp, jpp);

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

// =============================================================
// V2a #9 — zero-AI "Kerangka Instan" draft builders. Deterministic
// rule-based stand-ins for the AI steps so ANY teacher (not just the
// owner) can see the full document shape instantly, for free, before
// ever calling the AI. Downstream of these, the SAME pipeline functions
// (assignTpCodes/assignKktpCodes/buildUnits/splitMeetings) already used
// by the AI path run unchanged — only the "what would the AI have
// returned" step is replaced by a rule, so the two paths converge on
// identical shapes.
// =============================================================

function guessBloom(text) {
  const s = String(text || '').toLowerCase();
  for (const lv of BLOOM_LEVELS) {
    if (BLOOM_VERBS[lv].some((v) => s.includes(v))) return lv;
  }
  return 'C2'; // safest generic default (SOP: kelas VII-VIII skew C1-C4)
}

/** Split CP elemen text into clause-sized fragments on `;` and sentence
 *  boundaries (`.` `!` `?`), discarding empty/too-short fragments. */
function splitClauses(text) {
  return String(text || '')
    .split(/[;.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

/**
 * Rule-based TP decomposition — the zero-AI stand-in for generate_tp.
 * One TP per clause found in each elemen's CP text, Bloom level guessed
 * from the clause's verb (falls back to C2). Reuses assignTpCodes() so
 * codes/prefixing/warnings are byte-identical to the AI path's output shape.
 * @param {Array<{nama:string, teks:string}>} cpElemen
 * @param {number|string} kelas
 */
export function draftTpFromCp(cpElemen, kelas) {
  const elemenList = Array.isArray(cpElemen) ? cpElemen : [];
  const perElemen = elemenList.map((el) => {
    const clauses = splitClauses(el && el.teks);
    return clauses.map((c) => ({ rumusan: c, bloom: guessBloom(c) }));
  });
  return assignTpCodes(elemenList, perElemen, kelas);
}

/**
 * Rule-based KKTP — 1:1 with TPs, method "Interval" so assignKktpCodes()'s
 * existing deterministic fallback (konstanta interval table + threshold)
 * fills in a concrete kriteria with no AI call needed.
 * @param {Array<{kode:string}>} tps
 * @param {{intervalDefault?:Array, kktpThreshold?:number}} [konstanta]
 */
export function draftKktp(tps, konstanta) {
  const k = konstanta || {};
  const stub = (Array.isArray(tps) ? tps : []).map(() => ({
    metode: 'Interval', kriteria: '', instrumen: 'Tes tertulis / observasi singkat',
  }));
  return assignKktpCodes(tps, stub, k.intervalDefault, k.kktpThreshold);
}

/**
 * Rule-based ATP grouping — consecutive 3-4-TP groups (a too-small trailing
 * group merges into the previous one), named after whichever elemen is
 * most represented in the group. Returns the same {nama,tpKodes,bobot,
 * semester} "AI units" shape buildUnits() expects as input — feed this
 * straight into buildUnits() same as the AI's generate_atp result.
 * @param {Array<{kode:string, elemen:string}>} tps
 * @param {object} [config]  unused today, kept for signature symmetry with
 *        the other draft* builders / a future group-size override.
 */
export function draftUnits(tps, config) {
  const list = Array.isArray(tps) ? tps : [];
  const GROUP_SIZE = 4;
  const groups = [];
  for (let i = 0; i < list.length; i += GROUP_SIZE) groups.push(list.slice(i, i + GROUP_SIZE));
  if (groups.length > 1 && groups[groups.length - 1].length < 3) {
    const last = groups.pop();
    groups[groups.length - 1] = groups[groups.length - 1].concat(last);
  }
  const half = Math.ceil(groups.length / 2);
  return groups.map((grp, i) => {
    const counts = new Map();
    for (const t of grp) counts.set(t.elemen, (counts.get(t.elemen) || 0) + 1);
    let dominant = (grp[0] && grp[0].elemen) || `Unit ${i + 1}`;
    let max = 0;
    for (const [el, c] of counts) if (c > max) { max = c; dominant = el || dominant; }
    return {
      nama: dominant || `Unit ${i + 1}`,
      tpKodes: grp.map((t) => t.kode),
      bobot: 1,
      semester: i < half ? 1 : 2,
    };
  });
}

/**
 * Rule-based RPP skeleton — correct structure/identity/minutes (via
 * splitMeetings, so it's automatically consistent with #1/#2 above), every
 * content field set to RPP_PLACEHOLDER so the teacher (or a later AI pass —
 * see js/rppGen.js's "already generated" check, which treats this exact
 * sentinel as "still needs AI/hand content") sees the full document shape
 * immediately.
 * @param {object} unit  a unit already shaped like unitFromAtp()'s output
 *        (topik, jp, jpPerPertemuan, semester, tpList, ...)
 * @param {object} config
 */
export function draftRppSkeleton(unit, config) {
  const { pertemuanCount } = splitMeetings(unit, config);
  const pertemuan = Array.from({ length: pertemuanCount }, () => ({
    opening: RPP_PLACEHOLDER,
    memahami: RPP_PLACEHOLDER,
    mengaplikasi: RPP_PLACEHOLDER,
    merefleksi: RPP_PLACEHOLDER,
    closing: RPP_PLACEHOLDER,
  }));
  return {
    pertemuanCount,
    content: {
      peserta_didik: RPP_PLACEHOLDER,
      materi_pelajaran: unit.topik || unit.nama || '',
      graduate_profile_selected: [],
      santri_kitab_selected: [],
      internalisasi_nilai_agama: RPP_PLACEHOLDER,
      capaian_element: RPP_PLACEHOLDER,
      capaian_competence: RPP_PLACEHOLDER,
      capaian_content: RPP_PLACEHOLDER,
      lintas_disiplin_ilmu: RPP_PLACEHOLDER,
      model: RPP_PLACEHOLDER,
      strategy: RPP_PLACEHOLDER,
      method: RPP_PLACEHOLDER,
      kemitraan: RPP_PLACEHOLDER,
      lingkungan: RPP_PLACEHOLDER,
      digital: RPP_PLACEHOLDER,
      asesmen_awal: RPP_PLACEHOLDER,
      asesmen_proses: RPP_PLACEHOLDER,
      asesmen_akhir: RPP_PLACEHOLDER,
      learning_media: RPP_PLACEHOLDER,
      pertemuan,
    },
  };
}

export { round2 };
