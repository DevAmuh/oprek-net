// =============================================================
// HTML → DOCX (M4 — ported + generalized from eduforge's
// src/lib/docHtml/toDocx.ts, which targeted RPP's table.rpp-table
// only). Mechanical TS→JS port (type annotations stripped; the 3
// rowSpan/columnSpan TS errors the plan flagged were purely
// ITableCellOptions type-compatibility complaints about the
// conditional-spread pattern — writing them as plain `if (...)
// opts.rowSpan = rowSpan;` assignments avoids the pattern entirely,
// so there's nothing left to "fix" at runtime in plain JS) — PLUS
// generalized beyond just the RPP template so it now walks all four
// Pemeran doc types (RPP, Prota/ATP, Prosem, TP/KKTP), detected from
// each template's root <div class="*-page"> wrapper:
//   - RPP:        table.rpp-table (colgroup %, pane-* shading/rowspan)
//   - Prota/ATP:  one or more table.doc-table sections (cp/sumatif/
//                 total "band" rows are <tr> classes, not cell classes)
//   - Prosem:     one wide table.prosem-table (3-row rowspan/colspan
//                 header, dynamic week columns) — forced landscape
//   - TP/KKTP:    two table.doc-table sections
//
// Per the plan: "generic converter... targets Word defaults + A4 —
// content/structure fidelity, not pixel-matching the custom CSS."
//
// Checkbox lists (ul.checkbox-list li[data-item]) are rendered via
// richText.js's checkboxParas() — richText.js was ported ahead of
// this milestone specifically to be used here; this is the one place
// in the DOM-walk where reconstructing the *rendered* markup (☑/☐ per
// item) into the exact same allItems/selected shape checkboxParas()
// already expects is lossless, so it's used instead of duplicating
// that paragraph-building logic inline. The rest of a cell's rich text
// (already-rendered <p class="rt-line rt-indent-*">/<strong>/<em> from
// richTextHtml.js, since toDocx.js's only contract is "substituted
// HTML" — no raw markdown is available at this point) is walked
// directly from the DOM below; reconstructing raw markdown from that
// HTML just to re-parse it via richText.js's richTextToParas would be
// lossy (its "o " vs rendered "○" glyph, "-" vs "•" merge) for no
// fidelity gain over reading the already-resolved strong/em/rt-indent-*
// nodes directly.
// =============================================================

import {
  Document as DocxDocument,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  BorderStyle,
  WidthType,
  ShadingType,
  VerticalAlign,
  PageOrientation,
} from "https://cdn.jsdelivr.net/npm/docx@9/+esm";
import { checkboxParas } from "./richText.js";

const BLACK = "000000";
const WHITE = "FFFFFF";
const YELLOW = "FFCE3C";
const SALMON = "F7CBAC";
const ORANGE = "F4B083";
// M4: Calibri (not the ported original's Arial) — matches the plan's docx
// page-setup spec ("A4 portrait..., Calibri — same page setup as the MHT
// path"); richText.js's own FONT constant was updated to match (see there).
const FONT = "Calibri";
const SIZE = 18; // 9pt (docx sizes are half-points)

// ── page geometry — margins fixed at 63.8/49.55/72/72pt for EVERY doc type
// (portrait or landscape) per the plan, decoupled from each template's own
// browser @media print CSS (which differs per doc, e.g. Prosem's 10mm). ──
const PT_TO_DXA = 20;
const MARGIN_TOP = Math.round(63.8 * PT_TO_DXA);
const MARGIN_RIGHT = Math.round(49.55 * PT_TO_DXA);
const MARGIN_BOTTOM = 72 * PT_TO_DXA;
const MARGIN_LEFT = 72 * PT_TO_DXA;
const A4_PORTRAIT = { width: 11906, height: 16838 };
const A4_LANDSCAPE = { width: 16838, height: 11906 };

const NESTED_TW = 6000; // fallback width for nested tables (generic support, unused by current templates)

const B = { style: BorderStyle.SINGLE, size: 4, color: BLACK };
const BORDERS = { top: B, bottom: B, left: B, right: B };
const NO_BORDER = { style: BorderStyle.NONE, size: 0, color: WHITE };
const NO_BORDERS = { top: NO_BORDER, bottom: NO_BORDER, left: NO_BORDER, right: NO_BORDER };

function run(text, opts) {
  opts = opts || {};
  return new TextRun({ text, bold: opts.bold, italics: opts.italic, font: FONT, size: opts.size || SIZE, color: BLACK });
}

