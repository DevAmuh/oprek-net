// =============================================================
// Pemeran — pipeline.js unit tests
// Plain assert, no framework. Run with:  node pipeline.test.js
// (pemeran/js/package.json sets "type":"module" scoped to this
// folder so plain import/export works under Node without touching
// the CommonJS api/*.js files elsewhere in the repo.)
// =============================================================
import assert from 'node:assert/strict';
import {
  assignTpCodes, assignKktpCodes, buildUnits, aggregateProta,
  distributeProsem, splitMeetings, ensurePesertaDidikDapat, clampBloom,
  normalizeConfig, computePertemuanCount, formatDurationLabel, flattenProsemRows,
  draftTpFromCp, draftKktp, draftUnits, draftRppSkeleton, RPP_PLACEHOLDER,
} from './pipeline.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok  -', name);
  } catch (e) {
    console.error('FAIL  -', name);
    console.error('       ', e && e.message || e);
    process.exitCode = 1;
  }
}

console.log('pipeline.test.js');

// -------------------------------------------------------------
test('ensurePesertaDidikDapat: prefixes when missing, leaves as-is when present', () => {
  assert.equal(ensurePesertaDidikDapat('menjelaskan proses fotosintesis'), 'Peserta didik dapat menjelaskan proses fotosintesis');
  assert.equal(ensurePesertaDidikDapat('Peserta didik dapat menjelaskan X'), 'Peserta didik dapat menjelaskan X');
  assert.equal(ensurePesertaDidikDapat('PESERTA DIDIK DAPAT sudah dari AI'), 'PESERTA DIDIK DAPAT sudah dari AI');
});

test('clampBloom: only accepts C1-C6', () => {
  assert.equal(clampBloom('c2'), 'C2');
  assert.equal(clampBloom('C9'), null);
  assert.equal(clampBloom(''), null);
});

// -------------------------------------------------------------
test('assignTpCodes: codes are D.<kelas>.<noCP>.<noTP>, in cp-elemen order', () => {
  const cpElemen = [
    { nama: 'Menyimak - Berbicara', teks: '...' },
    { nama: 'Membaca - Memirsa', teks: '...' },
  ];
  const aiTps = [
    [{ rumusan: 'menjelaskan A', bloom: 'C2' }, { rumusan: 'menjelaskan B', bloom: 'C3' }],
    [{ rumusan: 'membaca C', bloom: 'C1' }],
  ];
  const { tps, warnings } = assignTpCodes(cpElemen, aiTps, 7);
  assert.equal(tps.length, 3);
  assert.equal(tps[0].kode, 'D.7.1.1');
  assert.equal(tps[1].kode, 'D.7.1.2');
  assert.equal(tps[2].kode, 'D.7.2.1');
  assert.ok(tps.every((t) => t.rumusan.startsWith('Peserta didik dapat')));
  assert.equal(tps[0].elemen, 'Menyimak - Berbicara');
  assert.equal(warnings.length, 0);
});

test('assignTpCodes: warns when an elemen gets zero TPs', () => {
  const cpElemen = [{ nama: 'A' }, { nama: 'B' }];
  const aiTps = [[{ rumusan: 'x', bloom: 'C2' }], []];
  const { warnings } = assignTpCodes(cpElemen, aiTps, 7);
  assert.ok(warnings.some((w) => w.includes('B')));
});

// -------------------------------------------------------------
test('assignKktpCodes: KKTP-<tpKode>, Interval gets a default kriteria if AI omitted it', () => {
  const tps = [{ kode: 'D.7.1.1' }, { kode: 'D.7.1.2' }];
  const aiKktps = [{ metode: 'Interval', kriteria: '', instrumen: 'Tes tulis' }, { metode: 'Deskripsi', kriteria: 'Sudah lengkap', instrumen: '' }];
  const { kktps } = assignKktpCodes(tps, aiKktps, undefined, 78);
  assert.equal(kktps[0].kode, 'KKTP-D.7.1.1');
  assert.equal(kktps[0].tpKode, 'D.7.1.1');
  assert.ok(kktps[0].kriteria.includes('78'));
  assert.equal(kktps[1].kriteria, 'Sudah lengkap');
});

