// =============================================================
//  Escape Pipeline — AI brain  ->  /api/ai
// -------------------------------------------------------------
//  Uses the owner's Anthropic API key (Vercel env ANTHROPIC_API_KEY)
//  with Claude's native web_search tool to research live relocation
//  facts. The key lives ONLY here (server-side) and is never sent to
//  the browser. Every call is gated by the vault passphrase, verified
//  against Supabase, so only the owner can spend the key.
//
//  Cost controls: model allowlist (Haiku default), max 3 web searches,
//  3 loop rounds, 40s time budget, and every response reports its
//  estimated costUSD so the client can keep a running spend meter.
//
//  Required Vercel Environment Variable:
//    ANTHROPIC_API_KEY  - your Claude API key (console.anthropic.com)
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

async function callClaude(body){
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('Claude API error ' + r.status));
  return j;
}

// Run a request, following the server-tool loop (web search) with hard
// budgets: max 3 rounds, max 3 searches, ~40s wall clock. Accumulates
// token/search usage across rounds and returns the estimated cost.
async function runClaude(userText, opts){
  const m = opts.model;
  const msgs = [{ role: 'user', content: userText }];
  const used = { input: 0, output: 0, searches: 0 };
  const t0 = Date.now();
  let last;
  for (let i = 0; i < 3; i++) {
    const body = { model: m.id, max_tokens: opts.maxTokens || 2500, messages: msgs };
    if (m.effortOK) body.output_config = { effort: opts.effort || 'low' };
    if (opts.useWeb) body.tools = [{ type: m.search, name: 'web_search', max_uses: 3 }];
    last = await callClaude(body);
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
  return { msg: last, costUSD: Math.round(cost * 10000) / 10000 };
}

function textOf(msg){ return (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n'); }
function extractJson(t){ const m = t && t.match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } }

module.exports = async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'AI not set up yet — add ANTHROPIC_API_KEY in Vercel → Settings → Environment Variables, then redeploy.' });
    }
    if (!(await verifyPass(body.pass))) {
      return res.status(401).json({ error: 'Locked — unlock the app first.' });
    }

    const modelKey = MODELS[body.model] ? body.model : 'haiku';
    const model = MODELS[modelKey];
    const effort = EFFORTS.includes(body.effort) ? body.effort : 'low';
    const action = body.action || 'country';
    const send = (data, costUSD) => res.status(200).json({ ok: true, data, costUSD: costUSD || 0, modelUsed: modelKey });
    const persona = 'Amuh, a 26-year-old Indonesian citizen (Muslim) with NO recognized professional credentials or work experience — realistically he can only take LABOR work: agriculture, factory/manufacturing, hospitality, care, construction, dishwashing, warehouse. He is escaping the weak Indonesian rupiah for a strong-currency country.';

    if (action === 'country') {
      const country = String(body.country || '').slice(0, 60).trim();
      if (!country) return res.status(400).json({ error: 'No country given.' });
      const prompt =
        'You are a relocation research assistant for ' + persona + ' ' +
        'Research the CURRENT, REAL 2026 pathway for him to LEGALLY work in ' + country + '. Use web search (English and Indonesian sources) for up-to-date facts: the exact visa/program name, whether a no-degree labor route exists, the language requirement, realistic monthly pay (with currency), any age cap, the concrete first step, an official link, and the main risk. ' +
        'Respond with ONLY one JSON object — no markdown, no code fence, no text before or after. Schema (keep every string short):\n' +
        '{"name": short UPPERCASE label (e.g. "QATAR"), "tag": "<program> · <sector>", "langLabel": e.g. "— none" or "🇩🇪 B1" or "🇸🇦 Arabic", "langNote": one line, "next": one concrete next step, "pay": monthly pay with an "≈ $X/mo" hint, "timeline": e.g. "intake opens Q3 2026" or "year-round", "laborEligible": true or false (can he do it with NO credentials?), "ageCap": text or null, "why": 1-2 sentences on why it is worth considering for a labor migrant, "risk": one sentence, "link": official URL}';
      const r = await runClaude(prompt, { model, effort, useWeb: true, maxTokens: 2500 });
      const data = extractJson(textOf(r.msg));
      if (!data) return res.status(502).json({ error: 'AI returned no usable result — try again.' });
      return send(data, r.costUSD);
    }

    if (action === 'next') {
      const ctx = String(body.context || '').slice(0, 4000);
      const prompt =
        "You are the momentum coach inside Amuh's personal relocation app. He is an Indonesian labor migrant escaping the weak rupiah; he researches endlessly and stalls before acting, and undervalues himself. Give him exactly ONE tiny, concrete step he can do TODAY — not a plan, not a list. Base it on his current state:\n" +
        ctx +
        '\n\nRespond with ONLY one JSON object: {"text": the one next action (imperative, max 8 words), "why": one short, warm, encouraging sentence}. No other text.';
      const r = await runClaude(prompt, { model, effort, useWeb: false, maxTokens: 800 });
      const data = extractJson(textOf(r.msg));
      if (!data) return res.status(502).json({ error: 'AI had nothing — try again.' });
      return send(data, r.costUSD);
    }

    if (action === 'windows') {
      const prompt =
        'You research Indonesian labor-migration programs. Find the CURRENT (as of today) registration/intake status of these three official programs for Indonesians. Use web search and prioritize official Indonesian sources (KP2MI/BP2MI, siskop2mi.bp2mi.go.id, HRD-Korea EPS Indonesia, JFT-Basic / Prometric Indonesia):\n' +
        '1. Taiwan SP2T (government-to-government via SISKOP2MI)\n' +
        '2. Korea EPS — the next EPS-TOPIK registration/exam round for Indonesians\n' +
        '3. Japan SSW — the next JFT-Basic / skills-test schedule in Indonesia\n' +
        'Respond with ONLY one JSON object: {"routes":[{"id":"taiwan_sp2t"|"korea_eps"|"japan_ssw","window":"short current status — include a date in YYYY-MM-DD form if one is known","next":"one concrete step","link":"official URL"}],"note":"one line overall"}. Include all three routes even if a window is closed (say so).';
      const r = await runClaude(prompt, { model, effort, useWeb: true, maxTokens: 1500 });
      const data = extractJson(textOf(r.msg));
      if (!data || !Array.isArray(data.routes)) return res.status(502).json({ error: 'No window info found — try again.' });
      return send(data, r.costUSD);
    }

    if (action === 'news') {
      const topics = String(body.topics || '').slice(0, 300) || 'Taiwan, Korea, Japan, Germany, Australia';
      const prompt =
        'You are a news scout for ' + persona + ' ' +
        'Web-search (Indonesian AND English sources) for the most useful developments of the LAST 30 DAYS for Indonesian migrant workers heading to: ' + topics + '. ' +
        'Prioritize: new visa rules, intake/registration openings, quota changes, pay/minimum-wage changes, warnings (scams, bans). Skip India-focused content and consultancy ads. ' +
        'Respond with ONLY one JSON object: {"summary":"1-2 sentences — the big picture this month","items":[{"title":"short headline","gist":"one line on why it matters to him","link":"source URL","country":"country name"}]}. Max 6 items, most useful first. If a route has nothing new, leave it out.';
      const r = await runClaude(prompt, { model, effort, useWeb: true, maxTokens: 1800 });
      const data = extractJson(textOf(r.msg));
      if (!data || !Array.isArray(data.items)) return res.status(502).json({ error: 'Scan came back empty — try again.' });
      return send(data, r.costUSD);
    }

    if (action === 'ask') {
      const q = String(body.q || '').slice(0, 500).trim();
      if (!q) return res.status(400).json({ error: 'No question given.' });
      const prompt =
        'You answer one question for ' + persona + ' ' +
        'Use web search if the answer needs current facts (fees, dates, rules). Be concrete and current — name amounts, dates and offices. His question:\n"' + q.replace(/"/g, "'") + '"\n' +
        'Respond with ONLY one JSON object: {"answer":"plain-text answer, max 120 words, warm but factual","links":[{"t":"short source label","u":"URL"}]}. Max 3 links.';
      const r = await runClaude(prompt, { model, effort, useWeb: true, maxTokens: 1200 });
      const data = extractJson(textOf(r.msg));
      if (!data || !data.answer) return res.status(502).json({ error: 'No answer came back — try again.' });
      return send(data, r.costUSD);
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
