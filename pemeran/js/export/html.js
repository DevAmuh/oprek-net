// =============================================================
// Pemeran — standalone HTML export
// -------------------------------------------------------------
// Thin wrapper around the ported docHtml/toHtmlExport.js: inlines
// the template's images as data URIs so the downloaded file has no
// external dependencies, then triggers the browser download.
// =============================================================

import { buildStandaloneHtml, downloadHtml } from '../render/docHtml/toHtmlExport.js';

/** `label` must already carry the document type (e.g. "RPP - Heat Transfer",
 *  "Prosem — Semester Ganjil") — callers own the prefix, as for MHT/DOCX. */
export async function exportRppHtml(substitutedHtml, label) {
  const standalone = await buildStandaloneHtml(substitutedHtml);
  const safe = String(label || 'Dokumen').replace(/[\\/:*?"<>|]/g, '').trim() || 'Dokumen';
  downloadHtml(standalone, `${safe}.html`);
}
