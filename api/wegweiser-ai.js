// =============================================================
//  Wegweiser — AI gatekeeper  ->  /api/wegweiser-ai
// -------------------------------------------------------------
//  Modeled on /api/ai (Escape Pipeline). BRING-YOUR-OWN-KEY: the user's
//  Anthropic key lives E2E-encrypted in their vault, arrives per request,
//  is forwarded to Anthropic and never logged or persisted here. Every call
//  is auth-gated against the shared vault identity (weg_verify RPC), so only
//  a signed-in vault owner can trigger spend on their own key.
//
//  Actions:
//    quiz       — generate a small node-unlock test (the curriculum's 80% bar).
//                 The grading rubric goes back to the client SEALED (AES-GCM),
//                 so the answers never sit readable in the browser.
//    grade      — unseal the rubric, grade deterministically (MC) + via Claude
//                 (short production answer), return verdict: the MODEL holds
//                 the authority to approve or reject the unlock.
//    exam_dates — Claude + web_search hunts real Goethe Jakarta / JLPT /
//                 JFT-Basic dates for the exam calendar.
//
//  Cost controls: model allowlist (Haiku default), max 3 searches, 3 loop
//  rounds, ~40s budget, costUSD reported on every response.
// =============================================================

const crypto = require('crypto');

const SUPA_URL = 'https://pvgsrurcxssjqxshqkli.supabase.co';
const SUPA_KEY = 'sb_publishable_oDZbTs1Ssm92kTIqqzwqWQ_-31YHKOU';

const MODELS = {
  haiku:  { id: 'claude-haiku-4-5', search: 'web_search_20250305', effortOK: false, inPerM: 1, outPerM: 5 },
  sonnet: { id: 'claude-sonnet-5',  search: 'web_search_20260209', effortOK: true,  inPerM: 2, outPerM: 10 },
  opus:   { id: 'claude-opus-4-8',  search: 'web_search_20260209', effortOK: true,  inPerM: 5, outPerM: 25 },
};
const EFFORTS = ['low', 'medium', 'high'];

async function verifyUser(uname, auth) {
  if (!uname || !auth || String(auth).length < 32) return false;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/weg_verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
      body: JSON.stringify({ p_uname: uname, p_auth: auth }),
    });
    if (!r.ok) return false;
    return (await r.text()).indexOf('true') >= 0;
  } catch (e) { return false; }
}

// ---- sealed rubric: AES-256-GCM, key bound to server secret + this user ----
function sealKey(uname, auth) {
  const secret = process.env.PEMERAN_SECRET || '';
  return crypto.createHash('sha256').update(secret + '|weg-rubric|' + uname + '|' + auth).digest();
}
function seal(obj, uname, auth) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(uname, auth), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function unseal(b64, uname, auth) {
  const raw = Buffer.from(String(b64), 'base64');
  const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), ct = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', sealKey(uname, auth), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
}

