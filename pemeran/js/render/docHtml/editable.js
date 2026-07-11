// =============================================================
// Pemeran — shared in-preview editable engine (V2b #6)
// -------------------------------------------------------------
// Extracted + generalized from stages/rpp.js's wireEditableCells() +
// serializeCellToMiniSyntax() (V2a #5, RPP-only). Any renderer that emits
// `data-marker="3" data-field="..."` cells into an iframe's document can
// now reuse this exact decoration/serialization logic instead of
// reimplementing it — see stages/rpp.js (refactored to call this),
// stages/atp.js (Prota preview: unit_nama__<i>/unit_jp__<i>), and
// stages/dokumen.js (TP&KKTP preview: tp_rumusan__<i>/kktp_kriteria__<i>).
//
// What this owns: contenteditable decoration, an optional per-field 🔄
// regenerate button, debounced-input + blur commit (mini-syntax
// serialization of the edited DOM back into a plain string), and
// checkbox-list click-to-toggle. What it does NOT own: persistence (the
// caller's writeField/writeCheckbox do that) or re-rendering (see the
// caret-preservation note below).
//
// ⚠ Caret-preservation note (plan's Opus-fallback flag): this module does
// NOT attempt a fully reactive "patch the live DOM under an active caret"
// loop. The safe rule it follows instead — call it the "blur-only safe
// version" the plan allows as a fallback — is: the pane currently being
// edited is only ever re-rendered by an explicit user action (a 🔄
// regenerate click, switching tabs, navigating away and back); recompute.js
// and the stage modules that call this are responsible for only
// refreshing SIBLING panes/validator chips on every edit, never the pane
// with the caret in it. This avoids caret loss without needing a real
// DOM-diffing reactive renderer. Flagging for Opus review per the plan.
// =============================================================

function itemShortLabel(dataItem) {
  const s = String(dataItem || '');
  const idx = s.indexOf(' / ');
  return (idx >= 0 ? s.slice(0, idx) : s).trim();
}

// ---- rich-text mini-syntax DOM -> text serializer --------------------------
// Best-effort reverse of docHtml/richTextHtml.js's forward parser: walks
// the (possibly hand-edited) cell DOM and reconstructs the ✓/•/-/o/N.
// line-prefix + **bold**/*italic* mini-syntax it started from.
const NBSP_RE = / /g;

function inlineNodeToMiniSyntax(node) {
  let out = '';
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue;
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName;
      if (tag === 'STRONG' || tag === 'B') {
        out += '**' + inlineNodeToMiniSyntax(child).trim() + '**';
      } else if (tag === 'EM' || tag === 'I') {
        out += '*' + inlineNodeToMiniSyntax(child).trim() + '*';
      } else if (tag === 'BR') {
        out += '\n';
      } else {
        out += inlineNodeToMiniSyntax(child);
      }
    }
  });
  return out;
}

function stripLinePrefix(rawLine) {
  const t = rawLine.replace(NBSP_RE, ' ');
  let m;
  if ((m = t.match(/^\s*✓\s+([\s\S]*)$/))) return '✓ ' + m[1].trim();
  if ((m = t.match(/^\s*[•\-]\s+([\s\S]*)$/))) return '• ' + m[1].trim();
  if ((m = t.match(/^\s*[○o]\s+([\s\S]*)$/))) return 'o ' + m[1].trim();
  if ((m = t.match(/^\s*(\d+)\.\s+([\s\S]*)$/))) return m[1] + '. ' + m[2].trim();
  return t.trim();
}

/** Serialize one editable cell's current DOM back into the mini-syntax
 *  string the field it maps to actually stores. */
export function serializeCellToMiniSyntax(cellEl) {
  const clone = cellEl.cloneNode(true);
  clone.querySelectorAll('.pemeran-regen-btn').forEach((b) => b.remove());

  const blockChildren = Array.from(clone.children).filter((c) => ['P', 'DIV', 'LI'].includes(c.tagName));
  if (blockChildren.length) {
    return blockChildren
      .map((el) => stripLinePrefix(inlineNodeToMiniSyntax(el)))
      .filter((l) => l.length)
      .join('\n');
  }
  // No block children — plain text / <br>-separated lines typed directly
  // into a cell that started out empty or as a single text node.
  return inlineNodeToMiniSyntax(clone)
    .split('\n')
    .map((l) => stripLinePrefix(l))
    .filter((l) => l.length)
    .join('\n');
}

