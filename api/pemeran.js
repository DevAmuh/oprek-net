// =============================================================
//  Pemeran — data endpoint  ->  /api/pemeran
// -------------------------------------------------------------
//  Zero-dependency Vercel Node function. Auth gate (shared school
//  passcode) + CRUD over Supabase PostgREST using the service-role
//  key. The browser never talks to Supabase directly — RLS on every
//  pemeran_* table denies anon entirely, so this function is the
//  only door in.
//
//  Required Vercel Environment Variable:
//    SUPABASE_SERVICE_ROLE_KEY  - service role key for project
//                                 "Sandbox" (fvrwxuwkwwrajuausuaj)
// =============================================================

const crypto = require('crypto');

const SUPA_URL = 'https://fvrwxuwkwwrajuausuaj.supabase.co';
const MAX_BODY_BYTES = 300000; // a spine is small JSON; 300kb is generous headroom
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// ---- PostgREST helper -----------------------------------------------------
async function supa(path, opts) {
  opts = opts || {};
  // .trim() guards the single most common paste error: a trailing newline or
  // space on the env var, which silently makes the key invalid.
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // Only legacy JWT keys (eyJ...) carry a role claim in the Bearer slot. The new
  // sb_secret_/sb_publishable_ keys are NOT JWTs — sent as Bearer, PostgREST can't
  // read a role and falls back to anon (403 permission denied). With apikey alone,
  // the gateway maps sb_secret_ to service_role correctly. So Bearer only for JWTs.
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  Object.assign(headers, opts.headers || {});
  const r = await fetch(SUPA_URL + path, { method: opts.method || 'GET', headers, body: opts.body });
  const text = await r.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { json = text; } }
  return { ok: r.ok, status: r.status, json };
}

// ---- passcode check (hash cached across warm invocations) -----------------
let cachedHash = null;
let lastConfigError = null; // captures WHY the settings read failed, for diagnosis

async function getPasscodeHash() {
  if (cachedHash) return cachedHash;
  const r = await supa('/rest/v1/pemeran_settings?select=value&key=eq.passcode');
  const row = r.ok && Array.isArray(r.json) && r.json[0];
  const hash = row && row.value && row.value.hash;
  if (typeof hash === 'string' && hash.length === 64) { cachedHash = hash; lastConfigError = null; }
  else {
    const msg = r.json && (r.json.message || r.json.error || r.json.msg);
    lastConfigError = 'Supabase HTTP ' + r.status + (msg ? ' — ' + msg : '');
  }
  return cachedHash;
}

// Returns 'ok' | 'bad' | 'config'. 'config' means the passcode row could not be
// read at all (wrong/missing service-role key, unreachable DB); reporting that
// as a wrong passcode sends the operator hunting for the wrong bug.
async function verifyPass(pass) {
  if (typeof pass !== 'string' || pass.length < 4 || pass.length > 200) return 'bad';
  const hash = await getPasscodeHash();
  if (!hash) return 'config';
  const digest = crypto.createHash('sha256').update(pass, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(hash, 'hex')) ? 'ok' : 'bad';
  } catch (e) {
    return 'bad'; // length mismatch etc. — treat as no match
  }
}

const CONFIG_ERROR = 'Server tidak dapat membaca pengaturan dari database. Pastikan '
  + 'SUPABASE_SERVICE_ROLE_KEY di Vercel berisi kunci service_role (secret) proyek '
  + 'Supabase "Sandbox" — bukan kunci anon/publishable — lalu redeploy.';

// ---- V2c: second passcode gating admin-only actions (hash cached across
// warm invocations, same pattern as verifyPass/getPasscodeHash above). This
// is a DELIBERATE known limitation: passcode-only auth, not per-user roles —
// real per-user auth is the multi-tenant milestone. Documented again in the
// admin UI itself (pemeran/js/admin.js). --------------------------------------
let cachedAdminHash = null;

