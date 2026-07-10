// =============================================================
// MARKER PARSER (ported from eduforge src/lib/docHtml/markerParser.ts —
// mechanical TS→JS port, logic unchanged: only type annotations/interfaces
// stripped.)
// -------------------------------------------------------------
// Parses a Document Identity System template (HTML string) and finds
// every element carrying a data-marker attribute, building a marker
// map that substitute.js drives.
//
// Marker types (same 5 as the PRD, expressed as HTML attributes
// instead of embedded {bracket} text):
//   0   locked      — content is fixed, never substituted
//   1   manual      — teacher fills via form            (data-field required)
//   2a  system/date — auto-populated at generation time
//   2b  system/pull — from school/teacher profile        (data-field required)
//   3   AI-generated — LLM produces this field's content  (data-field required)
// =============================================================

const VALID_TYPES = new Set(["0", "1", "2a", "2b", "3"]);
const FIELD_REQUIRED_TYPES = new Set(["1", "2b", "3"]);

export function parseTemplate(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const markers = [];
  const warnings = [];

  const elements = Array.from(doc.querySelectorAll("[data-marker]"));
  for (const element of elements) {
    const type = element.getAttribute("data-marker") ?? "";
    const field = element.getAttribute("data-field");
    const tag = element.tagName.toLowerCase();

    if (!VALID_TYPES.has(type)) {
      warnings.push(`Unrecognized marker type "${type}" on <${tag}> — left as-is.`);
      continue;
    }
    if (FIELD_REQUIRED_TYPES.has(type) && !field) {
      warnings.push(`Marker type "${type}" on <${tag}> is missing a required data-field attribute — skipped.`);
      continue;
    }

    markers.push({
      element,
      type,
      field,
      isCheckboxList: element.classList.contains("checkbox-list"),
    });
  }

  warnings.push(...findDuplicateFieldWarnings(markers));
  warnings.push(...findUnmarkedCellWarnings(doc));

  return { doc, markers, warnings };
}

function findDuplicateFieldWarnings(markers) {
  const counts = new Map();
  for (const m of markers) {
    if (!m.field) continue;
    counts.set(m.field, (counts.get(m.field) ?? 0) + 1);
  }
  const warnings = [];
  for (const [field, count] of counts) {
    if (count > 1) {
      warnings.push(`Field "${field}" is used by ${count} markers — the same value will be applied to all of them.`);
    }
  }
  return warnings;
}

/** Flags table cells with real text content but no data-marker at all — likely a forgotten marker. */
function findUnmarkedCellWarnings(doc) {
  const warnings = [];
  const cells = Array.from(doc.querySelectorAll("td, th"));
  for (const cell of cells) {
    if (cell.closest("[data-marker]")) continue; // nested inside an already-marked ancestor
    if (cell.querySelector("[data-marker]")) continue; // container cell whose children carry the markers
    const text = (cell.textContent ?? "").trim();
    if (text.length > 0) {
      warnings.push(`Unmarked cell with content "${text.slice(0, 40)}${text.length > 40 ? "…" : ""}" — did you mean to mark it?`);
    }
  }
  return warnings;
}