function para(text, opts) {
  opts = opts || {};
  return new Paragraph({
    alignment: opts.center ? AlignmentType.CENTER : undefined,
    spacing: { after: 40 },
    children: [run(text, opts)],
  });
}

function intAttr(el, name) {
  const v = el.getAttribute(name);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 1 ? n : undefined;
}

/** Which of the four templates this substituted doc is (root wrapper div). */
function detectDocType(doc) {
  if (doc.querySelector(".rpp-page")) return "rpp";
  if (doc.querySelector(".prota-page")) return "prota";
  if (doc.querySelector(".prosem-page")) return "prosem";
  if (doc.querySelector(".tpkktp-page")) return "tpkktp";
  return "generic";
}

/* ─── shading: RPP uses pane-* classes directly on <td>; the generic
   doc-table/prosem-table templates shade via stylesheet selectors on
   <th> and on the *row's* class ("cp-band"/"sumatif-band"/"total-band"/
   "semester-total-band" for Prota, "sumatif-row"/"total-row" for Prosem)
   rather than a per-cell class, so both are checked here. ─────────── */
function resolveShading(cell) {
  const cls = cell.classList;
  if (cls.contains("pane-yellow") || cls.contains("pane-left")) return YELLOW;
  if (cls.contains("pane-orange")) return ORANGE;
  if (cls.contains("pane-mid")) return SALMON;
  if (cell.tagName.toLowerCase() === "th") return SALMON;
  const rowEl = cell.parentElement;
  if (rowEl) {
    const rc = rowEl.classList;
    if (rc.contains("cp-band") || rc.contains("sumatif-band") || rc.contains("sumatif-row")) return YELLOW;
    if (rc.contains("total-band") || rc.contains("semester-total-band") || rc.contains("total-row")) return ORANGE;
  }
  return WHITE;
}

/** Centered cells: RPP's pane-left/pane-orange/pane-header labels, generic
 *  td.center / th cells, and (default) every cell in prosem-table except
 *  its two left-aligned text columns (materi-cell/cp-cell). */
function isCentered(cell, tableClassName) {
  const cls = cell.classList;
  if (cls.contains("pane-left") || cls.contains("pane-orange") || cls.contains("pane-header")) return true;
  if (cls.contains("center")) return true;
  if (cls.contains("materi-cell") || cls.contains("cp-cell")) return false;
  if (cell.tagName.toLowerCase() === "th") return true;
  if (tableClassName && tableClassName.indexOf("prosem-table") >= 0) return true;
  return false;
}

/* ─── recursive inline/block walker for a cell's (or a signature-block
   column div's) content. Handles the actual tag vocabulary the templates
   emit: p/div (with rt-indent-1/2 from richTextHtml.js), br, strong/b,
   em/i, ul.checkbox-list > li[data-item] (via richText.js's
   checkboxParas), nested table, and plain text/containers. ──────────── */
function renderCellChildren(cell, cellOpts) {
  cellOpts = cellOpts || {};
  const out = [];
  let currentRuns = [];

  const flush = (o) => {
    o = o || {};
    if (currentRuns.length === 0) return;
    out.push(new Paragraph({
      alignment: cellOpts.center ? AlignmentType.CENTER : undefined,
      indent: o.indent ? { left: o.indent } : undefined,
      spacing: { after: 40 },
      children: currentRuns,
    }));
    currentRuns = [];
  };

  const walkInline = (node, inherited) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      // Skip pure HTML-source indentation (whitespace containing a newline);
      // keep genuine inline whitespace like a single joining space.
      const isSourceIndent = /^\s*$/.test(text) && text.includes("\n");
      if (text && !isSourceIndent) currentRuns.push(run(text, inherited));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName.toLowerCase();

    if (tag === "br") { flush(); return; }
    if (tag === "strong" || tag === "b") {
      for (const child of Array.from(el.childNodes)) walkInline(child, Object.assign({}, inherited, { bold: true }));
      return;
    }
    if (tag === "em" || tag === "i") {
      const size = el.classList.contains("small") ? 16 : inherited.size;
      for (const child of Array.from(el.childNodes)) walkInline(child, Object.assign({}, inherited, { italic: true, size }));
      return;
    }
    if (tag === "span" && el.classList.contains("chk")) {
      currentRuns.push(run((el.textContent || "") + "  ", inherited));
      return;
    }
    for (const child of Array.from(el.childNodes)) walkInline(child, inherited);
  };

  const walkBlock = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { walkInline(node, {}); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName.toLowerCase();

    if (tag === "table") { flush(); out.push(renderNestedTable(el)); return; }
    if (tag === "p" || tag === "div") {
      flush();
      const indent = el.classList.contains("rt-indent-1") ? 180 : el.classList.contains("rt-indent-2") ? 360 : undefined;
      for (const child of Array.from(el.childNodes)) walkInline(child, {});
      flush({ indent });
      return;
    }
    if (tag === "ul" && el.classList.contains("checkbox-list")) {
      flush();
      const items = Array.from(el.querySelectorAll("li[data-item]"));
      const allItems = items.map((li) => li.getAttribute("data-item") || "");
      const selected = items
        .filter((li) => (((li.querySelector(".chk") || {}).textContent) || "").trim() === "☑") // ☑
        .map((li) => li.getAttribute("data-item") || "");
      out.push(...checkboxParas(allItems, selected));
      return;
    }
    if (tag === "br") { flush(); return; }
    // container element (span/div wrapper etc.) — recurse as block
    for (const child of Array.from(el.childNodes)) walkBlock(child);
  };

  for (const child of Array.from(cell.childNodes)) walkBlock(child);
  flush();

  return out.length ? out : [para("")];
}

