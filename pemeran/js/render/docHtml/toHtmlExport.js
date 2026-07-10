// =============================================================
// HTML EXPORT (ported from eduforge src/lib/docHtml/toHtmlExport.ts —
// mechanical TS→JS port, logic unchanged: only type annotations stripped.)
// -------------------------------------------------------------
// Serves the substituted HTML as a standalone downloadable file.
// Images are inlined as data URIs so the file has zero external
// dependencies — it opens correctly even off the dev server's origin
// (e.g. double-clicked from disk), not just inside the app.
// =============================================================

async function toDataUri(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function buildStandaloneHtml(substitutedHtml) {
  const doc = new DOMParser().parseFromString(substitutedHtml, "text/html");
  const images = Array.from(doc.querySelectorAll("img"));

  for (const img of images) {
    const src = img.getAttribute("src");
    if (!src || src.startsWith("data:")) continue;
    try {
      img.setAttribute("src", await toDataUri(src));
    } catch {
      // Leave the original src if it can't be fetched — better a broken
      // image than a failed export.
    }
  }

  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
}

export function downloadHtml(html, filename) {
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
