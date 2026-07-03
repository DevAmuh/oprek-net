// =============================================================
//  Escape Pipeline — AI brain  ->  /api/ai
// -------------------------------------------------------------
//  BRING-YOUR-OWN-KEY: each user supplies their own Anthropic API key
//  (stored E2E-encrypted in their vault, sent per request, forwarded to
//  Anthropic, never logged or persisted here). Claude's native web_search
//  researches live relocation facts. Every call is auth-gated against the
//  Supabase vault, so only a vault owner can trigger spend on their key.
//
//  Cost controls: model allowlist (Haiku default), max 3 web searches,
//  3 loop rounds, 40s time budget, and every response reports its
//  estimated costUSD so the client can keep a running spend meter.
// =============================================================

const SUPA_URL = 'https://pvgsrurcxssjqxshqkli.supabase.co';
const SUPA_KEY = 'sb_publishable_oDZbTs1Ssm92kTIqqzwqWQ_-31YHKOU';

// Allowlisted models. Haiku 4.5 only supports the older web_search tool
// variant and rejects output_config.effort — hence per-model flags.
// inPerM/outPerM = USD per million tokens; web search = $0.01/search.
const MODELS = {
  haiku:  { id: 'claude-haiku-4-5', search: 'web_search_20250305', effortOK: false, inPerM: 1, outPerM: 5 },
  sonnet: { id: 'claude-sonnet-5',  search: 'web_search_20260209', effortOK: true,  inPerM: 2, outPerM: 10 },
  opus:   { id: 'claude-opus-4-8',  search: 'web_search_20260209', effortOK: true,  inPerM: 5, outPerM: 25 },
};
const EFFORTS = ['low', 'medium', 'high'];

// Verify the passphrase against the private vault (reuses the login RPC).
async function verifyPass(pass){
  if (!pass || String(pass).length < 6) return false;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/escape_login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
      body: JSON.stringify({ p_pass: pass }),
    });
    return r.ok;
  } catch (e) { return false; }
}
// Multi-user auth: uname + PBKDF2-derived auth key, verified via the
// escape_u_login RPC (bcrypt server-side). Data stays E2E-encrypted;
// this only proves the caller owns the vault before spending the AI key.
async function verifyUser(uname, auth){
  if (!uname || !auth || String(auth).length < 32) return false;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/escape_u_login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
      body: JSON.stringify({ p_uname: uname, p_auth: auth }),
    });
    return r.ok;
  } catch (e) { return false; }
}
// Temporary maintenance gate: a short-lived token that lives ONLY in the
// database (escape_test_ok RPC). Once the row is deleted this always fails.
async function verifyTestToken(t){
  if (!t || String(t).length < 20) return false;
  try {
    const r = await fetch(SUPA_URL + '/rest/v1/rpc/escape_test_ok', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY },
      body: JSON.stringify({ p_t: t }),
    });
    if (!r.ok) return false;
    return (await r.text()).indexOf('true') >= 0;
  } catch (e) { return false; }
}

async function callClaude(body, apiKey){
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('Claude API error ' + r.status));
  return j;
}

