// =============================================================
// Pemeran — fetch wrapper for /api/pemeran-ai
// Mirrors js/api.js's call() (same passcode header, same toast/401
// handling) but targets the generation endpoint. Kept as its own
// file rather than editing api.js, per M2 scope (M1 files stay as-is).
// =============================================================

import { getPass, clearPass, toast } from './api.js';

export async function callAi(action, payload) {
  payload = payload || {};
  let res;
  try {
    res = await fetch('/api/pemeran-ai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action, pass: getPass() }, payload)),
    });
  } catch (e) {
    toast('Tidak bisa terhubung ke server AI. Periksa koneksi internet Anda.', { error: true });
    throw e;
  }

  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON response (e.g. local static server 404) */ }

  if (res.status === 401) {
    clearPass();
    toast('Sesi berakhir — silakan masuk kembali.', { error: true });
    setTimeout(() => { location.href = 'index.html'; }, 1000);
    throw new Error('unauthorized');
  }

  if (!res.ok) {
    const msg = (data && data.error) || ('Terjadi kesalahan tak terduga (kode ' + res.status + ').');
    toast(msg, { error: true });
    throw new Error(msg);
  }

  // Server fell back to a free OpenRouter model (Anthropic credit empty/down).
  // Tell the teacher once per result so quality dips aren't a mystery.
  if (data && data.fallback) {
    toast('Dibuat dengan model cadangan gratis (kredit AI utama habis/terganggu) — periksa hasil lebih teliti.', { duration: 7000 });
  }

  return data;
}