async function getAdminPasscodeHash() {
  if (cachedAdminHash) return cachedAdminHash;
  const r = await supa('/rest/v1/pemeran_settings?select=value&key=eq.admin_passcode');
  const row = r.ok && Array.isArray(r.json) && r.json[0];
  const hash = row && row.value && row.value.hash;
  if (typeof hash === 'string' && hash.length === 64) cachedAdminHash = hash;
  return cachedAdminHash;
}

// Returns 'ok' | 'bad' | 'config' — same semantics as verifyPass().
async function verifyAdminPass(pass) {
  if (typeof pass !== 'string' || pass.length < 4 || pass.length > 200) return 'bad';
  const hash = await getAdminPasscodeHash();
  if (!hash) return 'config';
  const digest = crypto.createHash('sha256').update(pass, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(hash, 'hex')) ? 'ok' : 'bad';
  } catch (e) {
    return 'bad';
  }
}

const ADMIN_CONFIG_ERROR = 'Server tidak dapat membaca kode admin dari database. Hubungi pemilik akun untuk memeriksa baris pemeran_settings.admin_passcode.';

// ---- V2c: AES-256-GCM secret encryption (BYOK API keys) --------------------
// Key derived from Vercel env PEMERAN_SECRET (any long random string) via
// sha256 -> 32 bytes. This file is deliberately self-contained (zero shared
// modules across api/*.js) — the same small block is duplicated verbatim in
// api/pemeran-ai.js, which is the file that actually decrypts+uses these
// keys at generation time.
//   encryptSecret(plaintext) -> "v1:<iv_b64>:<tag_b64>:<ct_b64>"
//   decryptSecret(blob)      -> plaintext, or null on ANY failure (never
//                                throws into the request path).
function pemeranSecretKey() {
  const secret = (process.env.PEMERAN_SECRET || '').trim();
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function encryptSecret(plaintext) {
  const key = pemeranSecretKey();
  if (!key) {
    const e = new Error('PEMERAN_SECRET belum diatur di server — tidak bisa menyimpan kunci API. Tambahkan PEMERAN_SECRET (string acak yang panjang) di Vercel → Settings → Environment Variables, lalu redeploy.');
    e.noSecret = true;
    throw e;
  }
  const iv = crypto.randomBytes(12); // 96-bit IV, GCM standard
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + iv.toString('base64') + ':' + tag.toString('base64') + ':' + ct.toString('base64');
}

function decryptSecret(blob) {
  try {
    const key = pemeranSecretKey();
    if (!key || typeof blob !== 'string') return null;
    const parts = blob.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    return null; // tampered/foreign/corrupt blob, wrong key, etc. — never throw
  }
}

// ---- V2c: upsert helper for pemeran_settings (key text PK) -----------------
async function upsertSetting(key, value) {
  return supa('/rest/v1/pemeran_settings?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify([{ key, value }]),
  });
}

const DEFAULT_OPENROUTER_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'openai/gpt-oss-20b:free',
  'openrouter/free',
];
// Kept short and curated — a dropdown, not a free-text model field, so a
// typo can't silently point production at a non-existent model id.
const ANTHROPIC_MODEL_OPTIONS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'];

// ---- actions ----------------------------------------------------------------
async function listTeachers(res) {
  const r = await supa('/rest/v1/pemeran_teachers?select=id,name,is_owner&active=eq.true&order=name.asc');
  if (!r.ok) return res.status(502).json({ error: 'Gagal memuat daftar guru.' });
  return res.status(200).json({ ok: true, teachers: r.json || [] });
}

async function getSettings(res) {
  const r = await supa('/rest/v1/pemeran_settings?select=key,value&key=in.(school,tahunAjaran)');
  if (!r.ok) return res.status(502).json({ error: 'Gagal memuat pengaturan.' });
  const out = {};
  for (const row of (r.json || [])) out[row.key] = row.value;
  // never return the passcode row, even if a future refactor widens the select above
  delete out.passcode;
  return res.status(200).json({ ok: true, school: out.school || null, tahunAjaran: out.tahunAjaran || null });
}

