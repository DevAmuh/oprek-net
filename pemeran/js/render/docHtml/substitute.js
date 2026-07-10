// =============================================================
// SUBSTITUTE (ported from eduforge src/lib/docHtml/substitute.ts —
// mechanical TS→JS port, logic unchanged: only type annotations/
// interfaces stripped.)
// -------------------------------------------------------------
// Given a template HTML string + the current field values, returns
// the fully-substituted HTML. Used identically by the live preview,
// the MHT/PDF export (print the substituted HTML), and the HTML
// export (serve the substituted HTML directly).
//
// FieldValues shape (was a TS interface, now just documented):
//   { manual: {field: string}, system: {field: string},
//     ai: {field: string | string[]} }   // string[] only for checkbox-list fields
// =============================================================

import { parseTemplate } from "./markerParser.js";
import { richTextToHtml } from "./richTextHtml.js";

function indonesianDate() {
  return new Date().toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

export function substitute(templateHtml, values) {
  const { doc, markers, warnings } = parseTemplate(templateHtml);
  const manual = values.manual ?? {};
  const system = values.system ?? {};
  const ai = values.ai ?? {};

  for (const marker of markers) {
    applyMarker(marker, manual, system, ai);
  }

  const html = "<!DOCTYPE html>\n" + doc.documentElement.outerHTML;
  return { html, doc, warnings };
}

function applyMarker(marker, manual, system, ai) {
  const { element, type, field, isCheckboxList } = marker;

  switch (type) {
    case "0":
      return; // locked — leave template content as-is

    case "1":
      setContent(element, (field && manual[field]) || "");
      return;

    case "2a":
      setContent(element, indonesianDate());
      return;

    case "2b":
      setContent(element, (field && system[field]) || "");
      return;

    case "3": {
      const value = field ? ai[field] : undefined;
      if (isCheckboxList) {
        applyCheckboxList(element, Array.isArray(value) ? value : []);
      } else {
        setContent(element, typeof value === "string" ? richTextToHtml(value) : "", true);
      }
      return;
    }
  }
}

function setContent(element, value, asHtml = false) {
  if (element instanceof HTMLImageElement) {
    if (value) element.setAttribute("src", value);
    return;
  }
  if (asHtml) {
    // Safe: richTextToHtml() escapes all raw text before wrapping it in the
    // fixed <p>/<strong>/<em> tags it controls — AI/manual text can't break out.
    element.innerHTML = value;
  } else {
    element.textContent = value;
  }
}

function applyCheckboxList(container, selected) {
  const items = Array.from(container.querySelectorAll("li[data-item]"));
  for (const li of items) {
    const label = li.getAttribute("data-item") ?? "";
    const isChecked = selected.some((s) => label.toLowerCase().includes(String(s).toLowerCase()));
    const chk = li.querySelector(".chk");
    if (chk) chk.textContent = isChecked ? "☑" : "☐";
  }
}
