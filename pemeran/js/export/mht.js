// =============================================================
// Pemeran — MHT export (primary "opens in real Word" path)
// -------------------------------------------------------------
// Assembles a MIME multipart/related .mht file wrapping the
// substituted RPP HTML, with the two template images (logo/banner)
// embedded as base64 parts referenced by their existing relative
// <img src> paths (Word/most MHTML readers resolve an embedded part
// by matching its Content-Location header against the HTML's src
// attribute literally — so no src rewriting is needed as long as
// the Content-Location strings match the template's own
// "assets/logo.gif" / "assets/banner.gif" paths).
// =============================================================

const IMAGE_PARTS = [
  { src: 'assets/logo.gif', type: 'image/gif' },
  { src: 'assets/banner.gif', type: 'image/gif' },
];

function makeBoundary() {
  return '----=_NextPart_Pemeran_' + Date.now().toString(16) + '_' + Math.random().toString(16).slice(2);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Wrap a base64 string at 76 chars/line — conventional MIME line length. */
function wrapBase64(b64) {
  const lines = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

/** Inject Word-recognizable <meta>/<style> (@page WordSection1, A4 portrait,
 *  Calibri) and wrap the body in a div.WordSection1 — the standard markers
 *  Word itself writes when it saves a document as .mht/"Web Page, Filtered". */
function addWordCompat(substitutedHtml) {
  const doc = new DOMParser().parseFromString(substitutedHtml, 'text/html');

  const progId = doc.createElement('meta');
  progId.setAttribute('name', 'ProgId');
  progId.setAttribute('content', 'Word.Document');
  doc.head.insertBefore(progId, doc.head.firstChild);

  const generator = doc.createElement('meta');
  generator.setAttribute('name', 'Generator');
  generator.setAttribute('content', 'Pemeran (dhiya.id/pemeran)');
  doc.head.appendChild(generator);

  const wordStyle = doc.createElement('style');
  wordStyle.textContent = `
@page WordSection1 {size:595.3pt 841.9pt; margin:63.8pt 49.55pt 72.0pt 72.0pt}
div.WordSection1 { page: WordSection1; }
body { font-family: Calibri, 'Arial Narrow', Arial, sans-serif; }
`;
  doc.head.appendChild(wordStyle);

  const section = doc.createElement('div');
  section.className = 'WordSection1';
  while (doc.body.firstChild) section.appendChild(doc.body.firstChild);
  doc.body.appendChild(section);

  return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
}

async function fetchImagePart(src, type) {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return { src, type, base64: wrapBase64(arrayBufferToBase64(buf)) };
  } catch (e) {
    return null; // export still works without the image parts — just no logo/banner in Word
  }
}

/**
 * Build a MIME multipart/related .mht Blob from already-substituted RPP HTML.
 * @param {string} substitutedHtml
 * @returns {Promise<Blob>}
 */
export async function buildMht(substitutedHtml) {
  const boundary = makeBoundary();
  const wordHtml = addWordCompat(substitutedHtml);
  const imageParts = (await Promise.all(IMAGE_PARTS.map((p) => fetchImagePart(p.src, p.type)))).filter(Boolean);

  const CRLF = '\r\n';
  let out = '';
  out += 'MIME-Version: 1.0' + CRLF;
  out += 'Content-Type: multipart/related; boundary="' + boundary + '"; type="text/html"' + CRLF;
  out += CRLF;
  out += 'This is a multi-part message in MIME format.' + CRLF;
  out += CRLF;

  out += '--' + boundary + CRLF;
  out += 'Content-Type: text/html; charset="utf-8"' + CRLF;
  out += 'Content-Transfer-Encoding: 8bit' + CRLF;
  out += 'Content-Location: file:///pemeran/rpp.htm' + CRLF;
  out += CRLF;
  out += wordHtml + CRLF;
  out += CRLF;

  for (const part of imageParts) {
    out += '--' + boundary + CRLF;
    out += 'Content-Type: ' + part.type + CRLF;
    out += 'Content-Transfer-Encoding: base64' + CRLF;
    out += 'Content-Location: ' + part.src + CRLF;
    out += CRLF;
    out += part.base64 + CRLF;
    out += CRLF;
  }

  out += '--' + boundary + '--' + CRLF;

  return new Blob([out], { type: 'message/rfc822' });
}

/** Build the MHT and trigger a browser download named "<label>.mht".
 *  `label` must already carry the document type (e.g. "RPP - Heat Transfer",
 *  "Prota & ATP") — callers own the prefix, as they do for the DOCX path. */
export async function downloadMht(substitutedHtml, label) {
  const blob = await buildMht(substitutedHtml);
  const safe = String(label || 'Dokumen').replace(/[\\/:*?"<>|]/g, '').trim() || 'Dokumen';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safe}.mht`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