async function listPlans(body, res) {
  if (!isUuid(body.teacherId)) return res.status(400).json({ error: 'teacherId tidak valid.' });
  const path = '/rest/v1/pemeran_plans?select=id,mapel,kelas,tahun_ajaran,stage,updated_at'
    + '&teacher_id=eq.' + encodeURIComponent(body.teacherId) + '&order=updated_at.desc';
  const r = await supa(path);
  if (!r.ok) return res.status(502).json({ error: 'Gagal memuat daftar dokumen.' });
  return res.status(200).json({ ok: true, plans: r.json || [] });
}

async function loadPlan(body, res) {
  if (!isUuid(body.planId)) return res.status(400).json({ error: 'planId tidak valid.' });
  const r = await supa('/rest/v1/pemeran_plans?select=*&id=eq.' + encodeURIComponent(body.planId));
  if (!r.ok) return res.status(502).json({ error: 'Gagal memuat dokumen.' });
  const row = Array.isArray(r.json) && r.json[0];
  if (!row) return res.status(404).json({ error: 'Dokumen tidak ditemukan.' });
  return res.status(200).json({ ok: true, plan: row });
}

async function createPlan(body, res) {
  if (!isUuid(body.teacherId)) return res.status(400).json({ error: 'teacherId tidak valid.' });
  const mapel = typeof body.mapel === 'string' ? body.mapel.trim().slice(0, 200) : '';
  if (!mapel) return res.status(400).json({ error: 'Mata pelajaran wajib diisi.' });
  const kelas = Number(body.kelas);
  if (![7, 8, 9].includes(kelas)) return res.status(400).json({ error: 'Kelas harus 7, 8, atau 9.' });
  const tahunAjaran = typeof body.tahunAjaran === 'string' ? body.tahunAjaran.trim().slice(0, 20) : '';
  if (!tahunAjaran) return res.status(400).json({ error: 'Tahun ajaran wajib diisi.' });

  const insertBody = { teacher_id: body.teacherId, mapel, kelas, tahun_ajaran: tahunAjaran };
  const r = await supa('/rest/v1/pemeran_plans', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(insertBody),
  });
  if (r.ok) {
    const row = Array.isArray(r.json) ? r.json[0] : r.json;
    return res.status(200).json({ ok: true, plan: row, created: true });
  }

  // unique_violation (teacher_id, mapel, kelas, tahun_ajaran) -> hand back the existing row
  const isConflict = r.status === 409 || (r.json && r.json.code === '23505');
  if (isConflict) {
    const existingPath = '/rest/v1/pemeran_plans?select=*'
      + '&teacher_id=eq.' + encodeURIComponent(body.teacherId)
      + '&mapel=eq.' + encodeURIComponent(mapel)
      + '&kelas=eq.' + encodeURIComponent(kelas)
      + '&tahun_ajaran=eq.' + encodeURIComponent(tahunAjaran);
    const existing = await supa(existingPath);
    const row = existing.ok && Array.isArray(existing.json) && existing.json[0];
    if (row) return res.status(200).json({ ok: true, plan: row, created: false });
  }
  return res.status(502).json({ error: 'Gagal membuat dokumen baru.' });
}