// -------------------------------------------------------------
// ESP kelas 7 worked example (SOP's own numbers): totalJpTahun=72,
// jpPerPertemuan=2, sumatif defaults (STS1/SAS/STS2/SAT @2 JP each,
// 2 per semester) -> 8 units (4/semester) reproduce 36 JP/semester,
// 72 JP/tahun.
// -------------------------------------------------------------
function makeEsp7Tps() {
  const cpElemen = [
    { nama: 'Menyimak - Berbicara' },
    { nama: 'Membaca - Memirsa' },
    { nama: 'Menulis - Mempresentasikan' },
  ];
  // 16 TPs total, arbitrarily spread 6/5/5 across the 3 elemen.
  const perElemen = [
    Array.from({ length: 6 }, (_, i) => ({ rumusan: `menyimak topik ${i + 1}`, bloom: 'C2' })),
    Array.from({ length: 5 }, (_, i) => ({ rumusan: `membaca topik ${i + 1}`, bloom: 'C2' })),
    Array.from({ length: 5 }, (_, i) => ({ rumusan: `menulis topik ${i + 1}`, bloom: 'C3' })),
  ];
  return assignTpCodes(cpElemen, perElemen, 7).tps;
}

const SUMATIF_ESP7 = [
  { jenis: 'STS1', jp: 2, semester: 1 },
  { jenis: 'SAS', jp: 2, semester: 1 },
  { jenis: 'STS2', jp: 2, semester: 2 },
  { jenis: 'SAT', jp: 2, semester: 2 },
];

test('buildUnits: rejects when a TP is missing from every unit', () => {
  const tps = makeEsp7Tps();
  const aiUnits = [{ nama: 'Unit 1', tpKodes: tps.slice(1).map((t) => t.kode), bobot: 1, semester: 1 }];
  const { units, errors } = buildUnits(aiUnits, tps, { totalJpTahun: 72, jpPerPertemuan: 2 }, SUMATIF_ESP7);
  assert.equal(units, null);
  assert.ok(errors.some((e) => e.includes(tps[0].kode)));
});

test('buildUnits: rejects when a TP is duplicated across units', () => {
  const tps = makeEsp7Tps();
  const aiUnits = [
    { nama: 'Unit 1', tpKodes: tps.slice(0, 3).map((t) => t.kode), bobot: 1, semester: 1 },
    { nama: 'Unit 2', tpKodes: tps.slice(2, 5).map((t) => t.kode), bobot: 1, semester: 1 }, // overlaps at index 2
  ];
  const { units, errors } = buildUnits(aiUnits, tps.slice(0, 5), { totalJpTahun: 72, jpPerPertemuan: 2 }, SUMATIF_ESP7);
  assert.equal(units, null);
  assert.ok(errors.some((e) => e.includes('lebih dari satu unit')));
});

test('buildUnits: JP normalization sums exactly to (totalJpTahun - sumatif), rounded to jpPerPertemuan multiples', () => {
  const tps = makeEsp7Tps();
  assert.equal(tps.length, 16);
  // Group into 8 units of 2 TPs each, 4 units per semester, equal bobot.
  const aiUnits = [];
  for (let i = 0; i < 8; i++) {
    aiUnits.push({
      nama: `Unit ${i + 1}`,
      tpKodes: tps.slice(i * 2, i * 2 + 2).map((t) => t.kode),
      bobot: 1,
      semester: i < 4 ? 1 : 2,
    });
  }
  const config = { totalJpTahun: 72, jpPerPertemuan: 2 };
  const { units, errors } = buildUnits(aiUnits, tps, config, SUMATIF_ESP7);
  assert.deepEqual(errors, []);
  assert.equal(units.length, 8);

  const sumUnitJp = units.reduce((s, u) => s + u.jp, 0);
  assert.equal(sumUnitJp, 72 - 8); // 64 — exact, no drift lost
  for (const u of units) assert.equal(u.jp % 2, 0); // multiples of jpPerPertemuan (bobot=1 uniform case)

  // every TP used exactly once
  const allUsed = units.flatMap((u) => u.tpKodes);
  assert.equal(allUsed.length, tps.length);
  assert.deepEqual([...new Set(allUsed)].sort(), tps.map((t) => t.kode).sort());

  // ---- reproduce the plan's worked numbers: 36 JP/semester, 72 JP/tahun ----
  const prota = aggregateProta(units, SUMATIF_ESP7);
  assert.equal(prota.semester1.totalJp, 36);
  assert.equal(prota.semester2.totalJp, 36);
  assert.equal(prota.totalJpTahun, 72);
});

