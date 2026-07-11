// =============================================================
// Pemeran — central recompute point (V2b #7)
// -------------------------------------------------------------
// Everything this module touches is DERIVED data — nothing here is a new
// source of truth (spine.tps/units/sumatif/config remain that), so calling
// recompute() redundantly, or from multiple stages, is always safe
// (idempotent). It exists so a mutation made on ONE stage (e.g. a config
// edit on the Data stage) doesn't leave STALE derived numbers sitting in
// spine.prosem.rows or a cached RPP entry's meeting-count bookkeeping until
// the teacher happens to revisit the stage that owns that view.
//
// What it recomputes:
//   - spine.prosem.rows — re-run distributeProsemWithOverrides() (manually
//     moved rows, per V2b #4, are preserved; only non-overridden/stale rows
//     actually change) whenever units exist.
//   - each spine.rpps[] entry's cached unit.pertemuanCount/jpPerPertemuan
//     bookkeeping (splitMeetings() is otherwise always called fresh
//     elsewhere for the ACTUAL math — this only keeps the small cached
//     copies RPP entries carry from going stale after e.g. a jpPerPertemuan
///    edit on the Data stage).
//
// What it deliberately does NOT do: touch spine.rpps[].content.pertemuan
// (the actual meeting text) — a pertemuanCount mismatch there is exactly
// what validate.js's checkRppMinutes + its "Hitung ulang pertemuan" fix
// (fixRecomputeMeetingCounts) already surfaces as a validator hint with a
// one-click normalize, per the plan's "never silently rewrite a
// user-entered number" rule. Prota/duration-label numbers are already pure
// functions of units/config everywhere they're displayed (pipeline.js's
// aggregateProta/formatDurationLabel/splitMeetings), so there is nothing to
// cache-invalidate for those — they can't go stale by construction.
//
// recompute() itself never touches the DOM. Callers (stage modules) decide
// what to re-render — per render/docHtml/editable.js's caret-preservation
// rule, only SIBLING panes, never the one currently being edited.
// =============================================================

import { state, setProsem, setRpps } from './state.js';
import { distributeProsemWithOverrides, flattenProsemRows, splitMeetings, normalizeConfig } from './pipeline.js';

export function recompute() {
  const { units, sumatif, config, header, prosem, rpps } = state.spine;

  if (Array.isArray(units) && units.length) {
    const computed = distributeProsemWithOverrides(units, sumatif, config, header.kelas, prosem.overrides);
    setProsem({ rows: flattenProsemRows(computed) });
  }

  if (Array.isArray(rpps) && rpps.length) {
    const { jpPerPertemuan } = normalizeConfig(config);
    let changed = false;
    const nextRpps = rpps.map((entry) => {
      const unit = entry.unit || {};
      const { pertemuanCount } = splitMeetings(unit, config);
      if (pertemuanCount === unit.pertemuanCount && jpPerPertemuan === unit.jpPerPertemuan) return entry;
      changed = true;
      return Object.assign({}, entry, { unit: Object.assign({}, unit, { pertemuanCount, jpPerPertemuan }) });
    });
    if (changed) setRpps(nextRpps);
  }
}

let debounceTimer = null;
/** Debounced (~300ms) wrapper — stage modules call this on every keystroke
 *  of a config field rather than calling recompute() directly, so a fast
 *  typist doesn't trigger a re-derivation (and a save) on every character. */
export function scheduleRecompute() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(recompute, 300);
}