async function savePlan(body, res) {
  if (!isUuid(body.planId)) return res.status(400).json({ error: 'planId tidak valid.' });
  if (body.spine !== undefined && !isPlainObject(body.spine)) {
    return res.status(400).json({ error: 'spine tidak valid.' });
  }
  const stage = typeof body.stage === 'string' && body.stage ? body.stage.trim().slice(0, 40) : undefined;

  if (body.snapshot === true) {
    if (!stage) return res.status(400).json({ error: 'stage wajib diisi untuk snapshot.' });
    const revBody = { plan_id: body.planId, stage, spine: body.spine || {} };
    const rr = await supa('/rest/v1/pemeran_revisions', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(revBody),
    });
    if (!rr.ok) return res.status(502).json({ error: 'Gagal menyimpan salinan revisi.' });
  }

  const patchBody = { updated_at: new Date().toISOString() };
  if (body.spine !== undefined) patchBody.spine = body.spine;
  if (stage !== undefined) patchBody.stage = stage;

  const r = await supa('/rest/v1/pemeran_plans?id=eq.' + encodeURIComponent(body.planId), {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(patchBody),
  });
  if (!r.ok) return res.status(502).json({ error: 'Gagal menyimpan dokumen.' });
  const row = Array.isArray(r.json) ? r.json[0] : r.json;
  if (!row) return res.status(404).json({ error: 'Dokumen tidak ditemukan.' });
  return res.status(200).json({ ok: true, plan: row });
}

