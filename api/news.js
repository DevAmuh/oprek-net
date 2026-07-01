// =============================================================
//  Escape Pipeline — "Tailwinds" news aggregator  ->  /api/news
// -------------------------------------------------------------
//  Runs as a Vercel Serverless Function (same origin as the app,
//  so no CORS). Primary source is Google News RSS (fetched from
//  Vercel's egress IP). If Google blocks the server, it falls
//  back to Antara's English wire, filtered for relevance.
//  No API key. Cached at the edge for 30 min.
// =============================================================

const TOPICS = [
  { id:'taiwan',    flag:'🇹🇼', label:'Taiwan · factory / SP2T', q:'Indonesia migrant worker Taiwan OR Taiwan migrant worker policy',
    kw:['taiwan','sp2t'] },
  { id:'korea',     flag:'🇰🇷', label:'Korea · EPS', q:'Indonesia worker Korea EPS OR South Korea foreign worker visa',
    kw:['korea','eps','korean'] },
  { id:'japan',     flag:'🇯🇵', label:'Japan · SSW', q:'Indonesia worker Japan specified skilled worker OR Japan tokutei ginou',
    kw:['japan','ssw','tokutei','japanese'] },
  { id:'germany',   flag:'🇩🇪', label:'Germany · Ausbildung', q:'Indonesia Germany skilled worker visa OR Germany Ausbildung foreigner OR Fachkräfte Indonesia',
    kw:['germany','german','ausbildung','fachkräfte','deutschland'] },
  { id:'australia', flag:'🇦🇺', label:'Australia · WHV 462', q:'Indonesia Australia working holiday visa OR Australia 462 visa OR Australia skilled migration Indonesia',
    kw:['australia','462','whv','working holiday'] },
  { id:'moves',     flag:'🌏', label:'Openings & policy shifts', q:'Indonesia migrant worker opportunity 2026 OR Indonesia overseas job program OR Indonesia rupiah salary abroad',
    kw:['migrant','visa','overseas','diaspora','rupiah','worker','emigra','placement','tenaga kerja','pmi'] },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

function decode(s){
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .trim();
}

function parseItems(xml, max){
  const out = [];
  const blocks = String(xml || '').split('<item>').slice(1);
  const seen = new Set();
  for (const b of blocks){
    const title = decode((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const link  = decode((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    const pub   = decode((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
    const source= decode((b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
    const desc  = decode((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
    if (!title || !link) continue;
    const headline = title.replace(/\s+-\s+[^-]+$/, '').trim() || title;
    const key = headline.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const ts = pub ? Date.parse(pub) : 0;
    out.push({ title: headline, link, source: source || '', desc, ts: isNaN(ts) ? 0 : ts, date: pub });
    if (out.length >= max) break;
  }
  return out;
}

async function fetchText(url, ms){
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || 7000);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' } });
    clearTimeout(to);
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) {
    clearTimeout(to);
    return { ok: false, status: 0, text: '', err: String(e) };
  }
}

function googleUrl(q){
  return 'https://news.google.com/rss/search?q=' + encodeURIComponent(q) + '&hl=en-ID&gl=ID&ceid=ID:en';
}

module.exports = async (req, res) => {
  const debug = req.query && req.query.debug;
  try {
    // ---- primary: Google News, one query per topic ----
    const results = await Promise.all(TOPICS.map(async (t) => {
      const r = await fetchText(googleUrl(t.q));
      const items = r.ok ? parseItems(r.text, 7) : [];
      return { id: t.id, flag: t.flag, label: t.label, items, _status: r.status };
    }));
    let total = results.reduce((a, g) => a + g.items.length, 0);
    let source = 'google';

    // ---- fallback: Antara English wire, filtered + bucketed ----
    if (total === 0) {
      source = 'antara';
      const a = await fetchText('https://en.antaranews.com/rss/news', 8000);
      const all = a.ok ? parseItems(a.text, 60) : [];
      for (const g of results) g.items = [];
      const relevant = ['migrant','worker','visa','overseas','diaspora','labor','labour','job','placement','pmi','tenaga kerja','emigra',
        'taiwan','korea','japan','germany','australia','malaysia','saudi','hong kong'];
      for (const it of all){
        const hay = (it.title + ' ' + it.desc).toLowerCase();
        if (!relevant.some(k => hay.includes(k))) continue;
        it.source = it.source || 'ANTARA';
        let placed = false;
        for (const t of TOPICS){
          if (t.id === 'moves') continue;
          if (t.kw.some(k => hay.includes(k))){ results.find(g => g.id === t.id).items.push(it); placed = true; break; }
        }
        if (!placed) results.find(g => g.id === 'moves').items.push(it);
      }
      results.forEach(g => { g.items = g.items.slice(0, 7); });
      total = results.reduce((a, g) => a + g.items.length, 0);
    }

    if (debug){
      res.setHeader('Content-Type', 'application/json');
      return res.status(200).json({ source, total, statuses: results.map(g => ({ id: g.id, n: g.items.length, s: g._status })) });
    }
    results.forEach(g => { delete g._status; g.items.forEach(i => { delete i.desc; delete i.ts; }); });
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).json({ updated: new Date().toISOString(), source, total, groups: results });
  } catch (e) {
    return res.status(500).json({ error: String(e && e.message || e), groups: [] });
  }
};