test('buildUnits: uneven bobot still sums exactly (largest unit absorbs rounding drift)', () => {
  const tps = makeEsp7Tps();
  const aiUnits = [];
  const bobotList = [1.3, 0.7, 1.1, 0.9, 1.2, 0.8, 1.0, 1.0]; // avg 1.0, but individual rounding won't land cleanly
  for (let i = 0; i < 8; i++) {
    aiUnits.push({
      nama: `Unit ${i + 1}`,
      tpKodes: tps.slice(i * 2, i * 2 + 2).map((t) => t.kode),
      bobot: bobotList[i],
      semester: i < 4 ? 1 : 2,
    });
  }
  const config = { totalJpTahun: 72, jpPerPertemuan: 2 };
  const { units, errors } = buildUnits(aiUnits, tps, config, SUMATIF_ESP7);
  assert.deepEqual(errors, []);
  const sumUnitJp = units.reduce((s, u) => s + u.jp, 0);
  assert.equal(sumUnitJp, 64);
  assert.ok(units.every((u) => u.jp >= 2));
});

// -------------------------------------------------------------
test('distributeProsem: every row\'s cells sum to that row\'s totalJp; semester totals match aggregateProta', () => {
  const tps = makeEsp7Tps();
  const aiUnits = [];
  for (let i = 0; i < 8; i++) {
    aiUnits.push({
      nama: `Unit ${i + 1}`,
      tpKodes: tps.slice(i * 2, i * 2 + 2).map((t) => t.kode),
      bobot: 1,
      semester: i < 4 ? 1 : 2,
    });
  }
  const config = { totalJpTahun: 72, jpPerPertemuan: 2, jpPerMinggu: 2, mingguEfektif: { ganjil: 18, genap: 17 } };
  const { units } = buildUnits(aiUnits, tps, config, SUMATIF_ESP7);
  const prota = aggregateProta(units, SUMATIF_ESP7);
  const prosem = distributeProsem(units, SUMATIF_ESP7, config, 7);

  for (const row of prosem.semester1.rows) {
    const cellSum = row.cells.reduce((s, c) => s + c.jp, 0);
    assert.equal(cellSum, row.totalJp, `row ${row.materi} cells should sum to its totalJp`);
  }
  for (const row of prosem.semester2.rows) {
    const cellSum = row.cells.reduce((s, c) => s + c.jp, 0);
    assert.equal(cellSum, row.totalJp);
  }

  assert.equal(prosem.semester1.totalJp, prota.semester1.totalJp);
  assert.equal(prosem.semester2.totalJp, prota.semester2.totalJp);
  assert.equal(prosem.semester1.totalJp, 36);
  assert.equal(prosem.semester2.totalJp, 36);
});

test('distributeProsem: kelas 9 genap defaults to the shorter genapKelas9 week count when not overridden', () => {
  const tps = makeEsp7Tps().slice(0, 4);
  const aiUnits = [{ nama: 'Unit 1', tpKodes: tps.map((t) => t.kode), bobot: 1, semester: 2 }];
  const config = { totalJpTahun: 20, jpPerPertemuan: 2, jpPerMinggu: 2 }; // no mingguEfektif override
  const { units } = buildUnits(aiUnits, tps, config, []);
  const prosem = distributeProsem(units, [], config, 9);
  assert.equal(prosem.mingguEfektif.genap, 14);
});

// -------------------------------------------------------------
test('splitMeetings: per-meeting minutes sum exactly to jp * menitPerJp', () => {
  const unit = { jp: 8 };
  const config = { jpPerPertemuan: 2, menitPerJp: 40 };
  const { pertemuanCount, meetings } = splitMeetings(unit, config);
  assert.equal(pertemuanCount, 4);
  assert.equal(meetings.length, 4);
  for (const m of meetings) {
    const bucketSum = m.menit.opening + m.menit.memahami + m.menit.mengaplikasi + m.menit.merefleksi + m.menit.closing;
    assert.equal(bucketSum, m.menit.total);
    assert.equal(m.menit.total, m.jp * 40);
  }
  const totalJpAcrossMeetings = meetings.reduce((s, m) => s + m.jp, 0);
  assert.equal(totalJpAcrossMeetings, 8);
});