// ---- M4: gen_stats — owner-only cost readout (aggregate pemeran_gen_log
// for one plan). Gated server-side (not just hidden client-side) since it's
// a cheap, self-contained check: the requesting teacherId must actually
// carry is_owner=true in pemeran_teachers. -----------------------------------
async function genStats(body, res) {
  if (!isUuid(body.planId)) return res.status(400).json({ error: 'planId tidak valid.' });
  if (!isUuid(body.teacherId)) return res.status(400).json({ error: 'teacherId tidak valid.' });

  const ownerCheck = await supa('/rest/v1/pemeran_teachers?select=is_owner&id=eq.' + encodeURIComponent(body.teacherId));
  const teacherRow = ownerCheck.ok && Array.isArray(ownerCheck.json) && ownerCheck.json[0];
  if (!teacherRow || !teacherRow.is_owner) {
    return res.status(403).json({ error: 'Statistik biaya hanya untuk akun pemilik.' });
  }

  const path = '/rest/v1/pemeran_gen_log?select=input_tokens,output_tokens,cache_read,cache_write&plan_id=eq.' + encodeURIComponent(body.planId);
  const r = await supa(path);
  if (!r.ok) return res.status(502).json({ error: 'Gagal memuat statistik penggunaan AI.' });

  const rows = Array.isArray(r.json) ? r.json : [];
  const stats = rows.reduce((acc, row) => {
    acc.calls += 1;
    acc.input += Number(row.input_tokens) || 0;
    acc.output += Number(row.output_tokens) || 0;
    acc.cacheRead += Number(row.cache_read) || 0;
    acc.cacheWrite += Number(row.cache_write) || 0;
    return acc;
  }, { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

  return res.status(200).json({ ok: true, stats });
}

// ---- V2c — admin settings (get/save) + BYOK connection test + global cost
// dashboard. ALL gated by the admin passcode (verifyAdminPass), independent
// of the normal passcode gate already applied to every action in the entry
// point below. This is intentionally passcode-only, not per-user roles —
// see the note above verifyAdminPass(). -------------------------------------

async function readSettingsRow(key) {
  const r = await supa('/rest/v1/pemeran_settings?select=value&key=eq.' + encodeURIComponent(key));
  const row = r.ok && Array.isArray(r.json) && r.json[0];
  return (row && row.value) || null;
}

async function getAdminSettings(body, res) {
  const gate = await verifyAdminPass(body.adminPass);
  if (gate === 'config') return res.status(500).json({ error: ADMIN_CONFIG_ERROR });
  if (gate !== 'ok') return res.status(403).json({ error: 'Kode admin salah atau belum diisi.' });

  const [ai, school, tahunAjaran, defaults, passcode, adminPasscode] = await Promise.all([
    readSettingsRow('ai_config'),
    readSettingsRow('school'),
    readSettingsRow('tahunAjaran'),
    readSettingsRow('defaults'),
    readSettingsRow('passcode'),
    readSettingsRow('admin_passcode'),
  ]);
  const aiVal = ai || {};
  const keys = aiVal.keys || {};
  const defaultsVal = defaults || {};

  return res.status(200).json({
    ok: true,
    ai: {
      primaryProvider: aiVal.primaryProvider === 'openrouter' ? 'openrouter' : 'anthropic',
      anthropicModel: aiVal.anthropicModel || 'claude-haiku-4-5',
      anthropicModelOptions: ANTHROPIC_MODEL_OPTIONS,
      openrouterModels: (Array.isArray(aiVal.openrouterModels) && aiVal.openrouterModels.length)
        ? aiVal.openrouterModels : DEFAULT_OPENROUTER_MODELS,
      anthropicKeySet: !!keys.anthropic,
      openrouterKeySet: !!keys.openrouter,
    },
    school: {
      nama: (school && school.nama) || '',
      kota: (school && school.kota) || '',
      kepsek: (school && school.kepsek) || '',
      kepsekNik: (school && school.kepsekNik) || '',
      logoDataUri: (school && school.logoDataUri) || '',
      bannerDataUri: (school && school.bannerDataUri) || '',
    },
    tahunAjaran: tahunAjaran || '',
    defaults: {
      menitPerJp: Number(defaultsVal.menitPerJp) > 0 ? Number(defaultsVal.menitPerJp) : 40,
      maxPertemuanPerUnit: Number(defaultsVal.maxPertemuanPerUnit) > 0 ? Number(defaultsVal.maxPertemuanPerUnit) : 4,
      mingguEfektif: {
        ganjil: Number(defaultsVal.mingguEfektif && defaultsVal.mingguEfektif.ganjil) > 0 ? Number(defaultsVal.mingguEfektif.ganjil) : 18,
        genap: Number(defaultsVal.mingguEfektif && defaultsVal.mingguEfektif.genap) > 0 ? Number(defaultsVal.mingguEfektif.genap) : 17,
      },
    },
    passcodeSet: !!(passcode && passcode.hash),
    adminPasscodeSet: !!(adminPasscode && adminPasscode.hash),
  });
}

async function saveAdminSettings(body, res) {
  const gate = await verifyAdminPass(body.adminPass);
  if (gate === 'config') return res.status(500).json({ error: ADMIN_CONFIG_ERROR });
  if (gate !== 'ok') return res.status(403).json({ error: 'Kode admin salah atau belum diisi.' });

  const patch = isPlainObject(body.patch) ? body.patch : {};

  // --- ai_config: provider/model/roster (plaintext) + keys (encrypted) ---
  if (isPlainObject(patch.ai) || isPlainObject(patch.aiKeys)) {
    const current = (await readSettingsRow('ai_config')) || {};
    const next = Object.assign({}, current);
    if (isPlainObject(patch.ai)) {
      if (typeof patch.ai.primaryProvider === 'string') {
        next.primaryProvider = patch.ai.primaryProvider === 'openrouter' ? 'openrouter' : 'anthropic';
      }
      if (typeof patch.ai.anthropicModel === 'string' && patch.ai.anthropicModel.trim()) {
        next.anthropicModel = patch.ai.anthropicModel.trim().slice(0, 100);
      }
      if (Array.isArray(patch.ai.openrouterModels)) {
        next.openrouterModels = patch.ai.openrouterModels
          .filter((m) => typeof m === 'string' && m.trim())
          .map((m) => m.trim().slice(0, 200))
          .slice(0, 20);
      }
    }
    if (isPlainObject(patch.aiKeys)) {
      next.keys = Object.assign({}, current.keys);
      for (const provider of ['anthropic', 'openrouter']) {
        if (typeof patch.aiKeys[provider] !== 'string') continue;
        if (!patch.aiKeys[provider]) { delete next.keys[provider]; continue; } // empty string = clear
        try {
          next.keys[provider] = encryptSecret(patch.aiKeys[provider].trim());
        } catch (e) {
          return res.status(500).json({ error: String((e && e.message) || e) });
        }
      }
    }
    const w = await upsertSetting('ai_config', next);
    if (!w.ok) return res.status(502).json({ error: 'Gagal menyimpan pengaturan AI.' });
  }

  // --- school profile ---
  if (isPlainObject(patch.school)) {
    const current = (await readSettingsRow('school')) || {};
    const next = Object.assign({}, current);
    const s = patch.school;
    if (typeof s.nama === 'string') next.nama = s.nama.trim().slice(0, 200);
    if (typeof s.kota === 'string') next.kota = s.kota.trim().slice(0, 100);
    if (typeof s.kepsek === 'string') next.kepsek = s.kepsek.trim().slice(0, 200);
    if (typeof s.kepsekNik === 'string') next.kepsekNik = s.kepsekNik.trim().slice(0, 40);
    // Logo/banner are small data-URIs the client already size-capped before
    // sending; MAX_BODY_BYTES (300kb) is the hard backstop for the whole request.
    if (typeof s.logoDataUri === 'string') next.logoDataUri = s.logoDataUri.slice(0, 200000);
    if (typeof s.bannerDataUri === 'string') next.bannerDataUri = s.bannerDataUri.slice(0, 200000);
    const w = await upsertSetting('school', next);
    if (!w.ok) return res.status(502).json({ error: 'Gagal menyimpan profil sekolah.' });
  }

  // --- tahunAjaran (stored as a bare string value, not an object) ---
  if (typeof patch.tahunAjaran === 'string' && patch.tahunAjaran.trim()) {
    const w = await upsertSetting('tahunAjaran', patch.tahunAjaran.trim().slice(0, 20));
    if (!w.ok) return res.status(502).json({ error: 'Gagal menyimpan tahun ajaran.' });
  }

  // --- defaults (menitPerJp / maxPertemuanPerUnit / mingguEfektif) ---
  if (isPlainObject(patch.defaults)) {
    const current = (await readSettingsRow('defaults')) || {};
    const next = Object.assign({}, current);
    const d = patch.defaults;
    if (Number(d.menitPerJp) > 0) next.menitPerJp = Number(d.menitPerJp);
    if (Number(d.maxPertemuanPerUnit) > 0) next.maxPertemuanPerUnit = Number(d.maxPertemuanPerUnit);
    if (isPlainObject(d.mingguEfektif)) {
      const curMe = current.mingguEfektif || {};
      next.mingguEfektif = {
        ganjil: Number(d.mingguEfektif.ganjil) > 0 ? Number(d.mingguEfektif.ganjil) : (curMe.ganjil || 18),
        genap: Number(d.mingguEfektif.genap) > 0 ? Number(d.mingguEfektif.genap) : (curMe.genap || 17),
      };
    }
    const w = await upsertSetting('defaults', next);
    if (!w.ok) return res.status(502).json({ error: 'Gagal menyimpan pengaturan default.' });
  }

  // --- passcode / admin passcode changes (re-hash; invalidate warm cache) ---
  if (typeof patch.passcode === 'string' && patch.passcode) {
    if (patch.passcode.length < 4) return res.status(400).json({ error: 'Kode akses baru minimal 4 karakter.' });
    const hash = crypto.createHash('sha256').update(patch.passcode, 'utf8').digest('hex');
    const w = await upsertSetting('passcode', { hash });
    if (!w.ok) return res.status(502).json({ error: 'Gagal mengubah kode akses.' });
    cachedHash = null;
  }
  if (typeof patch.adminPasscode === 'string' && patch.adminPasscode) {
    if (patch.adminPasscode.length < 4) return res.status(400).json({ error: 'Kode admin baru minimal 4 karakter.' });
    const hash = crypto.createHash('sha256').update(patch.adminPasscode, 'utf8').digest('hex');
    const w = await upsertSetting('admin_passcode', { hash });
    if (!w.ok) return res.status(502).json({ error: 'Gagal mengubah kode admin.' });
    cachedAdminHash = null;
  }

  return res.status(200).json({ ok: true });
}

// Resolved-key ping — mirrors api/pemeran-ai.js's resolveAiConfig() (this
// file is self-contained, so the small resolution logic is duplicated here
// too, but only for this one read-only diagnostic action).
async function resolveAiConfigForTest() {
  const ai = (await readSettingsRow('ai_config')) || {};
  const keys = ai.keys || {};
  return {
    anthropicKey: decryptSecret(keys.anthropic) || (process.env.ANTHROPIC_API_KEY || '').trim() || null,
    openrouterKey: decryptSecret(keys.openrouter) || (process.env.OPENROUTER_API_KEY || '').trim() || null,
    anthropicModel: (ai.anthropicModel && String(ai.anthropicModel).trim()) || 'claude-haiku-4-5',
    openrouterModels: (Array.isArray(ai.openrouterModels) && ai.openrouterModels.length) ? ai.openrouterModels : DEFAULT_OPENROUTER_MODELS,
  };
}

async function testAi(body, res) {
  const gate = await verifyAdminPass(body.adminPass);
  if (gate === 'config') return res.status(500).json({ error: ADMIN_CONFIG_ERROR });
  if (gate !== 'ok') return res.status(403).json({ error: 'Kode admin salah atau belum diisi.' });

  const provider = body.provider === 'openrouter' ? 'openrouter' : 'anthropic';
  const cfg = await resolveAiConfigForTest();
  const started = Date.now();
  const PING = 'Balas dengan satu kata saja: OK';

  try {
    if (provider === 'anthropic') {
      if (!cfg.anthropicKey) {
        return res.status(200).json({ ok: false, error: 'Kunci Anthropic belum diatur (baik di panel admin maupun ANTHROPIC_API_KEY di Vercel).' });
      }
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: cfg.anthropicModel, max_tokens: 10, messages: [{ role: 'user', content: PING }] }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
        return res.status(200).json({ ok: false, error: 'Anthropic: ' + msg });
      }
      return res.status(200).json({ ok: true, model: (data && data.model) || cfg.anthropicModel, latencyMs: Date.now() - started });
    }

    if (!cfg.openrouterKey) {
      return res.status(200).json({ ok: false, error: 'Kunci OpenRouter belum diatur (baik di panel admin maupun OPENROUTER_API_KEY di Vercel).' });
    }
    const model = cfg.openrouterModels[0];
    const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + cfg.openrouterKey,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.dhiya.id/pemeran',
        'X-Title': 'Pemeran',
      },
      body: JSON.stringify({ model, max_tokens: 10, messages: [{ role: 'user', content: PING }] }),
    });
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || ('HTTP ' + r.status);
      return res.status(200).json({ ok: false, error: 'OpenRouter: ' + msg });
    }
    return res.status(200).json({ ok: true, model: (data && data.model) || model, latencyMs: Date.now() - started });
  } catch (e) {
    return res.status(200).json({ ok: false, error: 'Gagal menghubungi ' + provider + ': ' + String((e && e.message) || e) });
  }
}

