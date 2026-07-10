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
      default:
        return res.status(400).json({ error: 'Aksi tidak dikenal.' });
    }
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
