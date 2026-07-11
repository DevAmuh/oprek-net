// =============================================================
// Pemeran — admin panel logic (V2c)
// -------------------------------------------------------------
// Auth model (documented, intentional limitation): the app is still
// passcode-only (owner decision — real per-user roles are the multi-tenant
// milestone). This page requires the normal school passcode (already in
// sessionStorage from index.html) PLUS a SECOND "admin passcode" entered
// here. Every admin action (get_admin_settings/save_admin_settings/test_ai/
// admin_gen_stats) is independently gated server-side in api/pemeran.js by
// verifyAdminPass() — this client never assumes the gate; it just reflects
// whatever the server says.
// =============================================================
import { getPass, setPass, toast, call } from './api.js';

if (!getPass()) {
  // No normal-passcode session at all — send back to the front gate first.
  location.href = 'index.html';
}

const MODEL_LABELS = {
  'claude-haiku-4-5': 'Claude Haiku 4.5 (termurah, default)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6 (lebih pintar, lebih mahal)',
  'claude-opus-4-8': 'Claude Opus 4.8 (paling pintar, paling mahal)',
};
const MAX_IMAGE_BYTES = 60 * 1024; // keeps combined save_admin_settings body well under the 300KB server cap

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function fmtNum(n) { return Number(n || 0).toLocaleString('id-ID'); }

let adminPass = '';
let settings = null; // last-loaded get_admin_settings payload
let pendingLogoDataUri = null;
let pendingBannerDataUri = null;

const viewGate = document.getElementById('view-gate');
const viewPanel = document.getElementById('view-panel');
function showPanel() { viewGate.classList.add('hidden'); viewPanel.classList.remove('hidden'); }

// ---- Gate ----
const inAdminPass = document.getElementById('in-admin-pass');
const btnAdminPassToggle = document.getElementById('btn-admin-pass-toggle');
const btnAdminSubmit = document.getElementById('btn-admin-submit');

btnAdminPassToggle.addEventListener('click', () => {
  const showing = inAdminPass.type === 'text';
  inAdminPass.type = showing ? 'password' : 'text';
  btnAdminPassToggle.textContent = showing ? '👁' : '🙈';
});
inAdminPass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitGate(); });
btnAdminSubmit.addEventListener('click', submitGate);

async function submitGate() {
  const pass = inAdminPass.value.trim();
  if (!pass) { toast('Isi kode admin dulu.', { error: true }); return; }
  btnAdminSubmit.disabled = true;
  btnAdminSubmit.textContent = 'Memeriksa…';
  try {
    const r = await call('get_admin_settings', { adminPass: pass });
    adminPass = pass;
    settings = r;
    renderAll();
    showPanel();
    loadDasbor();
  } catch (e) {
    // call() already toasted the server's message (e.g. "Kode admin salah…").
  } finally {
    btnAdminSubmit.disabled = false;
    btnAdminSubmit.textContent = 'Masuk';
  }
}

async function reloadSettings() {
  try {
    settings = await call('get_admin_settings', { adminPass });
    renderAll();
  } catch (e) {
    // toasted already (e.g. session/admin pass no longer valid)
  }
}

function renderAll() {
  renderAi();
  renderSchool();
  renderDefaults();
}

// ---- AI section ----
const selProvider = document.getElementById('ai-primary-provider');
const selModel = document.getElementById('ai-anthropic-model');
const taOpenrouterModels = document.getElementById('ai-openrouter-models');
const badgeAnthropicKey = document.getElementById('ai-anthropic-key-badge');
const badgeOpenrouterKey = document.getElementById('ai-openrouter-key-badge');
const inAnthropicKey = document.getElementById('ai-anthropic-key');
const inOpenrouterKey = document.getElementById('ai-openrouter-key');

function setKeyBadge(el, isSet) {
  el.textContent = isSet ? 'tersimpan ✓' : 'belum diisi';
  el.className = 'badge ' + (isSet ? 'badge-good' : 'badge-muted');
}

