// =============================================================
// Pemeran — shared validator panel + export-confirm-sheet UI (V2a #6, #7)
// -------------------------------------------------------------
// Two small, self-contained DOM widgets shared by stages/dokumen.js and
// stages/rpp.js (both need "here are the findings, fix or jump to them"
// and "export is blocked by errors — confirm anyway?" UI, and duplicating
// either one across both files would drift):
//
//   renderValidatorPanel(panelEl, opts)
//     Full interactive findings list (grouped error/warn/ok) with, per
//     finding, an "⚡ <fix label>" button (when the finding carries a
//     deterministic fix — see validate.js) and an "↗ Buka tahap" jump
//     button. Re-renders itself in place after a fix is applied.
//
//   withExportGate(action)
//     Replaces the old "grey out every export button on any error"
//     pattern (root cause: a dead-end tooltip with zero recourse). Export
//     buttons are now ALWAYS enabled; clicking one runs the validator and,
//     only if there's an error-level finding, shows a confirm sheet
//     listing the actual findings with "Tetap ekspor" / "Perbaiki dulu"
//     before proceeding. Warn-level findings never block anything.
// =============================================================

import { state, replaceSpine } from './state.js';
import { toast } from './api.js';
import { runValidator, overallLevel } from './validate.js';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const LEVEL_ICON = { ok: '✓', warn: '⚠', error: '✗' };
const LEVEL_BG = { ok: 'var(--good-soft)', warn: 'var(--warn-soft)', error: 'var(--bad-soft)' };
const LEVEL_FG = { ok: 'var(--good)', warn: 'var(--warn)', error: 'var(--bad)' };

/**
 * Render the full interactive validator panel into `panelEl`.
 * @param {HTMLElement} panelEl
 * @param {object} [opts]
 * @param {() => void} [opts.onChange]  called after a fix is successfully
 *        applied (so the caller can re-render its own doc list/preview —
 *        the panel itself always re-renders in place regardless).
 * @param {string} [opts.focusArea]  when set, that area's findings are
 *        scrolled into view and briefly highlighted (used by dokumen.js's
 *        "jump here from a stage's validator chip" flow).
 * @returns {{ results: Array, level: string }}
 */