function renderNestedTable(table) {
  const rows = [];
  const trs = Array.from(table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr"));
  const colCount = trs[0] ? trs[0].children.length : 1;
  const colWidth = Math.round(NESTED_TW / colCount);

  for (const tr of trs) {
    const cells = [];
    for (const cellEl of Array.from(tr.children)) {
      const isHeader = cellEl.tagName.toLowerCase() === "th";
      cells.push(new TableCell({
        width: { size: colWidth, type: WidthType.DXA },
        shading: { fill: isHeader ? SALMON : WHITE, type: ShadingType.CLEAR },
        borders: BORDERS,
        margins: { top: 40, bottom: 40, left: 60, right: 60 },
        children: renderCellChildren(cellEl).filter((c) => c instanceof Paragraph),
      }));
    }
    rows.push(new TableRow({ children: cells }));
  }

  return new Table({ width: { size: NESTED_TW, type: WidthType.DXA }, rows });
}

/** Column widths (DXA) summing to `tw`, resolved in priority order:
 *  1. <colgroup><col style="width:N%"> (RPP) — proportional off percentages.
 *  2. Header row cells' inline style="width:Npx" (TP/KKTP, Prosem) —
 *     proportional, treating any column without an explicit px width as
 *     "auto" and giving it the average of the known columns' share.
 *  3. Equal-width fallback (Prota's single-row band/total tables, or any
 *     table with no width hints at all). */
function readGrid(table, tw) {
  const cols = Array.from(table.querySelectorAll(":scope > colgroup > col"));
  if (cols.length) {
    const pcts = cols.map((c) => {
      const m = (c.getAttribute("style") || "").match(/width:\s*([\d.]+)%/);
      return m ? parseFloat(m[1]) : 100 / cols.length;
    });
    const totalPct = pcts.reduce((a, b) => a + b, 0) || 100;
    const widths = pcts.map((p) => Math.round((p / totalPct) * tw));
    widths[widths.length - 1] += tw - widths.reduce((a, b) => a + b, 0); // absorb rounding drift
    return widths;
  }

  const trs = Array.from(table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr"));
  let colCount = 1;
  for (const tr of trs) {
    const n = Array.from(tr.children).reduce((s, c) => s + (intAttr(c, "colspan") || 1), 0);
    if (n > colCount) colCount = n;
  }

  const headerRow = table.querySelector(":scope > thead > tr") || trs[0];
  if (headerRow && colCount > 1) {
    const expanded = [];
    for (const c of Array.from(headerRow.children)) {
      const span = intAttr(c, "colspan") || 1;
      const m = (c.getAttribute("style") || "").match(/width:\s*([\d.]+)px/);
      const w = m ? parseFloat(m[1]) : null;
      for (let k = 0; k < span; k++) expanded.push(w != null ? w / span : null);
    }
    if (expanded.length === colCount && expanded.some((w) => w != null)) {
      const known = expanded.filter((w) => w != null);
      const knownSum = known.reduce((a, b) => a + b, 0);
      const unknownCount = expanded.length - known.length;
      const avgKnown = knownSum / known.length;
      const totalAssumed = knownSum + avgKnown * unknownCount;
      const widths = expanded.map((w) => Math.round(((w != null ? w : avgKnown) / totalAssumed) * tw));
      widths[widths.length - 1] += tw - widths.reduce((a, b) => a + b, 0);
      return widths;
    }
  }

  const base = Math.floor(tw / colCount);
  const widths = new Array(colCount).fill(base);
  widths[widths.length - 1] += tw - base * colCount;
  return widths;
}

/** Generic, rowspan/colspan-aware table renderer — walks BOTH <thead> and
 *  <tbody> rows in document order (needed for Prosem's 3-row rowspan/
 *  colspan header and Prota's rowspan JP column, which start mid-<tbody>). */
function renderGenericTable(table, tw) {
  const grid = readGrid(table, tw);
  const rows = [];
  const trs = Array.from(table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr"));
  const occupied = new Array(grid.length).fill(0);
  const tableClassName = table.className || "";

  for (const tr of trs) {
    const takenThisRow = occupied.map((v) => v > 0);
    for (let i = 0; i < occupied.length; i++) if (occupied[i] > 0) occupied[i]--;

    const cells = [];
    let col = 0;
    for (const cellEl of Array.from(tr.children)) {
      while (col < grid.length && takenThisRow[col]) col++;
      const colSpan = intAttr(cellEl, "colspan") || 1;
      const rowSpan = intAttr(cellEl, "rowspan") || 1;
      const width = grid.slice(col, col + colSpan).reduce((a, b) => a + b, 0) || 1;
      if (rowSpan > 1) {
        for (let i = col; i < col + colSpan; i++) occupied[i] = rowSpan - 1;
      }
      const centered = isCentered(cellEl, tableClassName);
      const children = renderCellChildren(cellEl, { center: centered });

      const opts = {
        width: { size: width, type: WidthType.DXA },
        shading: { fill: resolveShading(cellEl), type: ShadingType.CLEAR },
        borders: BORDERS,
        margins: { top: 80, bottom: 80, left: 100, right: 80 },
        verticalAlign: (cellEl.classList.contains("pane-left") || cellEl.tagName.toLowerCase() === "th")
          ? VerticalAlign.CENTER : VerticalAlign.TOP,
        children,
      };
      if (rowSpan > 1) opts.rowSpan = rowSpan;
      if (colSpan > 1) opts.columnSpan = colSpan;
      cells.push(new TableCell(opts));
      col += colSpan;
    }
    rows.push(new TableRow({ children: cells }));
  }

  return new Table({ width: { size: tw, type: WidthType.DXA }, columnWidths: grid, rows });
}

/** Top-level "two columns side by side" signature block (Prota/Prosem/
 *  TP-KKTP templates render this as a plain flex div outside any table;
 *  RPP's own signature lives INSIDE its main table as two <td>s already
 *  covered by renderGenericTable, so this is never invoked for RPP). */
function renderSignatureBlock(div) {
  const cols = Array.from(div.children);
  const cells = cols.map((col) => new TableCell({
    width: { size: Math.floor(100 / (cols.length || 1)), type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    children: renderCellChildren(col).filter((c) => c instanceof Paragraph || c instanceof Table),
  }));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: cells })],
  });
}