const EDITABLE_STYLE = `
  .pemeran-editable{ outline-offset:1px; cursor:text; }
  .pemeran-editable:hover{ outline:1.5px dashed #146b64; }
  .pemeran-editable:focus{ outline:1.5px solid #146b64; background:#f5fbfa; }
  .pemeran-regen-btn{
    position:absolute; top:1px; right:1px; z-index:5;
    border:none; background:#fff; border-radius:999px; width:18px; height:18px;
    font-size:10px; line-height:18px; padding:0; cursor:pointer; text-align:center;
    box-shadow:0 1px 3px rgba(0,0,0,0.3); opacity:0.55;
  }
  .pemeran-regen-btn:hover{ opacity:1; }
  ul.checkbox-list li{ cursor:pointer; }
  @media print{ .pemeran-regen-btn{ display:none !important; } }
`;

/**
 * Decorate every `[data-marker="3"][data-field]` cell (and every
 * `ul.checkbox-list[data-field]`) inside `iframe`'s document with
 * contenteditable + optional 🔄 regenerate + debounced commit.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {object} opts
 * @param {(baseField:string, itemIndex:number|null, value:string) => void} opts.writeField
 *        called with the field's base name (the part before "__N", or the
 *        whole name when there's no suffix), the absolute "__N" index (or
 *        null when the field carries no such suffix — a unit-level field),
 *        and the freshly-serialized text, on debounced input AND on blur.
 * @param {(baseField:string, selectedLabels:string[]) => void} [opts.writeCheckbox]
 *        called with a checkbox-list's field name + the selected items'
 *        short labels whenever one is toggled.
 * @param {(baseField:string, itemIndex:number|null) => void} [opts.onRegen]
 *        called when a cell's 🔄 button is clicked. Omit to skip rendering
 *        the button at all (some renderers have no regenerate action).
 * @param {(baseField:string) => string} [opts.fieldLabel]  human label for a
 *        base field name, used in the 🔄 button's tooltip.
 * @param {Set<string>|string[]} [opts.skipFields]  base field names to
 *        leave completely alone (not made editable at all) — e.g. rpp.js's
 *        derived `tujuan_pembelajaran` field.
 */
export function wireEditable(iframe, opts) {
  opts = opts || {};
  const doc = iframe.contentDocument;
  if (!doc || !opts.writeField) return;

  const style = doc.createElement('style');
  style.textContent = EDITABLE_STYLE;
  doc.head.appendChild(style);

  const skipFields = new Set(opts.skipFields || []);

  // ---- checkbox-list fields ----
  Array.from(doc.querySelectorAll('ul.checkbox-list[data-field]')).forEach((ul) => {
    const baseField = ul.getAttribute('data-field');
    Array.from(ul.querySelectorAll('li[data-item]')).forEach((li) => {
      li.addEventListener('click', () => {
        const chk = li.querySelector('.chk');
        if (!chk) return;
        chk.textContent = chk.textContent.trim() === '☑' ? '☐' : '☑';
        const selected = Array.from(ul.querySelectorAll('li[data-item]'))
          .filter((x) => { const c = x.querySelector('.chk'); return c && c.textContent.trim() === '☑'; })
          .map((x) => itemShortLabel(x.getAttribute('data-item')));
        if (opts.writeCheckbox) opts.writeCheckbox(baseField, selected);
      });
    });
  });

  // ---- editable content cells ----
  const cells = Array.from(doc.querySelectorAll('[data-marker="3"][data-field]'));
  for (const cell of cells) {
    if (cell.classList.contains('checkbox-list')) continue;
    const rawField = cell.getAttribute('data-field');
    if (!rawField || skipFields.has(rawField)) continue;
    const m = rawField.match(/^(.+)__(\d+)$/);
    const baseField = m ? m[1] : rawField;
    const itemIndex = m ? Number(m[2]) : null;

    cell.setAttribute('contenteditable', 'true');
    cell.classList.add('pemeran-editable');
    cell.style.position = 'relative';

    if (opts.onRegen) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'pemeran-regen-btn';
      btn.textContent = '\u{1F504}';
      btn.title = 'Regenerasi bagian "' + (opts.fieldLabel ? opts.fieldLabel(baseField) : baseField) + '" dengan AI';
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        opts.onRegen(baseField, itemIndex);
      });
      cell.appendChild(btn);
    }

    let debounceTimer = null;
    const commit = () => {
      const text = serializeCellToMiniSyntax(cell);
      opts.writeField(baseField, itemIndex, text);
    };
    cell.addEventListener('input', () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(commit, 300);
    });
    cell.addEventListener('blur', () => {
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
      commit();
    });
  }
}
