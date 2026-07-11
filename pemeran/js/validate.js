// =============================================================
// Pemeran — validator (SOP §12.A "Dapat Diverifikasi Otomatis")
// -------------------------------------------------------------
// Pure functions over the spine; no DOM, no fetch. Each check returns
// an array of { level: 'ok'|'warn'|'error', pesan, area }. Used by the
// Ekspor screen's validator panel and by compact per-stage badges.
//
// The SOP (Panduan Teknis..., Bagian 12.A) lists 7 robot-checkable
// items; check #5 there ("Keterangan PROSEM harus ada di Kaldik") is
// intentionally SOFT here because this plan explicitly skips Kaldik
// (owner decision #6 — Prosem auto-distributes from yearly JP, no
// real school calendar). In its place we keep the CP-verbatim guard
// the plan's own Validator section calls out.
// =============================================================

import {
  aggregateProta, buildUnits, distributeProsem, splitMeetings,
  flattenProsemRows, computePertemuanCount,
} from './pipeline.js';

// area -> the stage screen where that area's data is edited (drives the
// validator panel's "↗ Buka tahap" jump button and the per-stage chips'
// click-to-open-filtered-panel behavior — V2a #7). 'data'/'header' both
// land on 'setup' or 'tp' depending on which fields the check actually
// touches; see each check's own stageId override below for finer cases.
const AREA_STAGE = {
  header: 'setup', data: 'tp', cp: 'cp', tp: 'tp', kktp: 'kktp',
  atp: 'atp', prosem: 'prosem', rpp: 'rpp',
};

// Additive-only result shape (keeps runValidator() backward-compatible —
// V2a #7): every finding now always carries `stageId`; `expected`/`actual`/
// `fix` are opt-in per-check extras layered on via `extra`.
function ok(pesan, area, extra) { return Object.assign({ level: 'ok', pesan, area, stageId: AREA_STAGE[area] || area }, extra || {}); }
function warn(pesan, area, extra) { return Object.assign({ level: 'warn', pesan, area, stageId: AREA_STAGE[area] || area }, extra || {}); }
function err(pesan, area, extra) { return Object.assign({ level: 'error', pesan, area, stageId: AREA_STAGE[area] || area }, extra || {}); }

function deepClone(x) { return JSON.parse(JSON.stringify(x)); }

// ---- deterministic fixes (V2a #7 — fix.apply(spine) is a PURE function:
// it receives a deep-cloned spine and returns a whole new spine; the caller
// (js/validatorPanel.js) commits the result via state.js's replaceSpine()).
// ---------------------------------------------------------------------------

/** "Normalkan ulang JP" — re-run buildUnits so ATP's unit JPs sum exactly to
 *  config.totalJpTahun again (buildUnits guarantees this by construction
 *  from each unit's stored bobot — this literally cannot fail to match
 *  unless totalJpTahun/sumatif itself is the thing that's wrong). */
function fixNormalizeJp(spine) {
  const s = deepClone(spine);
  const aiShape = (s.units || []).map((u) => ({ id: u.id, nama: u.nama, tpKodes: u.tpKodes, bobot: u.bobot, semester: u.semester }));
  const { units, errors } = buildUnits(aiShape, s.tps, s.config, s.sumatif);
  if (!errors.length && units) s.units = units;
  return s;
}

/** "Susun ulang Prosem" — re-run distributeProsem from the current
 *  units/sumatif/config, replacing spine.prosem.rows wholesale. */
function fixRebuildProsem(spine) {
  const s = deepClone(spine);
  const computed = distributeProsem(s.units, s.sumatif, s.config, s.header && s.header.kelas);
  s.prosem = Object.assign({}, s.prosem, { rows: flattenProsemRows(computed) });
  return s;
}

/** "Hitung ulang pertemuan" — recompute each RPP entry's pertemuanCount from
 *  its unit's current jp/jpPerPertemuan, padding new empty meeting slots or
 *  truncating extras so entry.content.pertemuan.length matches again
 *  (existing meeting content for indices that still exist is preserved). */