test('splitMeetings: respects menitPerJp=45 (KOSP override) and an uneven last meeting', () => {
  const unit = { jp: 5 };
  const config = { jpPerPertemuan: 2, menitPerJp: 45 };
  const { pertemuanCount, meetings } = splitMeetings(unit, config);
  assert.equal(pertemuanCount, 3); // ceil(5/2)
  assert.deepEqual(meetings.map((m) => m.jp), [2, 2, 1]);
  assert.equal(meetings[2].menit.total, 45); // last (odd) meeting = 1 JP * 45'
});

// -------------------------------------------------------------
// V2a #1 — canonical meeting math regression. Root cause of the pilot's
// "15 pertemuan" bug: splitMeetings() defaulted a missing jpPerPertemuan to
// 1 while stages/rpp.js and render/rpp.js defaulted to 2 — three different
// numbers for the same config knob. normalizeConfig() is now the ONE place
// that default lives (2), used everywhere.
// -------------------------------------------------------------
test('normalizeConfig: defaults jpPerPertemuan=2, menitPerJp=40, maxPertemuanPerUnit=4 when missing/invalid', () => {
  assert.deepEqual(normalizeConfig({}), { jpPerPertemuan: 2, menitPerJp: 40, maxPertemuanPerUnit: 4 });
  assert.deepEqual(normalizeConfig({ jpPerPertemuan: null, menitPerJp: 0, maxPertemuanPerUnit: -1 }),
    { jpPerPertemuan: 2, menitPerJp: 40, maxPertemuanPerUnit: 4 });
  assert.deepEqual(normalizeConfig({ jpPerPertemuan: 3, menitPerJp: 45, maxPertemuanPerUnit: 6 }),
    { jpPerPertemuan: 3, menitPerJp: 45, maxPertemuanPerUnit: 6 });
});

test('splitMeetings: a 15-JP unit with jpPerPertemuan UNSET uses the canonical default (2), never the old buggy default (1)', () => {
  const unit = { jp: 15 };
  const config = {}; // jpPerPertemuan intentionally omitted — this is exactly the pilot's bug scenario
  const { pertemuanCount, meetings } = splitMeetings(unit, config);
  assert.equal(pertemuanCount, 8); // ceil(15/2) = 8, NOT 15
  assert.notEqual(pertemuanCount, 15);
  assert.equal(computePertemuanCount(15, normalizeConfig(config).jpPerPertemuan), 8);

  // count * jpp must cover (>=) the total JP, and the header must show the
  // real total unchanged — the duration string derives from ONE triple, so
  // it can never show a mismatched pair of numbers (the old bug's
  // "15 Pertemuan x 2 JP @40' (Total 15 JP)" nonsense).
  assert.ok(pertemuanCount * 2 >= 15);
  const label = formatDurationLabel(unit.jp, 2, 40);
  assert.equal(label, '8 Pertemuan × 2 JP @40′ (Total 15 JP)');
});