function renderRppHeader(doc) {
  const out = [];
  const bannerImg = doc.querySelector(".rpp-banner img.banner-img");
  const bannerLabel = bannerImg ? (bannerImg.getAttribute("alt") || "") : "";
  if (bannerLabel) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 120 }, children: [run(bannerLabel, { bold: true, size: 22 })] }));
  }

  const h1 = (doc.querySelector(".rpp-title-block h1") || {}).textContent || "";
  const h2 = (doc.querySelector(".rpp-title-block h2") || {}).textContent || "";
  const topic = (doc.querySelector(".rpp-topic") || {}).textContent || "";
  out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 100, after: 40 }, children: [run(h1, { bold: true, size: 24 })] }));
  out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 80 }, children: [run(h2, { bold: true, italic: true, size: 20 })] }));
  out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [run(topic, { bold: true, size: 20 })] }));

  const infoRows = Array.from(doc.querySelectorAll(".rpp-info .rpp-info-row"));
  for (const row of infoRows) {
    const labelEl = row.querySelector(".label");
    const label = labelEl ? (labelEl.textContent || "") : "";
    const rest = Array.from(row.childNodes).slice(2).map((n) => n.textContent || "").join("").trim();
    out.push(new Paragraph({
      spacing: { after: 20 },
      children: [run(label, { bold: true, size: 20 }), run("  :  " + rest, { size: 20 })],
    }));
  }
  out.push(new Paragraph({ spacing: { after: 200 } }));

  return out;
}