function fixRecomputeMeetingCounts(spine) {
  const s = deepClone(spine);
  s.rpps = (s.rpps || []).map((entry) => {
    const unit = entry.unit || {};
    const { pertemuanCount } = splitMeetings(unit, s.config);
    const newUnit = Object.assign({}, unit, { pertemuanCount });
    const pertemuan = Array.isArray(entry.content && entry.content.pertemuan) ? entry.content.pertemuan.slice() : [];
    while (pertemuan.length < pertemuanCount) pertemuan.push({ opening: '', memahami: '', mengaplikasi: '', merefleksi: '', closing: '' });
    if (pertemuan.length > pertemuanCount) pertemuan.length = pertemuanCount;
    return Object.assign({}, entry, { unit: newUnit, content: Object.assign({}, entry.content, { pertemuan }) });
  });
  return s;
}

// ---- 1. Header identik di semua dokumen ------------------------------------
export function checkHeader(spine) {
  const h = (spine && spine.header) || {};
  const required = [
    ['sekolah', 'Satuan Pendidikan'], ['mapel', 'Mata Pelajaran'], ['kelas', 'Kelas'],
    ['tahunAjaran', 'Tahun Ajaran'], ['guru', 'Guru'],
  ];
  const missing = required.filter(([k]) => !h[k]).map(([, label]) => label);
  if (missing.length) {
    return [err(`Data belum lengkap: ${missing.join(', ')} — semua dokumen memakai header yang sama, jadi ini wajib diisi dulu.`, 'header')];
  }
  return [ok('Header (satuan pendidikan, mapel, kelas, tahun ajaran, guru) lengkap dan konsisten di semua dokumen — semua dokumen membaca dari data yang sama.', 'header')];
}

// ---- 2. Tidak ada kode TP "yatim" di RPP/Prosem ----------------------------
export function checkTpNoOrphans(spine) {
  const tpKodes = new Set((spine.tps || []).map((t) => t.kode));
  const results = [];

  const unitTpKodes = new Set((spine.units || []).flatMap((u) => u.tpKodes || []));
  const orphanInUnits = [...unitTpKodes].filter((k) => !tpKodes.has(k));
  if (orphanInUnits.length) {
    results.push(err(`ATP mereferensikan kode TP yang tidak ada di daftar TP: ${orphanInUnits.join(', ')}`, 'atp'));
  }

  const rppOrphans = [];
  for (const r of (spine.rpps || [])) {
    for (const t of ((r.unit && r.unit.tpList) || [])) {
      if (t.kode && !tpKodes.has(t.kode)) rppOrphans.push(t.kode);
    }
  }
  if (rppOrphans.length) {
    results.push(err(`RPP mereferensikan kode TP yang tidak terdaftar: ${[...new Set(rppOrphans)].join(', ')}`, 'rpp'));
  }

  if (!results.length) {
    results.push(ok('Semua kode TP yang muncul di ATP dan RPP terdaftar di daftar TP — tidak ada kode "yatim".', 'tp'));
  }
  return results;
}

// ---- 3. Setiap TP punya minimal satu KKTP berpasangan ----------------------
export function checkKktpCoverage(spine) {
  const tps = spine.tps || [];
  if (!tps.length) return [warn('Belum ada TP untuk diperiksa cakupan KKTP-nya.', 'kktp')];
  const kktpByTp = new Map();
  for (const k of (spine.kktps || [])) {
    if (!k.tpKode) continue;
    kktpByTp.set(k.tpKode, (kktpByTp.get(k.tpKode) || 0) + 1);
    if (k.kode && !k.kode.startsWith('KKTP-' + k.tpKode)) {
      return [err(`Kode KKTP "${k.kode}" tidak berawalan "KKTP-${k.tpKode}" — perbaiki penomoran.`, 'kktp')];
    }
  }
  const missing = tps.filter((t) => !kktpByTp.has(t.kode)).map((t) => t.kode);
  if (missing.length) {
    return [err(`TP berikut belum punya KKTP: ${missing.join(', ')}`, 'kktp')];
  }
  return [ok('Setiap TP memiliki minimal satu KKTP dengan kode "KKTP-<kode TP>" yang benar.', 'kktp')];
}