// Global cost dashboard — distinct from genStats() above (which is scoped to
// one plan + teacherId-ownership check); this one aggregates ACROSS every
// pemeran_gen_log row and is gated purely by the admin passcode.
async function adminGenStats(body, res) {
  const gate = await verifyAdminPass(body.adminPass);
  if (gate === 'config') return res.status(500).json({ error: ADMIN_CONFIG_ERROR });
  if (gate !== 'ok') return res.status(403).json({ error: 'Kode admin salah atau belum diisi.' });

  const r = await supa('/rest/v1/pemeran_gen_log?select=model,input_tokens,output_tokens,cache_read,cache_write');
  if (!r.ok) return res.status(502).json({ error: 'Gagal memuat statistik penggunaan AI.' });
  const rows = Array.isArray(r.json) ? r.json : [];

  const totals = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, fallbackCalls: 0 };
  const byModel = {};
  for (const row of rows) {
    const model = row.model || '(tidak diketahui)';
    const input = Number(row.input_tokens) || 0;
    const output = Number(row.output_tokens) || 0;
    const cacheRead = Number(row.cache_read) || 0;
    const cacheWrite = Number(row.cache_write) || 0;
    totals.calls += 1;
    totals.input += input;
    totals.output += output;
    totals.cacheRead += cacheRead;
    totals.cacheWrite += cacheWrite;
    if (typeof model === 'string' && model.indexOf('or:') === 0) totals.fallbackCalls += 1;
    if (!byModel[model]) byModel[model] = { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    byModel[model].calls += 1;
    byModel[model].input += input;
    byModel[model].output += output;
    byModel[model].cacheRead += cacheRead;
    byModel[model].cacheWrite += cacheWrite;
  }

  // Cost estimate — Haiku pricing ($1/MTok in, $5/MTok out; cache read 0.1x,
  // cache write 1.25x of the input rate) applied uniformly. Clearly labeled
  // an ESTIMATE: real per-model pricing varies and "or:"-prefixed fallback
  // rows are free OpenRouter models (real cost to us is $0), reported as such.
  const HAIKU_IN = 1 / 1e6;
  const HAIKU_OUT = 5 / 1e6;
  function estCost(t) {
    if (!t) return 0;
    return t.input * HAIKU_IN + t.output * HAIKU_OUT + t.cacheRead * HAIKU_IN * 0.1 + t.cacheWrite * HAIKU_IN * 1.25;
  }
  const perModel = Object.keys(byModel).sort().map((model) => {
    const t = byModel[model];
    const isFallback = model.indexOf('or:') === 0;
    return Object.assign({ model, isFallback, estCostUsd: isFallback ? 0 : Number(estCost(t).toFixed(4)) }, t);
  });

  return res.status(200).json({
    ok: true,
    totals: Object.assign({ estCostUsd: Number(estCost(totals).toFixed(4)) }, totals),
    perModel,
    note: 'Estimasi biaya memakai tarif Claude Haiku ($1/MTok input, $5/MTok output, cache read 0.1x, cache write 1.25x) untuk baris non-fallback — perkiraan kasar, bukan tagihan aktual. Baris "or:" adalah model cadangan gratis (biaya $0).',
  });
}