/** Header for Prota/ATP, Prosem, TP/KKTP — .title-block h1 + .header-block
 *  .header-row label:value lines (Prosem nests rows inside .header-col
 *  columns; the descendant selector below picks them up regardless). */
function renderGenericHeader(doc) {
  const out = [];
  const h1 = doc.querySelector(".title-block h1");
  if (h1) {
    out.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [run(h1.textContent || "", { bold: true, size: 24 })] }));
  }

  const rows = Array.from(doc.querySelectorAll(".header-block .header-row"));
  for (const row of rows) {
    const labelEl = row.querySelector(".label");
    const label = labelEl ? (labelEl.textContent || "").trim() : "";
    const rest = Array.from(row.childNodes)
      .filter((n) => n !== labelEl)
      .map((n) => n.textContent || "")
      .join("")
      .replace(/^\s*:\s*/, "")
      .trim();
    out.push(new Paragraph({ spacing: { after: 30 }, children: [run(label, { bold: true, size: 20 }), run("  :  " + rest, { size: 20 })] }));
  }
  out.push(new Paragraph({ spacing: { after: 160 } }));
  return out;
}

/** Body walker shared by all four doc types: section headings, tables
 *  (top-level only — cell-nested tables are handled by renderCellChildren
 *  when their enclosing top-level table is walked), and top-level
 *  signature-block divs. */
function walkPageBody(pageRoot, tw) {
  const out = [];
  const nodes = Array.from(pageRoot.querySelectorAll("h2.section-title, table, .signature-block")).filter((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "table") return !el.closest("td, th");
    if (el.classList.contains("signature-block")) return !el.closest("table");
    return !el.closest("table");
  });

  for (const el of nodes) {
    const tag = el.tagName.toLowerCase();
    if (tag === "h2") {
      out.push(new Paragraph({ spacing: { before: 200, after: 100 }, children: [run(el.textContent || "", { bold: true, size: 22 })] }));
    } else if (tag === "table") {
      out.push(renderGenericTable(el, tw));
    } else {
      out.push(renderSignatureBlock(el));
    }
  }
  return out;
}

/**
 * Build a docx.Document from an already-substituted template Document
 * (same DOM `substitute()` produces for the live preview / MHT / HTML
 * exports — see export/docx.js for the string→Document parsing step).
 * @param {Document} doc
 * @param {{ landscape?: boolean }} [opts]  landscape is auto-detected for
 *        Prosem (.prosem-page) — opts.landscape only needed to force it
 *        for a doc type that wouldn't otherwise be detected as such.
 */
export function htmlToDocxDocument(doc, opts) {
  opts = opts || {};
  const docType = detectDocType(doc);
  const landscape = docType === "prosem" || !!opts.landscape;

  const pageSize = landscape ? A4_LANDSCAPE : A4_PORTRAIT;
  const tw = pageSize.width - MARGIN_LEFT - MARGIN_RIGHT;

  let header;
  let pageRoot;
  if (docType === "rpp") {
    header = renderRppHeader(doc);
    pageRoot = doc.querySelector(".rpp-page") || doc.body;
  } else {
    header = renderGenericHeader(doc);
    pageRoot = doc.querySelector(".prota-page, .prosem-page, .tpkktp-page") || doc.body;
  }

  const body = walkPageBody(pageRoot, tw);

  return new DocxDocument({
    sections: [{
      properties: {
        page: {
          // docx (dolanmiu/docx) swaps width/height itself when
          // orientation:LANDSCAPE is set, so `size` must always be fed the
          // PORTRAIT-sense pair (A4_PORTRAIT) regardless of `landscape` —
          // pre-swapping here as well (as an earlier version of this file
          // did) double-swaps and silently emits a portrait-dimensioned
          // <w:pgSz> with a landscape orient flag. `tw` (the table content
          // width above) is unaffected — it's the real usable width on the
          // rendered page either way.
          size: {
            width: A4_PORTRAIT.width,
            height: A4_PORTRAIT.height,
            orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
          },
          margin: { top: MARGIN_TOP, right: MARGIN_RIGHT, bottom: MARGIN_BOTTOM, left: MARGIN_LEFT },
        },
      },
      children: [...header, ...body],
    }],
  });
}

/** Convenience: substituted HTML string -> docx Blob (parse + build + pack). */
export async function buildDocxBlob(substitutedHtml, opts) {
  const doc = new DOMParser().parseFromString(substitutedHtml, "text/html");
  const docxDoc = htmlToDocxDocument(doc, opts);
  return Packer.toBlob(docxDoc);
}
