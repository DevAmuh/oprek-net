// =============================================================
//  Escape Pipeline — AI brain  ->  /api/ai
// -------------------------------------------------------------
//  Uses the owner's Anthropic API key (Vercel env ANTHROPIC_API_KEY)
//  with Claude's native web_search tool to research live relocation
//  facts. The key lives ONLY here (server-side) and is never sent to
//  the browser. Every call is gated by the vault passphrase, verified
//  against Supabase, so only the owner can spend the key.
//
//  Required Vercel Environment Variable:
//    ANTHROPIC_API_KEY  - your Claude API key (console.anthropic.com)
// =============================================================

const SUPA_URL = 'https://pvgsrurcxssjqxshqkli.supabase.co';
const SUPA_KEY = 'sb_publishable_oDZbTs1Ssm92kTIqqzwqWQ_-31YHKOU';
const MODEL    = 'claude-opus-4-8';

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

// Run a request, following the server-tool loop (web search) up to a few hops.
async function runClaude(userText, useWeb, maxTokens){
  const msgs = [{ role: 'user', content: userText }];
  let last;
  for (let i = 0; i < 4; i++) {
    const body = { model: MODEL, max_tokens: maxTokens || 3000, output_config: { effort: 'low' }, messages: msgs };
    if (useWeb) body.tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }];
    last = await callClaude(body);
    if (last.stop_reason === 'pause_turn') { msgs.push({ role: 'assistant', content: last.content }); continue; }
    break;
  }
  return last;
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

    const action = body.action || 'country';

    if (action === 'country') {
      const country = String(body.country || '').slice(0, 60).trim();
      if (!country) return res.status(400).json({ error: 'No country given.' });
      const prompt =
        'You are a relocation research assistant for Amuh, a 26-year-old Indonesian citizen (Muslim) who currently has NO recognized professional credentials or work experience — so realistically he can only take LABOR work: agriculture, factory/manufacturing, hospitality, care, construction, dishwashing, warehouse. He is escaping the weak Indonesian rupiah for a strong-currency country. ' +
        'Research the CURRENT, REAL 2026 pathway for him to LEGALLY work in ' + country + '. Use web search for up-to-date facts: the exact visa/program name, whether a no-degree labor route exists, the language requirement, realistic monthly pay (with currency), any age cap, the concrete first step, an official link, and the main risk. ' +
        'Respond with ONLY one JSON object — no markdown, no code fence, no text before or after. Schema (keep every string short):\n' +
        '{"name": short UPPERCASE label (e.g. "QATAR"), "tag": "<program> · <sector>", "langLabel": e.g. "— none" or "🇩🇪 B1" or "🇸🇦 Arabic", "langNote": one line, "next": one concrete next step, "pay": monthly pay with an "≈ $X/mo" hint, "timeline": e.g. "intake opens Q3 2026" or "year-round", "laborEligible": true or false (can he do it with NO credentials?), "ageCap": text or null, "why": 1-2 sentences on why it is worth considering for a labor migrant, "risk": one sentence, "link": official URL}';
      const msg = await runClaude(prompt, true, 3500);
      const data = extractJson(textOf(msg));
      if (!data) return res.status(502).json({ error: 'AI returned no usable result — try again.' });
      return res.status(200).json({ ok: true, data });
    }

    if (action === 'next') {
      const ctx = String(body.context || '').slice(0, 4000);
      const prompt =
        "You are the momentum coach inside Amuh's personal relocation app. He is an Indonesian labor migrant escaping the weak rupiah; he researches endlessly and stalls before acting, and undervalues himself. Give him exactly ONE tiny, concrete step he can do TODAY — not a plan, not a list. Base it on his current state:\n" +
        ctx +
        '\n\nRespond with ONLY one JSON object: {"text": the one next action (imperative, max 8 words), "why": one short, warm, encouraging sentence}. No other text.';
      const msg = await runClaude(prompt, false, 800);
      const data = extractJson(textOf(msg));
      if (!data) return res.status(502).json({ error: 'AI had nothing — try again.' });
      return res.status(200).json({ ok: true, data });
    }

    return res.status(400).json({ error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
