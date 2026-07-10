// =============================================================
// RICH TEXT → DOCX PARAGRAPHS (ported from eduforge
// src/lib/docHtml/richText.ts — mechanical TS→JS port, logic unchanged:
// only type annotations stripped.)
// -------------------------------------------------------------
// NOT used in M2 (DOCX export is M4) — nothing in the M2 wizard imports
// this file, so its "docx" import is never resolved by the browser. Kept
// here now (per the port instructions) so M4's toDocx.js has it ready.
// The bare "docx" specifier from the original repo is rewritten to the
// jsDelivr ESM build, matching the plan's stated M4 approach
// (`https://cdn.jsdelivr.net/npm/docx@9/+esm`) since this repo has no
// bundler/import-map to resolve a bare "docx" specifier.
//
// Supports in-line: **bold**, *italic*
// Line prefixes:    ✓  •  -  o  1.  (indent + bullet/number)
//
// M4: FONT changed from the ported original's "Arial" to "Calibri" to match
// toDocx.js's page setup (plan: "A4 portrait..., Calibri — same page setup
// as the MHT path") now that this file is actually wired into toDocx.js's
// checkbox-list rendering (see toDocx.js's renderCellChildren).
// =============================================================

import { Paragraph, TextRun } from "https://cdn.jsdelivr.net/npm/docx@9/+esm";

const BLACK = "000000";
const FONT = "Calibri";
const SIZE = 18;

export function parseInline(text) {
  const runs = [];
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith("**") && part.endsWith("**")) {
      runs.push(new TextRun({ text: part.slice(2, -2), bold: true, font: FONT, size: SIZE, color: BLACK }));
    } else if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      runs.push(new TextRun({ text: part.slice(1, -1), italics: true, font: FONT, size: SIZE, color: BLACK }));
    } else {
      runs.push(new TextRun({ text: part, font: FONT, size: SIZE, color: BLACK }));
    }
  }
  return runs.length ? runs : [new TextRun({ text, font: FONT, size: SIZE, color: BLACK })];
}

export function richTextToParas(text) {
  if (!text) return [emptyPara()];
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return [emptyPara()];

  return lines.map((raw) => {
    const line = raw.trim();
    let prefix = "";
    let content = line;
    let indent = 0;

    if (line.startsWith("✓ ")) {
      prefix = "✓  "; content = line.slice(2).trim();
    } else if (line.startsWith("• ")) {
      prefix = "•  "; content = line.slice(2).trim(); indent = 180;
    } else if (line.startsWith("- ")) {
      prefix = "•  "; content = line.slice(2).trim(); indent = 180;
    } else if (line.startsWith("o ")) {
      prefix = "○  "; content = line.slice(2).trim(); indent = 360;
    } else {
      const m = line.match(/^(\d+\.\s)(.*)/);
      if (m) { prefix = m[1]; content = m[2]; }
    }

    const runs = [];
    if (prefix) runs.push(new TextRun({ text: prefix, font: FONT, size: SIZE, color: BLACK }));
    runs.push(...parseInline(content));

    return new Paragraph({
      indent: indent ? { left: indent } : undefined,
      spacing: { after: 40 },
      children: runs,
    });
  });
}

export function checkboxParas(allItems, selected) {
  return allItems.map((item) => {
    const isChecked = Array.isArray(selected) &&
      selected.some((s) => item.toLowerCase().includes(String(s).toLowerCase()));
    return new Paragraph({
      spacing: { after: 40 },
      children: [new TextRun({
        text: (isChecked ? "☑  " : "☐  ") + item,
        font: FONT,
        size: SIZE,
        color: BLACK,
      })],
    });
  });
}

function emptyPara() {
  return new Paragraph({ children: [new TextRun({ text: "", font: FONT, size: SIZE, color: BLACK })] });
}
