// =============================================================
// RICH TEXT → HTML (ported from eduforge src/lib/docHtml/richTextHtml.ts —
// mechanical TS→JS port, logic unchanged: only type annotations stripped.)
// -------------------------------------------------------------
// Parses the AI mini-syntax (line prefixes ✓ • - o 1., inline bold/italic
// via double/single asterisks) into an HTML string.
// =============================================================

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function parseInlineHtml(text) {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/);
  return parts
    .map((part) => {
      if (!part) return "";
      if (part.startsWith("**") && part.endsWith("**")) {
        return `<strong>${escapeHtml(part.slice(2, -2))}</strong>`;
      }
      if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
        return `<em>${escapeHtml(part.slice(1, -1))}</em>`;
      }
      return escapeHtml(part);
    })
    .join("");
}

export function richTextToHtml(text) {
  if (!text) return "";
  const lines = text.split("\n").filter((l) => l.trim());
  if (!lines.length) return "";

  return lines
    .map((raw) => {
      const line = raw.trim();
      let prefix = "";
      let content = line;
      let indentClass = "";

      if (line.startsWith("✓ ")) {
        prefix = "✓&nbsp;&nbsp;";
        content = line.slice(2).trim();
      } else if (line.startsWith("• ")) {
        prefix = "•&nbsp;&nbsp;";
        content = line.slice(2).trim();
        indentClass = " rt-indent-1";
      } else if (line.startsWith("- ")) {
        prefix = "•&nbsp;&nbsp;";
        content = line.slice(2).trim();
        indentClass = " rt-indent-1";
      } else if (line.startsWith("o ")) {
        prefix = "○&nbsp;&nbsp;";
        content = line.slice(2).trim();
        indentClass = " rt-indent-2";
      } else {
        const m = line.match(/^(\d+\.\s)(.*)/);
        if (m) {
          prefix = escapeHtml(m[1]);
          content = m[2];
        }
      }

      return `<p class="rt-line${indentClass}">${prefix}${parseInlineHtml(content)}</p>`;
    })
    .join("");
}