// ---- 4. ΣJP: ATP = PROTA = Σ Prosem, per semester --------------------------
// Two independent sub-checks (kept as separate results, each tagged with the
// area it actually concerns) so an ATP-only problem doesn't hide behind a
// Prosem-only warning or vice versa — each stage's badge should reflect ONLY
// what that stage is responsible for.
export function checkJpConsistency(spine) {
  const units = spine.units || [];
  const sumatif = spine.sumatif || [];
  if (!units.length) return [warn('Belum ada unit ATP untuk diperiksa total JP-nya.', 'atp')];

  const prota = aggregateProta(units, sumatif);
  const results = [];

  // 4a. ATP+Sumatif total vs the official/KOSP allocation (spine.config.totalJpTahun).
  const totalJpTahun = Number(spine.config && spine.config.totalJpTahun);
  if (totalJpTahun > 0 && prota.totalJpTahun !== totalJpTahun) {
    const diff = prota.totalJpTahun - totalJpTahun;
    results.push(err(
      `Total JP ATP+Sumatif (${prota.totalJpTahun}) tidak sama dengan alokasi resmi (${totalJpTahun} JP/tahun) — ${diff > 0 ? 'kelebihan' : 'kurang'} ${Math.abs(diff)} JP.`,
      'atp',
      { expected: totalJpTahun, actual: prota.totalJpTahun, fix: { label: 'Normalkan ulang JP', apply: fixNormalizeJp } },
    ));
  } else {
    results.push(ok(`Total JP ATP = Prota (Ganjil ${prota.semester1.totalJp} JP, Genap ${prota.semester2.totalJp} JP, Total ${prota.totalJpTahun} JP)${totalJpTahun > 0 ? ' — sesuai alokasi resmi' : ''}.`, 'atp'));
  }

  // 4b. Prosem's own rows vs ATP/Prota (only meaningful once Prosem exists).
  const prosemRows = (spine.prosem && spine.prosem.rows) || [];
  if (!prosemRows.length) {
    results.push(warn('Prosem belum dibuat — belum bisa memverifikasi ΣJP Prosem terhadap ATP/Prota.', 'prosem'));
  } else {
    let prosemOk = true;
    for (const sem of [1, 2]) {
      const prosemSum = prosemRows.filter((r) => Number(r.semester) === sem).reduce((s, r) => s + (Number(r.jp) || 0), 0);
      const protaSum = sem === 1 ? prota.semester1.totalJp : prota.semester2.totalJp;
      if (prosemSum !== protaSum) {
        prosemOk = false;
        const diff = prosemSum - protaSum;
        results.push(err(
          `Semester ${sem === 1 ? 'Ganjil' : 'Genap'}: total JP Prosem (${prosemSum}) ≠ total JP ATP/Prota (${protaSum}) — ${diff > 0 ? 'kelebihan' : 'kurang'} ${Math.abs(diff)} JP.`,
          'prosem',
          { expected: protaSum, actual: prosemSum, fix: { label: 'Susun ulang Prosem', apply: fixRebuildProsem } },
        ));
      }
    }
    if (prosemOk) results.push(ok('Σ JP Prosem = total JP ATP/Prota di kedua semester.', 'prosem'));
  }

  return results;
}