// -------------------------------------------------------------
// V2a #2 — unit caps: buildUnits used to have a JP floor but no ceiling.
// -------------------------------------------------------------
test('buildUnits: a unit over (jpPerPertemuan x maxPertemuanPerUnit) JP is split into capped "Bagian" chunks', () => {
  // 16 TPs (as makeEsp7Tps below), grouped into just 2 AI-returned units
  // (8 TPs each) sharing all 72 JP evenly (36 JP/unit, no sumatif to
  // subtract) — each unit is well over the 8-JP cap (jpp=2 x maxPertemuan=4).
  const cpElemen = [
    { nama: 'Menyimak - Berbicara' }, { nama: 'Membaca - Memirsa' }, { nama: 'Menulis - Mempresentasikan' },
  ];
  const perElemen = [
    Array.from({ length: 6 }, (_, i) => ({ rumusan: `menyimak topik ${i + 1}`, bloom: 'C2' })),
    Array.from({ length: 5 }, (_, i) => ({ rumusan: `membaca topik ${i + 1}`, bloom: 'C2' })),
    Array.from({ length: 5 }, (_, i) => ({ rumusan: `menulis topik ${i + 1}`, bloom: 'C3' })),
  ];
  const tps = assignTpCodes(cpElemen, perElemen, 7).tps;
  assert.equal(tps.length, 16);

  const aiUnits = [
    { nama: 'Unit A', tpKodes: tps.slice(0, 8).map((t) => t.kode), bobot: 1, semester: 1 },
    { nama: 'Unit B', tpKodes: tps.slice(8, 16).map((t) => t.kode), bobot: 1, semester: 2 },
  ];
  const config = { totalJpTahun: 72, jpPerPertemuan: 2, maxPertemuanPerUnit: 4 }; // cap = 8 JP/unit

  const { units, errors } = buildUnits(aiUnits, tps, config, []);
  assert.deepEqual(errors, []);
  assert.ok(units.length >= 9, `expected >= 9 units after splitting, got ${units.length}`);
  for (const u of units) assert.ok(u.jp <= 8, `unit "${u.nama}" has ${u.jp} JP, expected <= 8`);

  const sumJp = units.reduce((s, u) => s + u.jp, 0);
  assert.equal(sumJp, 72); // still exact, splitting doesn't lose/gain JP

  const allUsed = units.flatMap((u) => u.tpKodes);
  assert.equal(allUsed.length, tps.length); // every TP still used exactly once
  assert.deepEqual([...new Set(allUsed)].sort(), tps.map((t) => t.kode).sort());

  // urutan is renumbered 1..N across the post-split list (no gaps/dupes).
  assert.deepEqual(units.map((u) => u.urutan), units.map((_, i) => i + 1));

  // "Bagian" naming convention on split chunks.
  assert.ok(units.some((u) => / — Bagian 2$/.test(u.nama)));
});

test('buildUnits: a TP-sparse unit that absorbs most of the year\'s JP never produces an empty-TP "Bagian" chunk', () => {
  // Reproduces a real V2a #9 (Kerangka Instan) offline finding: a CP whose
  // clause-splitting yields very few TPs (5) collapses into a SINGLE
  // draftUnits() group (its own "< 3 TPs merges into previous" rule leaves
  // no other unit to share JP with) that then absorbs ~all 108 JP for the
  // year — 13x over the 8-JP cap, but only 5 TPs exist to fill 13 chunks.
  const cpElemen = [{ nama: 'Menyimak - Berbicara' }];
  const perElemen = [Array.from({ length: 5 }, (_, i) => ({ rumusan: `topik ${i + 1}`, bloom: 'C2' }))];
  const tps = assignTpCodes(cpElemen, perElemen, 7).tps;
  assert.equal(tps.length, 5);

  const aiUnits = [{ nama: 'Menyimak - Berbicara', tpKodes: tps.map((t) => t.kode), bobot: 1, semester: 1 }];
  const config = { totalJpTahun: 108, jpPerPertemuan: 2, maxPertemuanPerUnit: 4 }; // cap = 8 JP/unit

  const { units, errors } = buildUnits(aiUnits, tps, config, []);
  assert.deepEqual(errors, []);

  // Never more chunks than there are TPs to fill them — no contentless unit.
  assert.ok(units.length <= tps.length, `expected <= ${tps.length} units, got ${units.length}`);
  for (const u of units) assert.ok(u.tpKodes.length >= 1, `unit "${u.nama}" has zero TPs`);

  const sumJp = units.reduce((s, u) => s + u.jp, 0);
  assert.equal(sumJp, 108); // still exact even when TP count (not JP cap) binds

  const allUsed = units.flatMap((u) => u.tpKodes);
  assert.deepEqual([...new Set(allUsed)].sort(), tps.map((t) => t.kode).sort());
});

