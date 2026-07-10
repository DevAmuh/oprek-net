// =============================================================
// Pemeran — PDF export
// -------------------------------------------------------------
// v1 approach (per plan): open the substituted HTML in a fresh
// window/tab — templates/rpp.html already ships an @media print
// block (@page A4, hides the gray screen chrome) — then trigger
// window.print() so the teacher picks "Save as PDF" in the print
// dialog. No server-side rendering in M2.
// =============================================================

export function printRppHtml(substitutedHtml) {
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('Popup diblokir browser — izinkan popup untuk mengekspor PDF.');
  }
  win.document.open();
  win.document.write(substitutedHtml);
  win.document.close();

  const triggerPrint = () => {
    try { win.focus(); win.print(); } catch (e) { /* user can still print manually from the tab */ }
  };

  if (win.document.readyState === 'complete') {
    setTimeout(triggerPrint, 150);
  } else {
    win.addEventListener('load', () => setTimeout(triggerPrint, 150));
  }
}