// ---- 5. Menit per pertemuan RPP = jp × menitPerJp --------------------------
export function checkRppMinutes(spine) {
  const menitPerJp = Number(spine.config && spine.config.menitPerJp) > 0 ? Number(spine.config.menitPerJp) : 40;
  const rpps = spine.rpps || [];
  if (!rpps.length) return [warn('Belum ada RPP untuk diperiksa alokasi menitnya.', 'rpp')];

  const problems = [];
  for (const entry of rpps) {
    const unit = entry.unit || {};
    const pertemuan = (entry.content && entry.content.pertemuan) || [];
    const jpp = Number(unit.jpPerPertemuan) > 0 ? Number(unit.jpPerPertemuan) : 2;
    const totalJp = Number(unit.jp) || 0;
    const count = pertemuan.length || computePertemuanCount(totalJp, jpp);
    // We only have coarse content here (M2/M3 storage doesn't persist a
    // per-meeting minute breakdown inside spine.rpps yet) — check what we
    // CAN check: pertemuanCount matches jp/jpPerPertemuan (SOP §10.4 rule
    // "Pertemuan i dari N" must cover the unit's JP exactly).
    const expectedCount = computePertemuanCount(totalJp, jpp);
    if (count !== expectedCount) {
      problems.push({
        pesan: `RPP "${unit.topik || '(tanpa judul)'}": jumlah pertemuan (${count}) tidak sesuai JP unit ÷ JP/pertemuan (seharusnya ${expectedCount}) — ${count > expectedCount ? 'kelebihan' : 'kurang'} ${Math.abs(count - expectedCount)} pertemuan.`,
        expected: expectedCount,
        actual: count,
      });
    }
  }
  if (problems.length) {
    return problems.map((p) => err(p.pesan, 'rpp', {
      expected: p.expected, actual: p.actual,
      fix: { label: 'Hitung ulang pertemuan', apply: fixRecomputeMeetingCounts },
    }));
  }
  return [ok(`Jumlah pertemuan tiap RPP sesuai total JP unit ÷ JP/pertemuan (1 JP = ${menitPerJp} menit).`, 'rpp')];
}

// ---- 6. Tidak ada sel kosong pada kolom wajib -------------------------------
export function checkNoEmptyMandatory(spine) {
  const problems = [];
  for (const t of (spine.tps || [])) {
    if (!t.kode) problems.push('Ada TP tanpa kode.');
    if (!t.rumusan || !t.rumusan.trim()) problems.push(`TP ${t.kode || '?'}: rumusan kosong.`);
    if (!t.bloom) problems.push(`TP ${t.kode || '?'}: level Bloom belum dipilih.`);
  }
  for (const k of (spine.kktps || [])) {
    if (!k.kriteria || !k.kriteria.trim() || k.kriteria === '(belum diisi)') {
      problems.push(`${k.kode || '?'}: kriteria kosong.`);
    }
  }
  for (const u of (spine.units || [])) {
    if (!u.nama || !u.nama.trim()) problems.push('Ada unit ATP tanpa nama.');
    if (!(Number(u.jp) > 0)) problems.push(`Unit "${u.nama || '?'}": JP belum terisi.`);
    if (!u.tpKodes || !u.tpKodes.length) problems.push(`Unit "${u.nama || '?'}": belum berisi TP.`);
  }
  if (problems.length) return problems.slice(0, 15).map((p) => err(p, 'data'));
  return [ok('Tidak ada sel kosong pada kolom wajib (kode TP, JP, kompetensi/rumusan).', 'data')];
}

// ---- 7. Teks CP dipakai verbatim (guard against later hand-edit drift) ----
export function checkCpVerbatim(spine) {
  const elemenNames = new Set((spine.cp && spine.cp.elemen || []).map((e) => e.nama));
  if (!elemenNames.size) return [warn('CP belum diisi.', 'cp')];
  const bad = (spine.tps || []).filter((t) => t.elemen && !elemenNames.has(t.elemen)).map((t) => t.kode);
  if (bad.length) {
    return [err(`TP berikut merujuk nama elemen CP yang tidak ada di CP tersimpan (kemungkinan CP diedit setelah TP dibuat): ${bad.join(', ')}`, 'cp')];
  }
  const sumberOk = spine.cp.redaksi === 'kontekstual' ? true : !!spine.cp.sumber;
  if (!sumberOk) {
    return [warn('CP nasional belum mencantumkan sumber rujukan (Kepka BSKAP).', 'cp')];
  }
  return [ok('Nama elemen CP yang dirujuk TP cocok persis dengan CP tersimpan (tidak ada drift setelah CP diedit).', 'cp')];
}

