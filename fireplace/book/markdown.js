/* ═══════════════════════════════════════════════════════════════
   Fireplace · The Book — markdown.js
   Typora-style live renderer: on input (debounced), the block
   containing the caret is re-parsed and re-rendered, with markdown
   markers wrapped in <span class="md-marker"> so they stay visible
   but dimmed. Caret position is preserved across the re-render
   using a character-offset save/restore.

   Supported subset (v1):
     # H1, ## H2, ### H3
     > blockquote
     - list item, 1. list item   (rendered as paragraphs with a
                                   styled bullet marker)
     **bold**, *italic*, `code`, [text](url)

   Block type can change on edit (e.g. typing "# " at the start of a
   paragraph turns it into an <h1>). The block element is replaced
   in-place when its tag changes.
   ═══════════════════════════════════════════════════════════════ */

(() => {
'use strict';

const TextFlow = document.getElementById('text-flow');
if (!TextFlow) return;

// ─────────── tiny html-escape ───────────
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function marker(s) {
  return `<span class="md-marker">${esc(s)}</span>`;
}

// ─────────── inline parser ───────────
// Stash code / links / bold first (highest precedence), then italic
// runs only on text that's free of those constructs. Restore in reverse.
function parseInline(text) {
  let s = esc(text);

  const codeStash = [];
  s = s.replace(/`([^`\n]+)`/g, (_, inner) => {
    codeStash.push(inner);
    return `C${codeStash.length - 1}`;
  });

  const linkStash = [];
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, t, u) => {
    linkStash.push({ t, u });
    return `L${linkStash.length - 1}`;
  });

  const boldStash = [];
  s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => {
    boldStash.push(inner);
    return `B${boldStash.length - 1}`;
  });

  // single * italics — only on text free of stashed sentinels
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_, inner) =>
    marker('*') + `<em>${inner}</em>` + marker('*'));

  // restore bold
  s = s.replace(/B(\d+)/g, (_, i) =>
    marker('**') + `<strong>${boldStash[+i]}</strong>` + marker('**'));

  // restore links
  s = s.replace(/L(\d+)/g, (_, i) => {
    const { t, u } = linkStash[+i];
    const eu = esc(u);
    return marker('[') + `<a href="${eu}">${esc(t)}</a>` + marker('](') + eu + marker(')');
  });

  // restore code
  s = s.replace(/C(\d+)/g, (_, i) =>
    marker('`') + `<code>${esc(codeStash[+i])}</code>` + marker('`'));

  return s;
}

// ─────────── block parser ───────────
function parseBlock(text) {
  const heading = text.match(/^(#{1,3}) (.*)$/);
  if (heading) {
    const level = heading[1].length;
    return {
      tag: 'h' + level,
      html: marker(heading[1] + ' ') + parseInline(heading[2])
    };
  }
  const bq = text.match(/^> (.*)$/);
  if (bq) {
    return { tag: 'blockquote', html: marker('> ') + parseInline(bq[1]) };
  }
  const ul = text.match(/^- (.*)$/);
  if (ul) {
    return {
      tag: 'p',
      html: `<span class="md-marker md-bullet">- </span>` + parseInline(ul[1])
    };
  }
  const ol = text.match(/^(\d+\.) (.*)$/);
  if (ol) {
    return {
      tag: 'p',
      html: `<span class="md-marker md-bullet">${esc(ol[1])} </span>` + parseInline(ol[2])
    };
  }
  return { tag: 'p', html: text.length ? parseInline(text) : '<br>' };
}

// ─────────── caret block detection ───────────
function caretBlock() {
  const sel = window.getSelection();
  if (!sel || !sel.focusNode || !TextFlow.contains(sel.focusNode)) return null;
  let n = sel.focusNode;
  while (n && n !== TextFlow && n.parentNode !== TextFlow) n = n.parentNode;
  return (n && n !== TextFlow) ? n : null;
}

// ─────────── selection save / restore ───────────
function saveBlockSelection(block) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (!block.contains(range.startContainer) && range.startContainer !== block) return null;
  const pre = document.createRange();
  pre.selectNodeContents(block);
  try { pre.setEnd(range.startContainer, range.startOffset); } catch (_) { return null; }
  const start = pre.toString().length;
  const end = start + range.toString().length;
  return { start, end };
}

function restoreBlockSelection(block, { start, end }) {
  let charCount = 0;
  let startNode = null, startOffset = 0;
  let endNode = null, endOffset = 0;
  function walk(node) {
    if (startNode && endNode) return;
    if (node.nodeType === 3) {
      const next = charCount + node.length;
      if (startNode == null && start <= next) {
        startNode = node;
        startOffset = start - charCount;
      }
      if (endNode == null && end <= next) {
        endNode = node;
        endOffset = end - charCount;
      }
      charCount = next;
    } else if (node.childNodes) {
      for (const c of node.childNodes) walk(c);
    }
  }
  walk(block);
  const sel = window.getSelection();
  const r = document.createRange();
  if (startNode) {
    r.setStart(startNode, startOffset);
    if (endNode) r.setEnd(endNode, endOffset);
    else r.collapse(true);
  } else {
    r.selectNodeContents(block);
    r.collapse(false);
  }
  sel.removeAllRanges();
  sel.addRange(r);
}

// ─────────── render the block containing the caret ───────────
function renderCaretBlock() {
  const block = caretBlock();
  if (!block) return;
  // skip if there's an in-flight ink-trace span — let the trace finish
  // before re-rendering destroys its anchor DOM
  if (block.querySelector && block.querySelector('.ink-fresh')) return;

  const text = block.textContent;
  const parsed = parseBlock(text);
  const offsets = saveBlockSelection(block);

  let target = block;
  if (parsed.tag !== block.tagName.toLowerCase()) {
    const newEl = document.createElement(parsed.tag);
    block.parentNode.replaceChild(newEl, block);
    target = newEl;
  }
  if (target.innerHTML !== parsed.html) {
    target.innerHTML = parsed.html;
  }
  if (offsets) restoreBlockSelection(target, offsets);
}

// ─────────── debounced trigger ───────────
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderCaretBlock();
  }, 220);
}

TextFlow.addEventListener('input', scheduleRender);
TextFlow.addEventListener('blur', renderCaretBlock);

// ─────────── whimsy: brighten markers in the block under the caret ───────────
function updateMarkerNear() {
  const focus = caretBlock();
  // dim all far markers
  TextFlow.querySelectorAll('.md-marker.near').forEach(m => {
    if (!focus || !focus.contains(m)) m.classList.remove('near');
  });
  // brighten the focused block's markers
  if (focus) {
    focus.querySelectorAll('.md-marker').forEach(m => m.classList.add('near'));
  }
}
let markerTimer = null;
function scheduleMarkerNear() {
  if (markerTimer) return;
  markerTimer = setTimeout(() => { markerTimer = null; updateMarkerNear(); }, 40);
}
document.addEventListener('selectionchange', scheduleMarkerNear);
TextFlow.addEventListener('input', scheduleMarkerNear);

// expose for tests / phase H whimsy
window.__book = window.__book || {};
window.__book.renderCaretBlock = renderCaretBlock;
window.__book.parseBlock = parseBlock;

})();