// -------------------------------------------------------------
// V2a #9 — zero-AI "Kerangka Instan" draft builders.
// -------------------------------------------------------------
test('draftTpFromCp: produces at least one TP per non-empty elemen, guesses Bloom from verbs', () => {
  const cpElemen = [
    { nama: 'Menyimak - Berbicara', teks: 'Peserta didik mampu menjelaskan proses fotosintesis; peserta didik mampu menganalisis dampak perubahan iklim.' },
    { nama: 'Membaca - Memirsa', teks: 'Peserta didik mampu mengidentifikasi ide pokok bacaan sederhana.' },
    { nama: 'Elemen Kosong', teks: '' },
  ];
  const { tps, warnings } = draftTpFromCp(cpElemen, 7);
  const byElemen = (nama) => tps.filter((t) => t.elemen === nama);
  assert.ok(byElemen('Menyimak - Berbicara').length >= 1);
  assert.ok(byElemen('Membaca - Memirsa').length >= 1);
  assert.equal(byElemen('Elemen Kosong').length, 0);
  assert.ok(warnings.some((w) => w.includes('Elemen Kosong'))); // zero-TP elemen still warns, same as the AI path
  assert.ok(tps.every((t) => t.rumusan.startsWith('Peserta didik dapat')));
  assert.ok(tps.some((t) => t.bloom === 'C4')); // "menganalisis" -> C4
});

test('draftKktp: 1:1 with TPs, Interval kriteria auto-filled from konstanta interval + threshold', () => {
  const tps = [{ kode: 'D.7.1.1' }, { kode: 'D.7.1.2' }, { kode: 'D.7.2.1' }];
  const { kktps, warnings } = draftKktp(tps, { kktpThreshold: 78 });
  assert.equal(kktps.length, tps.length);
  assert.deepEqual(warnings, []);
  assert.ok(kktps.every((k) => k.metode === 'Interval'));
  assert.ok(kktps.every((k) => k.kriteria.includes('78')));
  assert.deepEqual(kktps.map((k) => k.tpKode), tps.map((t) => t.kode));
});

test('draftUnits: covers every TP exactly once, in consecutive 3-4-TP groups', () => {
  const tps = Array.from({ length: 14 }, (_, i) => ({
    kode: `D.7.1.${i + 1}`,
    elemen: i < 7 ? 'Elemen A' : 'Elemen B',
  }));
  const groups = draftUnits(tps, {});
  const allKodes = groups.flatMap((g) => g.tpKodes);
  assert.equal(allKodes.length, tps.length);
  assert.deepEqual(allKodes, tps.map((t) => t.kode)); // order preserved, no gaps/dupes
  // Each group has >= 3 TPs (a too-small trailing group merges into the
  // previous one rather than shipping a 1-2-TP unit) — the merged group can
  // exceed 4 as a documented consequence, so only the floor is asserted here.
  for (const g of groups) assert.ok(g.tpKodes.length >= 3, `group "${g.nama}" has ${g.tpKodes.length} TPs`);
  assert.ok(groups.some((g) => g.nama === 'Elemen A'));
});

test('draftRppSkeleton: correct pertemuan count/placeholders, consistent with splitMeetings', () => {
  const unit = { topik: 'Contoh Topik', jp: 6, jpPerPertemuan: 2 };
  const config = { jpPerPertemuan: 2, menitPerJp: 40 };
  const { pertemuanCount, content } = draftRppSkeleton(unit, config);
  assert.equal(pertemuanCount, 3); // ceil(6/2)
  assert.equal(content.pertemuan.length, 3);
  assert.ok(content.pertemuan.every((m) => m.opening === RPP_PLACEHOLDER));
  assert.equal(content.peserta_didik, RPP_PLACEHOLDER);
  assert.equal(content.materi_pelajaran, 'Contoh Topik');
});

// -------------------------------------------------------------
// flattenProsemRows — moved out of oneshot.js (V2a #7's "Susun ulang Prosem"
// fix reuses it from pipeline.js instead of duplicating it).
// -------------------------------------------------------------
test('flattenProsemRows: every distributeProsem() cell becomes one flat row, JP preserved', () => {
  const units = [{ id: 'u1', nama: 'Unit 1', jp: 4, semester: 1, urutan: 1, tpKodes: [], bobot: 1 }];
  const config = { jpPerMinggu: 2, mingguEfektif: { ganjil: 18, genap: 17 } };
  const computed = distributeProsem(units, [], config, 7);
  const rows = flattenProsemRows(computed);
  const sumJp = rows.reduce((s, r) => s + r.jp, 0);
  assert.equal(sumJp, 4);
  assert.ok(rows.every((r) => r.materi === 'Unit 1'));
});

// -------------------------------------------------------------
console.log(passed + ' test(s) passed.');
if (process.exitCode) {
  console.error('Some tests FAILED.');
} else {
  console.log('All tests passed.');
}