// IMPORTANT: when Claude cites web-search results, its answer arrives SPLIT
// across many text blocks (one per citation span) — join with '' (not '\n')
// or literal newlines land inside JSON string values and break JSON.parse.
function textOf(msg){ return (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join(''); }

// Run a request, following the server-tool loop (web search) with hard
// budgets: max 3 rounds, max 3 searches, ~40s wall clock. Accumulates
// token/search usage AND text across rounds; returns the estimated cost.
async function runClaude(userText, opts){
  const m = opts.model;
  const msgs = [{ role: 'user', content: userText }];
  const used = { input: 0, output: 0, searches: 0 };
  const t0 = Date.now();
  let last, allText = '';
  for (let i = 0; i < 3; i++) {
    const body = { model: m.id, max_tokens: opts.maxTokens || 2500, messages: msgs };
    if (m.effortOK) body.output_config = { effort: opts.effort || 'low' };
    if (opts.useWeb) body.tools = [{ type: m.search, name: 'web_search', max_uses: 3 }];
    last = await callClaude(body, opts.apiKey);
    allText += textOf(last);
    if (last.usage) {
      used.input  += last.usage.input_tokens  || 0;
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
  return { msg: last, text: allText, stop: last && last.stop_reason,
    costUSD: Math.round(cost * 10000) / 10000 };
}

// Tolerant JSON extraction: try the greedy {...} match as-is, then with
// control characters inside repaired to spaces, then from the LAST '{'.
function tryParse(s){ try { return JSON.parse(s); } catch (e) { return null; } }
function extractJson(t){
  if (!t) return null;
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  const raw = m[0];
  let j = tryParse(raw);
  if (!j) j = tryParse(raw.replace(/[\r\n\t]+/g, ' '));
  if (!j) {
    const i = t.lastIndexOf('{');
    if (i >= 0) j = tryParse(t.slice(i).replace(/[\r\n\t]+/g, ' '));
  }
  return j;
}

// Uniform failure reply: log detail to Vercel runtime logs + expose a small
// debug hint so the problem is diagnosable from the response itself.
function parseFail(res, r, friendly){
  const t = r.text || '';
  console.error('AI parse fail', { stop: r.stop, len: t.length, head: t.slice(0, 200), tail: t.slice(-200) });
  const msg = r.stop === 'max_tokens' ? 'The answer got cut off mid-write — tap again (it usually fits on retry).' : friendly;
  return res.status(502).json({ error: msg, debug: { stop: r.stop, len: t.length, tail: t.slice(-160) } });
}

module.exports = async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    if (!(await verifyUser(body.uname, body.auth)) && !(await verifyPass(body.pass)) && !(await verifyTestToken(body.testToken))) {
      return res.status(401).json({ error: 'Locked — unlock the app first.' });
    }
    // Bring-your-own-key: every user pays for their own AI. The key arrives
    // per-request (stored E2E-encrypted in their vault), is forwarded to
    // Anthropic and never logged or persisted here.
    const apiKey = String(body.apiKey || '').trim();
    if (apiKey.length < 20) {
      return res.status(402).json({ error: 'Smart features are off — add YOUR Claude API key in Settings → 🤖 AI (console.anthropic.com, a few cents per use).' });
    }

    const modelKey = MODELS[body.model] ? body.model : 'haiku';
    const model = MODELS[modelKey];
    const effort = EFFORTS.includes(body.effort) ? body.effort : 'low';
    const action = body.action || 'country';
    const TODAY = new Date().toISOString().slice(0, 10);
    // The model sometimes embeds <cite index="..."> markers inside JSON string
    // values when it cites search results — strip them from every string.
    const stripCites = (x) => {
      if (typeof x === 'string') return x.replace(/<\/?cite[^>]*>/g, '');
      if (Array.isArray(x)) return x.map(stripCites);
      if (x && typeof x === 'object') { const o = {}; for (const k of Object.keys(x)) o[k] = stripCites(x[k]); return o; }
      return x;
    };
    const send = (data, costUSD) => res.status(200).json({ ok: true, data: stripCites(data), costUSD: costUSD || 0, modelUsed: modelKey });
    // His situation (the 5W1H): the client sends a live snapshot built from the
    // whole tracker + his own "About me" notes; fall back to the baseline.
    const BASE_PERSONA = 'an Indonesian labor migrant with NO recognized professional credentials or degree-based work experience — realistically limited to LABOR work: agriculture, factory/manufacturing, hospitality, care, construction, dishwashing, warehouse. They are escaping the weak Indonesian rupiah for a strong-currency country.';
    const profile = String(body.profile || '').slice(0, 2500).trim();
    const persona = profile ? (BASE_PERSONA + '\nHis current situation (live from his tracker):\n' + profile + '\n') : BASE_PERSONA;
    const NO_NARRATE = ' Do not narrate your searching or thinking. After searching, output ONLY the JSON object.';

    if (action === 'country') {
      const country = String(body.country || '').slice(0, 60).trim();
      if (!country) return res.status(400).json({ error: 'No country given.' });
      const prompt =
        'You are a relocation research assistant for ' + persona + ' ' +
        'Research the CURRENT, REAL 2026 pathway for him to LEGALLY work in ' + country + '. Use web search (English and Indonesian sources) for up-to-date facts: the exact visa/program name, whether a no-degree labor route exists, the language requirement, realistic monthly pay (with currency), any age cap, the concrete first step, an official link, and the main risk. ' +
        'Respond with ONLY one JSON object — no markdown, no code fence, no text before or after. Schema (keep every string short):\n' +
        '{"name": short UPPERCASE label (e.g. "QATAR"), "tag": "<program> · <sector>", "langLabel": e.g. "— none" or "🇩🇪 B1" or "🇸🇦 Arabic", "langNote": one line, "next": one concrete next step, "pay": monthly pay with an "≈ $X/mo" hint, "timeline": e.g. "intake opens Q3 2026" or "year-round", "laborEligible": true or false (can he do it with NO credentials?), "ageCap": text or null, "why": 1-2 sentences on why it is worth considering for a labor migrant, "risk": one sentence, "link": official URL}' +
        NO_NARRATE;
      const r = await runClaude(prompt, { model, effort, apiKey, useWeb: true, maxTokens: 3000 });
      const data = extractJson(r.text);
      if (!data) return parseFail(res, r, 'AI returned no usable result — try again.');
      return send(data, r.costUSD);
    }

    if (action === 'next') {
      const ctx = String(body.context || '').slice(0, 4000);
      const prompt =
        "You are the momentum coach inside Amuh's personal relocation app. He is an Indonesian labor migrant escaping the weak rupiah; he researches endlessly and stalls before acting, and undervalues himself. Give him exactly ONE tiny, concrete step he can do TODAY — not a plan, not a list. Base it on his current state:\n" +
        ctx +
        '\n\nRespond with ONLY one JSON object: {"text": the one next action (imperative, max 8 words), "why": one short, warm, encouraging sentence}. No other text.';
      const r = await runClaude(prompt, { model, effort, apiKey, useWeb: false, maxTokens: 800 });
      const data = extractJson(r.text);
      if (!data) return parseFail(res, r, 'AI had nothing — try again.');
      return send(data, r.costUSD);
    }

    if (action === 'windows') {
      const routesList = String(body.routes || '').slice(0, 500) ||
        '1. Taiwan SP2T (government-to-government via SISKOP2MI)\n2. Korea EPS — EPS-TOPIK rounds for Indonesians\n3. Japan SSW — JFT-Basic / skills-test schedule in Indonesia';
      const prompt =
        'Today is ' + TODAY + '. You research Indonesian labor-migration programs so the user can PREPARE AND ANTICIPATE what is coming — the future, not the past. For each of their routes below, find the NEXT registration/intake round, upcoming exam dates, quota openings or announcement dates AFTER today. Use web search; prioritize official Indonesian sources (KP2MI/BP2MI, siskop2mi.bp2mi.go.id, HRD-Korea EPS Indonesia, JFT-Basic / Prometric, embassy pages). Their routes:\n' + routesList + '\n' +
        'Respond with ONLY one JSON object: {"routes":[{"id":"<the route id given>","window":"what is coming next — include a date in YYYY-MM-DD form if one is known; if the last round just closed, say when the NEXT one is expected","next":"one concrete preparation step to be ready BEFORE that date","link":"official URL"}],"events":[{"title":"short event name","date":"YYYY-MM-DD","desc":"one line on how to prepare"}],"note":"one line overall"}. ' +
        'STRICT RULE: every date in "events" MUST be ON or AFTER ' + TODAY + ' — never list past dates (mention closed rounds only inside "window" text). If an exact future date is unannounced, give the expected month/quarter in the window text instead of a fake date. Max 8 events.' +
        NO_NARRATE;
      const r = await runClaude(prompt, { model, effort, apiKey, useWeb: true, maxTokens: 1800 });
      const data = extractJson(r.text);
      if (!data || !Array.isArray(data.routes)) return parseFail(res, r, 'No window info found — try again.');
      return send(data, r.costUSD);
    }

    if (action === 'news') {
      const topics = String(body.topics || '').slice(0, 300) || 'Taiwan, Korea, Japan, Germany, Australia';
      const prompt =
        'You are a news scout for ' + persona + ' ' +
        'Today is ' + TODAY + '. Web-search (Indonesian AND English sources) for what matters NOW and NEXT for Indonesian migrant workers heading to: ' + topics + '. ' +
        'Prioritize FORWARD-LOOKING items they can prepare for: upcoming registration/intake openings, announced future exam dates, quota changes taking effect, new visa rules coming, pay rises scheduled — then warnings (scams, bans). Skip India-focused content, consultancy ads, and stale evergreen pieces. ' +
        'Respond with ONLY one JSON object: {"summary":"1-2 sentences — the big picture this month","items":[{"title":"short headline","gist":"one line on why it matters to him","link":"source URL","country":"country name"}]}. Max 6 items, most useful first. If a route has nothing new, leave it out.' +
        NO_NARRATE;
      const r = await runClaude(prompt, { model, effort, apiKey, useWeb: true, maxTokens: 2000 });
      const data = extractJson(r.text);
      if (!data || !Array.isArray(data.items)) return parseFail(res, r, 'Scan came back empty — try again.');
      return send(data, r.costUSD);
    }

    if (action === 'ask') {
      const q = String(body.q || '').slice(0, 500).trim();
      if (!q) return res.status(400).json({ error: 'No question given.' });
      const prompt =
        'You answer one question for ' + persona + ' ' +
        'Use web search if the answer needs current facts (fees, dates, rules). Be concrete and current — name amounts, dates and offices. His question:\n"' + q.replace(/"/g, "'") + '"\n' +
        'Respond with ONLY one JSON object: {"answer":"plain-text answer, max 120 words, warm but factual","links":[{"t":"short source label","u":"URL"}]}. Max 3 links.' +
        NO_NARRATE;
      const r = await runClaude(prompt, { model, effort, apiKey, useWeb: true, maxTokens: 1200 });
      const data = extractJson(r.text);
      if (!data || !data.answer) return parseFail(res, r, 'No answer came back — try again.');
      return send(data, r.costUSD);
    }

    if (action === 'col') {
      const list = String(body.currencies || '').slice(0, 400) || 'USD (United States), TWD (Taiwan)';
      const prompt =
        'You research cost-of-living facts for an Indonesian labor migrant comparing destination countries. For EACH currency/country in this list: ' + list + ' — find CURRENT typical prices in LOCAL currency: a cheap restaurant meal, a regular cappuccino, a cheap room / shared-flat rent per month, a basic clinic visit for a foreigner, and the statutory minimum MONTHLY wage (if none exists, the typical monthly pay for low-skill labor; say which in the note). Use web search sparingly — approximate is fine. ' +
        'Respond with ONLY one JSON object keyed by 3-letter currency code, e.g. {"TWD":{"country":"Taiwan","meal":120,"coffee":60,"rent":8000,"medical":400,"minWage":29500,"note":"statutory; dorm often provided"},"KRW":{...}}. Numbers only (no strings) for meal/coffee/rent/medical/minWage.' +
        NO_NARRATE;
      const r = await runClaude(prompt, { model, effort, apiKey, useWeb: true, maxTokens: 2200 });
      const data = extractJson(r.text);
      if (!data || typeof data !== 'object') return parseFail(res, r, 'No cost data came back — try again.');
      return send(data, r.costUSD);
    }

    if (action === 'docpack') {
      const purpose = String(body.purpose || '').slice(0, 160).trim();
      if (!purpose) return res.status(400).json({ error: 'No purpose given.' });
      const prompt =
        'You are a document-checklist assistant for ' + persona + ' ' +
        'List the CONCRETE documents he must gather for this purpose: "' + purpose.replace(/"/g, "'") + '". Use web search for the current official requirements (prefer Indonesian sources — KP2MI/BP2MI, embassies). Include Indonesian-issued documents (passport, SKCK, MCU, apostille/legalization, certificates) AND program-specific paperwork. ' +
        'Respond with ONLY one JSON object: {"docs":[{"label":"short document name","why":"one line on what it is for / where to get it","critical":true or false}],"note":"one line overall"}. Max 10 docs, most important first. Do not repeat generic advice.' +
        NO_NARRATE;
      const r = await runClaude(prompt, { model, effort, apiKey, useWeb: true, maxTokens: 1800 });
      const data = extractJson(r.text);
      if (!data || !Array.isArray(data.docs)) return parseFail(res, r, 'No checklist came back — try again.');
      return send(data, r.costUSD);
    }

    if (action === 'compare') {
      const items = String(body.items || '').slice(0, 3000).trim();
      if (!items) return res.status(400).json({ error: 'Nothing to compare.' });
      const prompt =
        'Today is ' + TODAY + '. You are a brutally honest relocation strategist for ' + persona + ' ' +
        'They are about to bet YEARS of their life (a non-renewable resource — mind any age caps) on ONE destination. Stress-test these candidates against each other. Use web search sparingly to check anything time-critical (quotas, upcoming rounds, rule changes). Candidates with their known facts:\n' + items + '\n' +
        'Respond with ONLY one JSON object:\n' +
        '{"countries":{"<NAME>":{"s":["2-4 concrete strengths"],"w":["2-4 concrete weaknesses"],"o":["1-3 opportunities ahead"],"t":["1-3 threats/risks"],"verdict":"one blunt line"}},"recommendation":"3-5 sentences: name ONE country to commit to first and WHY, grounded in their specific situation (age cap, money, documents, languages), plus what would change your answer."}\n' +
        'Be specific with numbers and dates, not generic. If a candidate is a bad fit, say so plainly.' +
        NO_NARRATE;
      const r = await runClaude(prompt, { model, effort, apiKey, useWeb: true, maxTokens: 2800 });
      const data = extractJson(r.text);
      if (!data || !data.countries) return parseFail(res, r, 'The comparison came back empty — try again.');
      return send(data, r.costUSD);
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