function renderAi() {
  const ai = settings.ai;
  selProvider.value = ai.primaryProvider;
  selModel.innerHTML = ai.anthropicModelOptions
    .map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(MODEL_LABELS[m] || m)}</option>`)
    .join('');
  selModel.value = ai.anthropicModel;
  taOpenrouterModels.value = ai.openrouterModels.join('\n');
  setKeyBadge(badgeAnthropicKey, ai.anthropicKeySet);
  setKeyBadge(badgeOpenrouterKey, ai.openrouterKeySet);
  inAnthropicKey.value = '';
  inOpenrouterKey.value = '';
  document.getElementById('test-anthropic-result').textContent = '';
  document.getElementById('test-openrouter-result').textContent = '';
}

async function clearKey(provider, label) {
  if (!confirm('Hapus kunci ' + label + ' yang tersimpan? Sistem akan kembali memakai kunci environment server (jika ada).')) return;
  try {
    const patch = { aiKeys: {} };
    patch.aiKeys[provider] = '';
    await call('save_admin_settings', { adminPass, patch });
    toast('Kunci ' + label + ' dihapus.');
    await reloadSettings();
  } catch (e) { /* toasted */ }
}
document.getElementById('btn-anthropic-key-clear').addEventListener('click', () => clearKey('anthropic', 'Anthropic'));
document.getElementById('btn-openrouter-key-clear').addEventListener('click', () => clearKey('openrouter', 'OpenRouter'));

async function testProvider(provider) {
  const resultEl = document.getElementById('test-' + provider + '-result');
  resultEl.textContent = 'Menguji…';
  resultEl.style.color = '';
  try {
    const r = await call('test_ai', { adminPass, provider });
    if (r.ok) {
      resultEl.textContent = '✓ ' + r.model + ' · ' + r.latencyMs + 'ms';
      resultEl.style.color = 'var(--good)';
    } else {
      resultEl.textContent = '✗ ' + r.error;
      resultEl.style.color = 'var(--bad)';
    }
  } catch (e) {
    resultEl.textContent = '✗ Gagal menghubungi server.';
    resultEl.style.color = 'var(--bad)';
  }
}
document.getElementById('btn-test-anthropic').addEventListener('click', () => testProvider('anthropic'));
document.getElementById('btn-test-openrouter').addEventListener('click', () => testProvider('openrouter'));

document.getElementById('btn-save-ai').addEventListener('click', async () => {
  const patch = {
    ai: {
      primaryProvider: selProvider.value,
      anthropicModel: selModel.value,
      openrouterModels: taOpenrouterModels.value.split('\n').map((s) => s.trim()).filter(Boolean),
    },
  };
  const anthropicKeyVal = inAnthropicKey.value.trim();
  const openrouterKeyVal = inOpenrouterKey.value.trim();
  if (anthropicKeyVal || openrouterKeyVal) {
    patch.aiKeys = {};
    if (anthropicKeyVal) patch.aiKeys.anthropic = anthropicKeyVal;
    if (openrouterKeyVal) patch.aiKeys.openrouter = openrouterKeyVal;
  }
  try {
    await call('save_admin_settings', { adminPass, patch });
    toast('Pengaturan AI disimpan.');
    await reloadSettings();
  } catch (e) { /* toasted */ }
});

// ---- Sekolah section ----
function renderSchool() {
  const s = settings.school;
  document.getElementById('sch-nama').value = s.nama || '';
  document.getElementById('sch-kota').value = s.kota || '';
  document.getElementById('sch-kepsek').value = s.kepsek || '';
  document.getElementById('sch-kepsek-nik').value = s.kepsekNik || '';
  document.getElementById('tahun-ajaran').value = settings.tahunAjaran || '';

  const logoImg = document.getElementById('sch-logo-preview');
  const bannerImg = document.getElementById('sch-banner-preview');
  if (s.logoDataUri) { logoImg.src = s.logoDataUri; logoImg.classList.remove('hidden'); }
  else { logoImg.removeAttribute('src'); logoImg.classList.add('hidden'); }
  if (s.bannerDataUri) { bannerImg.src = s.bannerDataUri; bannerImg.classList.remove('hidden'); }
  else { bannerImg.removeAttribute('src'); bannerImg.classList.add('hidden'); }

  pendingLogoDataUri = null;
  pendingBannerDataUri = null;
  document.getElementById('sch-logo-file').value = '';
  document.getElementById('sch-banner-file').value = '';
}

function wireImageInput(inputId, previewId, setPending) {
  document.getElementById(inputId).addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) {
      toast('Gambar terlalu besar (maks ~60KB). Kompres/perkecil dulu, lalu unggah lagi.', { error: true });
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setPending(reader.result);
      const img = document.getElementById(previewId);
      img.src = reader.result;
      img.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });
}
wireImageInput('sch-logo-file', 'sch-logo-preview', (v) => { pendingLogoDataUri = v; });
wireImageInput('sch-banner-file', 'sch-banner-preview', (v) => { pendingBannerDataUri = v; });

document.getElementById('btn-save-school').addEventListener('click', async () => {
  const patch = {
    school: {
      nama: document.getElementById('sch-nama').value,
      kota: document.getElementById('sch-kota').value,
      kepsek: document.getElementById('sch-kepsek').value,
      kepsekNik: document.getElementById('sch-kepsek-nik').value,
    },
    tahunAjaran: document.getElementById('tahun-ajaran').value,
  };
  if (pendingLogoDataUri) patch.school.logoDataUri = pendingLogoDataUri;
  if (pendingBannerDataUri) patch.school.bannerDataUri = pendingBannerDataUri;
  try {
    await call('save_admin_settings', { adminPass, patch });
    toast('Profil sekolah disimpan.');
    await reloadSettings();
  } catch (e) { /* toasted */ }
});

// ---- Default section ----
function renderDefaults() {
  const d = settings.defaults;
  document.getElementById('def-menit-per-jp').value = d.menitPerJp;
  document.getElementById('def-max-pertemuan').value = d.maxPertemuanPerUnit;
  document.getElementById('def-minggu-ganjil').value = d.mingguEfektif.ganjil;
  document.getElementById('def-minggu-genap').value = d.mingguEfektif.genap;
}

document.getElementById('btn-save-defaults').addEventListener('click', async () => {
  const patch = {
    defaults: {
      menitPerJp: Number(document.getElementById('def-menit-per-jp').value),
      maxPertemuanPerUnit: Number(document.getElementById('def-max-pertemuan').value),
      mingguEfektif: {
        ganjil: Number(document.getElementById('def-minggu-ganjil').value),
        genap: Number(document.getElementById('def-minggu-genap').value),
      },
    },
  };
  try {
    await call('save_admin_settings', { adminPass, patch });
    toast('Pengaturan default disimpan.');
    await reloadSettings();
  } catch (e) { /* toasted */ }
});

// ---- Keamanan section ----
document.getElementById('btn-change-passcode').addEventListener('click', async () => {
  const p1 = document.getElementById('new-passcode').value;
  const p2 = document.getElementById('new-passcode-confirm').value;
  if (!p1 || p1.length < 4) { toast('Kode akses baru minimal 4 karakter.', { error: true }); return; }
  if (p1 !== p2) { toast('Konfirmasi kode akses tidak cocok.', { error: true }); return; }
  try {
    await call('save_admin_settings', { adminPass, patch: { passcode: p1 } });
    setPass(p1); // keep THIS tab's session usable (other guru/tabs will need the new code)
    toast('Kode akses berhasil diubah. Guru lain perlu memakai kode baru untuk masuk.');
    document.getElementById('new-passcode').value = '';
    document.getElementById('new-passcode-confirm').value = '';
  } catch (e) { /* toasted */ }
});

document.getElementById('btn-change-admin-passcode').addEventListener('click', async () => {
  const p1 = document.getElementById('new-admin-passcode').value;
  const p2 = document.getElementById('new-admin-passcode-confirm').value;
  if (!p1 || p1.length < 4) { toast('Kode admin baru minimal 4 karakter.', { error: true }); return; }
  if (p1 !== p2) { toast('Konfirmasi kode admin tidak cocok.', { error: true }); return; }
  try {
    await call('save_admin_settings', { adminPass, patch: { adminPasscode: p1 } });
    adminPass = p1; // keep THIS session's subsequent admin calls authenticating correctly
    toast('Kode admin berhasil diubah.');
    document.getElementById('new-admin-passcode').value = '';
    document.getElementById('new-admin-passcode-confirm').value = '';
  } catch (e) { /* toasted */ }
});

// ---- Dasbor section ----
document.getElementById('btn-refresh-dasbor').addEventListener('click', loadDasbor);

async function loadDasbor() {
  const totalsEl = document.getElementById('dasbor-totals');
  const perModelEl = document.getElementById('dasbor-per-model');
  totalsEl.textContent = 'Memuat…';
  perModelEl.innerHTML = '';
  try {
    const r = await call('admin_gen_stats', { adminPass });
    const t = r.totals;
    totalsEl.innerHTML = `
      <div class="row-between"><span>Total panggilan AI</span><strong>${fmtNum(t.calls)}</strong></div>
      <div class="row-between"><span>Token input / output</span><strong>${fmtNum(t.input)} / ${fmtNum(t.output)}</strong></div>
      <div class="row-between"><span>Cache read / write</span><strong>${fmtNum(t.cacheRead)} / ${fmtNum(t.cacheWrite)}</strong></div>
      <div class="row-between"><span>Panggilan pakai cadangan gratis</span><strong>${fmtNum(t.fallbackCalls)}</strong></div>
      <div class="row-between"><span>Estimasi biaya</span><strong>$${t.estCostUsd.toFixed(4)}</strong></div>
      <p class="muted small">${escapeHtml(r.note)}</p>
    `;
    perModelEl.innerHTML = r.perModel.length
      ? r.perModel.map((m) => `
        <div class="row-between" style="border-bottom:1px solid var(--line); padding:6px 0;">
          <span>${escapeHtml(m.model)}${m.isFallback ? ' <span class="badge badge-muted">cadangan</span>' : ''}</span>
          <span class="muted small">${fmtNum(m.calls)}x · in ${fmtNum(m.input)} · out ${fmtNum(m.output)} · $${m.estCostUsd.toFixed(4)}</span>
        </div>
      `).join('')
      : '<p class="muted">Belum ada data pemakaian AI.</p>';
  } catch (e) {
    totalsEl.textContent = '';
  }
}