/** Run every check and return the flat combined list. */
export function runValidator(spine) {
  const s = spine || {};
  return [
    ...checkHeader(s),
    ...checkTpNoOrphans(s),
    ...checkKktpCoverage(s),
    ...checkJpConsistency(s),
    ...checkRppMinutes(s),
    ...checkNoEmptyMandatory(s),
    ...checkCpVerbatim(s),
  ];
}

/** Worst level present ('error' > 'warn' > 'ok') — drives export-button gating. */
export function overallLevel(results) {
  if (results.some((r) => r.level === 'error')) return 'error';
  if (results.some((r) => r.level === 'warn')) return 'warn';
  return 'ok';
}

/** Compact per-stage badge: run only the checks relevant to one area. */
export function badgeForArea(spine, area) {
  const all = runValidator(spine).filter((r) => r.area === area);
  return { level: overallLevel(all), count: all.length, results: all };
}

const BADGE_BG = { ok: 'var(--good-soft)', warn: 'var(--warn-soft)', error: 'var(--bad-soft)' };
const BADGE_FG = { ok: 'var(--good)', warn: 'var(--warn)', error: 'var(--bad)' };
const BADGE_ICON = { ok: '✓', warn: '⚠', error: '✗' };

/**
 * A small `<span class="chip">` a stage screen can drop next to its heading,
 * summarizing just the checks relevant to that stage's `area`. Returns ''
 * (render nothing) when there's nothing to check yet, so early/empty stages
 * don't show a misleading badge.
 */
export function badgeHtml(spine, area) {
  const badge = badgeForArea(spine, area);
  if (!badge.count) return '';
  const label = badge.level === 'ok' ? 'Validator: lolos' : badge.level === 'warn' ? 'Validator: perhatian' : 'Validator: ada kesalahan';
  const title = badge.results.map((r) => r.pesan).join(' | ').replace(/"/g, '&quot;');
  // A <button>, not a <span> (V2a #7 — "make the per-stage validator chips
  // clickable"): wireValidatorChips() below wires every element matching
  // .validator-chip[data-validator-area] to jump to the filtered panel.
  return `<button type="button" class="chip validator-chip" data-validator-area="${area}" title="${title}" style="background:${BADGE_BG[badge.level]}; color:${BADGE_FG[badge.level]};">${BADGE_ICON[badge.level]} ${label}</button>`;
}

const VALIDATOR_FOCUS_KEY = 'pemeran_validator_focus_area';

/**
 * Wire every badgeHtml() chip inside `container` to jump to the Ekspor
 * screen's validator panel, pre-filtered/scrolled to that chip's area.
 * Stage screens call this once after inserting a badgeHtml() chip into the
 * DOM. Uses sessionStorage (read back via takeValidatorFocusArea()) rather
 * than a hash query string because wizard.js's router does an exact
 * STAGE_MODULES[hash] lookup — "#/ekspor?area=atp" wouldn't resolve.
 */
export function wireValidatorChips(container) {
  if (!container || !container.querySelectorAll) return;
  container.querySelectorAll('.validator-chip[data-validator-area]').forEach((chip) => {
    chip.addEventListener('click', () => {
      try { sessionStorage.setItem(VALIDATOR_FOCUS_KEY, chip.getAttribute('data-validator-area')); } catch (e) { /* ignore */ }
      location.hash = '#/ekspor';
    });
  });
}

/** One-shot read: the Ekspor screen calls this on mount to see if it should
 *  scroll to / highlight one area's findings (set by wireValidatorChips()
 *  above, or by the validator panel's own "↗ Buka tahap" jump for an area
 *  whose stageId happens to be 'ekspor' itself). Clears itself after reading
 *  so it doesn't stick around across unrelated later visits. */
export function takeValidatorFocusArea() {
  try {
    const v = sessionStorage.getItem(VALIDATOR_FOCUS_KEY);
    sessionStorage.removeItem(VALIDATOR_FOCUS_KEY);
    return v;
  } catch (e) {
    return null;
  }
}