export function renderValidatorPanel(panelEl, opts) {
  opts = opts || {};
  const results = runValidator(state.spine);
  const level = overallLevel(results);
  const grouped = { error: [], warn: [], ok: [] };
  results.forEach((r) => grouped[r.level].push(r));

  const rowsHtml = ['error', 'warn', 'ok'].flatMap((lv) => grouped[lv].map((r, idx) => {
    const key = lv + '-' + idx;
    const highlight = opts.focusArea && r.area === opts.focusArea;
    return `
      <div class="row-between validator-row" data-key="${key}" data-area="${escapeHtml(r.area || '')}"
           style="gap:8px; align-items:flex-start; padding:8px 4px; border-bottom:1px solid var(--line);${highlight ? ' background:var(--accent-soft); border-radius:8px;' : ''}">
        <div style="display:flex; gap:8px; align-items:flex-start; flex:1;">
          <span style="color:${LEVEL_FG[lv]}; font-weight:700;">${LEVEL_ICON[lv]}</span>
          <span>${escapeHtml(r.pesan)}</span>
        </div>
        <div class="row" style="gap:4px; flex-shrink:0;">
          ${r.fix ? `<button type="button" class="btn btn-outline btn-sm" data-fix="${key}">⚡ ${escapeHtml(r.fix.label)}</button>` : ''}
          ${r.stageId ? `<button type="button" class="btn btn-ghost btn-sm" data-jump="${escapeHtml(r.stageId)}">↗ Buka tahap</button>` : ''}
        </div>
      </div>
    `;
  })).join('');

  panelEl.innerHTML = `
    <div class="row-between">
      <h3 style="margin:0;">Validator (SOP §12.A)</h3>
      <span class="chip" style="background:${LEVEL_BG[level]}; color:${LEVEL_FG[level]};">
        ${level === 'ok' ? '✓ Semua pemeriksaan lolos' : level === 'warn' ? '⚠ Ada peringatan' : '✗ Ada kesalahan'}
      </span>
    </div>
    <div class="stack" style="margin-top:var(--space-3); gap:0;">${rowsHtml}</div>
  `;

  const byKey = new Map();
  ['error', 'warn', 'ok'].forEach((lv) => grouped[lv].forEach((r, idx) => byKey.set(lv + '-' + idx, r)));

  panelEl.querySelectorAll('[data-fix]').forEach((btn) => {
    const finding = byKey.get(btn.getAttribute('data-fix'));
    if (!finding || !finding.fix) return;
    btn.addEventListener('click', async () => {
      const label = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Memperbaiki…';
      try {
        const mutated = finding.fix.apply(JSON.parse(JSON.stringify(state.spine)));
        replaceSpine(mutated);
        toast('Perbaikan diterapkan: ' + finding.fix.label);
        renderValidatorPanel(panelEl, opts);
        if (opts.onChange) opts.onChange();
      } catch (e) {
        toast('Gagal menerapkan perbaikan: ' + String((e && e.message) || e), { error: true });
        btn.disabled = false;
        btn.textContent = label;
      }
    });
  });

  panelEl.querySelectorAll('[data-jump]').forEach((btn) => {
    btn.addEventListener('click', () => { location.hash = '#/' + btn.getAttribute('data-jump'); });
  });

  if (opts.focusArea) {
    const target = panelEl.querySelector(`.validator-row[data-area="${CSS && CSS.escape ? CSS.escape(opts.focusArea) : opts.focusArea}"]`);
    if (target && target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return { results, level };
}

/**
 * Confirm sheet listing error-level findings, "Tetap ekspor" / "Perbaiki
 * dulu". Resolves `true` (proceed) or `false` (teacher chose to go fix
 * things first — already navigated to the first finding's stage).
 */
export function confirmExportWithFindings(results) {
  return new Promise((resolve) => {
    const errors = results.filter((r) => r.level === 'error');
    const overlay = document.createElement('div');
    overlay.innerHTML = `
      <div style="position:fixed; inset:0; z-index:2100; background:rgba(43,36,32,0.55); display:flex; align-items:center; justify-content:center; padding:24px;">
        <div class="card card-pad-lg" style="max-width:540px; width:100%;">
          <h3 style="margin:0 0 8px;">${errors.length} hal perlu diperiksa sebelum ekspor</h3>
          <p class="muted small" style="margin:0 0 8px;">Validator menemukan kesalahan berikut. Anda tetap bisa mengekspor sekarang — perbaiki nanti di tahap Dokumen.</p>
          <div class="stack" style="margin-bottom:var(--space-3); max-height:40vh; overflow:auto; gap:0;">
            ${errors.map((r) => `<div style="padding:6px 0; border-bottom:1px solid var(--line);">✗ ${escapeHtml(r.pesan)}</div>`).join('')}
          </div>
          <div class="row-between">
            <button type="button" class="btn btn-outline" id="btn-fix-first">Perbaiki dulu</button>
            <button type="button" class="btn btn-primary" id="btn-export-anyway">Tetap ekspor</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#btn-export-anyway').addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.querySelector('#btn-fix-first').addEventListener('click', () => {
      overlay.remove();
      const first = errors[0];
      location.hash = '#/' + (first && first.stageId ? first.stageId : 'dokumen');
      resolve(false);
    });
  });
}

/**
 * Gate any export action behind the confirm sheet — but ONLY when there's
 * an error-level finding (warn-level never blocks). Export buttons
 * themselves are never `disabled` anymore (V2a #6); this is the
 * replacement UX for the old hard block.
 * @param {() => (void | Promise<void>)} action
 */
export async function withExportGate(action) {
  const results = runValidator(state.spine);
  const level = overallLevel(results);
  if (level === 'error') {
    const proceed = await confirmExportWithFindings(results);
    if (!proceed) return;
  }
  return action();
}
