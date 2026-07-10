// =============================================================
// Pemeran — DOCX export
// -------------------------------------------------------------
// Thin wrapper around render/docHtml/toDocx.js (same relationship
// export/html.js has to docHtml/toHtmlExport.js): takes the same
// already-substituted HTML string the MHT/HTML exporters take, builds
// a docx.Document (structure/rowspan/colspan/shading-aware, handles
// all 4 doc types + Prosem landscape — see toDocx.js), packs it to a
// Blob, and triggers the browser download.
// =============================================================

import { buildDocxBlob } from '../render/docHtml/toDocx.js';

/**
 * @param {string} substitutedHtml
 * @param {string} label  doc label (e.g. "RPP — <topik>", "Prosem — Semester Ganjil");
 *   used as the filename verbatim (sanitized). Callers own the doc-type prefix.
 */
export async function downloadDocx(substitutedHtml, label) {
  const blob = await buildDocxBlob(substitutedHtml);
  const safe = String(label || 'Dokumen').replace(/[\\/:*?"<>|]/g, '').trim() || 'Dokumen';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.docx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