// ---- entry point ------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    let approxBytes = 0;
    try { approxBytes = Buffer.byteLength(JSON.stringify(body)); } catch (e) { approxBytes = 0; }
    if (approxBytes > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Permintaan terlalu besar.' });
    }

    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: 'Server belum disiapkan — tambahkan SUPABASE_SERVICE_ROLE_KEY di Vercel → Settings → Environment Variables, lalu redeploy.',
      });
    }

    const gate = await verifyPass(body.pass);
    if (gate === 'config') return res.status(500).json({ error: CONFIG_ERROR, detail: lastConfigError });
    if (gate !== 'ok') return res.status(401).json({ error: 'Kode akses salah.' });

    switch (body.action) {
      case 'list_teachers': return await listTeachers(res);
      case 'get_settings':  return await getSettings(res);
      case 'list_plans':    return await listPlans(body, res);
      case 'load_plan':     return await loadPlan(body, res);
      case 'create_plan':   return await createPlan(body, res);
      case 'save_plan':     return await savePlan(body, res);
      case 'gen_stats':     return await genStats(body, res);
      case 'get_admin_settings':  return await getAdminSettings(body, res);
      case 'save_admin_settings': return await saveAdminSettings(body, res);
      case 'test_ai':             return await testAi(body, res);
      case 'admin_gen_stats':     return await adminGenStats(body, res);
      default:
        return res.status(400).json({ error: 'Aksi tidak dikenal.' });
    }
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
