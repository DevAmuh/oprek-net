// =============================================================
// Pemeran — fetch wrapper for /api/pemeran
// Attaches the session passcode, surfaces errors as toasts, and
// bounces to index.html on 401 (session expired / wrong pass).
// =============================================================

const PASS_KEY = 'pemeran_pass';

export function getPass() {
  try { return sessionStorage.getItem(PASS_KEY) || ''; } catch (e) { return ''; }
}
export function setPass(pass) {
  try { sessionStorage.setItem(PASS_KEY, pass); } catch (e) { /* ignore (private mode etc.) */ }
}
export function clearPass() {
  try { sessionStorage.removeItem(PASS_KEY); } catch (e) { /* ignore */ }
}

let toastWrap = null;
export function toast(message, opts) {
  opts = opts || {};
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (opts.error ? ' is-error' : '');
  el.textContent = message;
  toastWrap.appendChild(el);
  setTimeout(() => { el.remove(); }, opts.duration || 4200);
}

/**
 * Call one action on /api/pemeran.
 * Resolves with the parsed JSON body on success ({ ok:true, ... }).
 * Rejects (after showing a toast) on any failure — callers that need
 * to react to a failure (rather than just letting the toast speak)
 * should wrap the call in try/catch.
 */
export async function call(action, payload) {
  payload = payload || {};
  let res;
  try {
    res = await fetch('/api/pemeran', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ action, pass: getPass() }, payload)),
    });
  } catch (e) {
    toast('Tidak bisa terhubung ke server. Periksa koneksi internet Anda.', { error: true });
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

  return data;
}