async function callClaude(body, apiKey) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('Claude API error ' + r.status));
  return j;
}
// Citation-split text blocks must join with '' — see /api/ai for the war story.
function textOf(msg) { return (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join(''); }

async function runClaude(userText, opts) {
  const m = opts.model;
  const msgs = [{ role: 'user', content: userText }];
  const used = { input: 0, output: 0, searches: 0 };
  const t0 = Date.now();
  let last, allText = '';
  for (let i = 0; i < 3; i++) {
    const body = { model: m.id, max_tokens: opts.maxTokens || 2000, messages: msgs };
    if (m.effortOK) body.output_config = { effort: opts.effort || 'low' };
    if (opts.useWeb) body.tools = [{ type: m.search, name: 'web_search', max_uses: opts.maxUses || 3 }];
    last = await callClaude(body, opts.apiKey);
    allText += textOf(last);
    if (last.usage) {
      used.input += last.usage.input_tokens || 0;
      used.output += last.usage.output_tokens || 0;
      const st = last.usage.server_tool_use;
      if (st) used.searches += st.web_search_requests || 0;
    }
    if (last.stop_reason === 'pause_turn' && (Date.now() - t0) < 40000) {
      msgs.push({ role: 'assistant', content: last.content });
      continue;
    }
    break;
  }
  const cost = used.input * m.inPerM / 1e6 + used.output * m.outPerM / 1e6 + used.searches * 0.01;
  return { msg: last, text: allText, stop: last && last.stop_reason, costUSD: Math.round(cost * 10000) / 10000 };
}

function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
function extractJson(t) {
  if (!t) return null;
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j = tryParse(m[0]);
  if (!j) j = tryParse(m[0].replace(/[\r\n\t]+/g, ' '));
  if (!j) { const i = t.lastIndexOf('{'); if (i >= 0) j = tryParse(t.slice(i).replace(/[\r\n\t]+/g, ' ')); }
  return j;
}
function parseFail(res, r, friendly) {
  console.error('wegweiser-ai parse fail', { stop: r.stop, len: (r.text || '').length, tail: (r.text || '').slice(-200) });
  const msg = r.stop === 'max_tokens' ? 'The answer got cut off — tap again, it usually fits on retry.' : friendly;
  return res.status(502).json({ error: msg });
}

// ---------------------------------------------------------------------------
// Prompts. The point of the scaffolding: a small model must be TOLD what a
// fair gate looks like before it is handed the authority to open it.
// ---------------------------------------------------------------------------
function quizPrompt(node, lang) {
  const langName = lang === 'de' ? 'German' : 'Japanese';
  return [
    'You are the gatekeeper of a personal language-learning skill tree. The learner wants to mark one skill node as LEARNED, which unlocks its dependents. Your test enforces the curriculum\'s 80% self-test rule: pass means they may advance; fail means they review and retry. Be fair and specific — test THIS node\'s content at THIS node\'s level, never material from deeper in the tree.',
    '',
    'Learner profile: native Arabic speaker, C1 English, absolute beginner-to-elementary in the target language. Questions may use English for instructions. For Japanese, show kana readings for any kanji beyond the node\'s own scope.',
    '',
    'Node being tested (' + langName + '):',
    'Title: ' + node.title,
    'What it covers: ' + node.summary,
    (node.prereqs && node.prereqs.length ? 'Already learned prerequisites (fair game as supporting knowledge): ' + node.prereqs.join('; ') : 'This is a foundation node.'),
    '',
    'Write EXACTLY 4 questions:',
    '- q1..q3: multiple choice, 4 options each, exactly one correct, plausible distractors drawn from typical learner errors (wrong article, wrong particle, wrong conjugation...). 1 point each.',
    '- q4: one SHORT PRODUCTION task (write/translate 1-2 sentences using the node\'s structure). 2 points: 2 = structure used correctly, 1 = attempted with minor errors, 0 = structure absent or wrong.',
    'Total 5 points. Pass = 4 or more (the 80% bar).',
    '',
    'Answer ONLY with JSON, no prose:',
    '{"questions":[{"q":"...","type":"mc","choices":["a","b","c","d"]},...,{"q":"...","type":"short"}],',
    ' "rubric":{"mc":[correctIndex0,correctIndex1,correctIndex2],"short":{"expect":"what a correct answer must contain","full":"criteria for 2 points","partial":"criteria for 1 point"}}}',
  ].join('\n');
}

function gradePrompt(rubric, shortQ, shortAnswer) {
  return [
    'You are grading ONE short production answer from a language-learning self-test. Be fair, encouraging, and strict about the target structure — that structure is the entire point of the node.',
    '',
    'Task shown to the learner: ' + shortQ,
    'Rubric: expect: ' + rubric.short.expect + ' | 2 points: ' + rubric.short.full + ' | 1 point: ' + rubric.short.partial + ' | 0 points: structure absent/wrong.',
    'Learner\'s answer: ' + (shortAnswer || '(blank)'),
    '',
    'Answer ONLY with JSON: {"points":0|1|2,"feedback":"one or two sentences: what was right, what to fix"}',
  ].join('\n');
}

function examDatesPrompt(targets) {
  return [
    'Research REAL, currently bookable exam dates for an Indonesian learner. Use web search; prefer official sources (goethe.de Jakarta, jlpt.jp / JLPT Indonesia host, JFT-Basic Prometric Indonesia). Today is ' + new Date().toISOString().slice(0, 10) + '.',
    '',
    'Find the next available sitting date (or registration window) for each of: ' + targets.join('; ') + '.',
    'If an exact day is not published, give the best documented month and say so in the note.',
    '',
    'Answer ONLY with JSON:',
    '{"dates":[{"id":"goethe-a1|goethe-a2|goethe-b1|jlpt|jft-basic","label":"...","date":"YYYY-MM-DD","note":"source + certainty","url":"https://..."}]}',
  ].join('\n');
}

module.exports = async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (!body || req.method !== 'POST') return res.status(400).json({ error: 'POST JSON only' });

    const { uname, auth, apiKey, action } = body;
    if (!apiKey || String(apiKey).trim().length < 20)
      return res.status(400).json({ error: 'No API key — add your own Anthropic key in Settings → AI.' });
    if (!(await verifyUser(uname, auth)))
      return res.status(401).json({ error: 'Sign in to your vault first — AI actions spend YOUR key, so they are locked to your account.' });

    const model = MODELS[body.model] || MODELS.haiku;
    const effort = EFFORTS.includes(body.effort) ? body.effort : 'low';
    const opts = { model, effort, apiKey: String(apiKey).trim() };

    if (action === 'quiz') {
      const node = body.node || {};
      if (!node.title || !node.summary) return res.status(400).json({ error: 'Missing node info' });
      const r = await runClaude(quizPrompt(node, body.lang === 'jp' ? 'jp' : 'de'), { ...opts, maxTokens: 1800 });
      const j = extractJson(r.text);
      if (!j || !Array.isArray(j.questions) || j.questions.length !== 4 || !j.rubric || !Array.isArray(j.rubric.mc))
        return parseFail(res, r, 'The test came back malformed — tap again.');
      const questions = j.questions.map(q => ({ q: q.q, type: q.type === 'short' ? 'short' : 'mc', choices: q.choices || undefined }));
      const sealed = seal({ rubric: j.rubric, shortQ: j.questions[3].q, node: node.title }, uname, auth);
      return res.status(200).json({ questions, sealed, passPoints: 4, totalPoints: 5, costUSD: r.costUSD });
    }

    if (action === 'grade') {
      let payload;
      try { payload = unseal(body.sealed, uname, auth); } catch (e) {
        return res.status(400).json({ error: 'This test session is stale — start the test again.' });
      }
      const answers = body.answers || {};
      const mcAns = Array.isArray(answers.mc) ? answers.mc : [];
      let points = 0;
      const perQuestion = payload.rubric.mc.map((correct, i) => {
        const ok = Number(mcAns[i]) === Number(correct);
        if (ok) points += 1;
        return { ok, correct: Number(correct) };
      });
      let shortResult = { points: 0, feedback: 'No answer given.' };
      if (String(answers.short || '').trim()) {
        const r = await runClaude(gradePrompt(payload.rubric, payload.shortQ, String(answers.short).slice(0, 800)), { ...opts, maxTokens: 800 });
        const j = extractJson(r.text);
        if (j && typeof j.points === 'number') {
          shortResult = { points: Math.max(0, Math.min(2, Math.round(j.points))), feedback: String(j.feedback || '') };
        } else {
          return parseFail(res, r, 'Grading hiccuped — submit again.');
        }
        points += shortResult.points;
        const pass = points >= 4;
        return res.status(200).json({ points, totalPoints: 5, pass, perQuestion, shortResult, costUSD: r.costUSD });
      }
      const pass = points >= 4;
      return res.status(200).json({ points, totalPoints: 5, pass, perQuestion, shortResult, costUSD: 0 });
    }

    if (action === 'exam_dates') {
      const targets = Array.isArray(body.targets) && body.targets.length
        ? body.targets.slice(0, 6)
        : ['Goethe-Zertifikat A1/A2/B1 at Goethe-Institut Jakarta', 'JLPT (next sitting in Indonesia)', 'JFT-Basic (Prometric Indonesia, runs ~monthly)'];
      const r = await runClaude(examDatesPrompt(targets), { ...opts, maxTokens: 3000, useWeb: true, maxUses: 3 });
      const j = extractJson(r.text);
      if (!j || !Array.isArray(j.dates)) return parseFail(res, r, 'The date hunt came back empty — tap again.');
      const dates = j.dates
        .filter(d => d && d.label && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || '')))
        .slice(0, 10)
        .map(d => ({ id: String(d.id || '').slice(0, 40), label: String(d.label).slice(0, 80), date: d.date, note: String(d.note || '').slice(0, 200), url: String(d.url || '').slice(0, 300) }));
      return res.status(200).json({ dates, costUSD: r.costUSD });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error('wegweiser-ai error', msg);
    const friendly = /credit|billing|purchase/i.test(msg)
      ? 'Your Anthropic key has no credit — top up at console.anthropic.com.'
      : /authentication|x-api-key|invalid.*key/i.test(msg)
        ? 'Anthropic rejected the API key — re-check it in Settings → AI.'
        : msg;
    return res.status(500).json({ error: friendly });
  }
};
