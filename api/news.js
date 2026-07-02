// =============================================================
//  Escape Pipeline — "Tailwinds" news aggregator  ->  /api/news
// -------------------------------------------------------------
//  Vercel Serverless Function (same origin, no CORS). Google
//  News RSS per topic (Google blocks datacenter IPs like Supabase
//  but NOT Vercel's), with Antara's English wire as fallback.
//
//  Query params:
//    ?t=taiwan,korea,gulf,poland   -> catalog topic ids to include
//    ?c=Finland,Qatar              -> free-text custom countries
//    ?catalog=1                    -> return the pickable catalog
//  No params -> a sensible default set. Edge-cached 30 min.
// =============================================================

const CATALOG = {
  // --- your routes ---  (q = English query · qid = Indonesian-edition query)
  taiwan:    { flag:'🇹🇼', label:'Taiwan',      section:'Your routes', q:'Indonesia migrant worker Taiwan OR Taiwan migrant worker policy', qid:'pekerja migran Taiwan OR PMI Taiwan OR SP2T Taiwan' },
  korea:     { flag:'🇰🇷', label:'Korea (EPS)', section:'Your routes', q:'Indonesia worker Korea EPS OR South Korea foreign worker visa', qid:'EPS Korea OR EPS-TOPIK OR pekerja migran Korea G2G' },
  japan:     { flag:'🇯🇵', label:'Japan (SSW)', section:'Your routes', q:'Indonesia worker Japan specified skilled worker OR Japan tokutei ginou', qid:'pekerja migran Jepang OR tokutei ginou OR SSW Jepang Indonesia' },
  germany:   { flag:'🇩🇪', label:'Germany',     section:'Your routes', q:'Indonesia Germany skilled worker visa OR Germany Ausbildung foreigner OR Fachkräfte Indonesia', qid:'kerja di Jerman OR Ausbildung Indonesia OR visa kerja Jerman' },
  australia: { flag:'🇦🇺', label:'Australia',   section:'Your routes', q:'Indonesia Australia working holiday visa OR Australia 462 visa OR Australia skilled migration Indonesia', qid:'working holiday visa Australia Indonesia OR visa 462 OR kerja di Australia' },
  // --- Gulf ---
  gulf:    { flag:'🕌', label:'Gulf (all)', section:'Gulf', q:'Indonesia migrant worker Gulf OR Gulf foreign worker visa reform' },
  saudi:   { flag:'🇸🇦', label:'Saudi',     section:'Gulf', q:'Indonesia worker Saudi Arabia OR Saudi Arabia foreign worker visa' },
  qatar:   { flag:'🇶🇦', label:'Qatar',     section:'Gulf', q:'Indonesia worker Qatar OR Qatar foreign worker visa' },
  uae:     { flag:'🇦🇪', label:'UAE',       section:'Gulf', q:'Indonesia worker UAE Dubai OR UAE golden visa foreign worker' },
  oman:    { flag:'🇴🇲', label:'Oman',      section:'Gulf', q:'Indonesia worker Oman OR Oman foreign worker visa' },
  kuwait:  { flag:'🇰🇼', label:'Kuwait',    section:'Gulf', q:'Indonesia worker Kuwait OR Kuwait foreign worker visa' },
  // --- Europe ---
  europe:      { flag:'🇪🇺', label:'Europe (all)', section:'Europe', q:'Indonesia worker Europe visa OR EU Blue Card Indonesia OR Schengen work visa Indonesia' },
  netherlands: { flag:'🇳🇱', label:'Netherlands',  section:'Europe', q:'Indonesia worker Netherlands OR Netherlands skilled migrant visa' },
  finland:     { flag:'🇫🇮', label:'Finland',      section:'Europe', q:'Indonesia worker Finland OR Finland work permit foreigner' },
  norway:      { flag:'🇳🇴', label:'Norway',       section:'Europe', q:'Indonesia worker Norway OR Norway work visa foreigner' },
  sweden:      { flag:'🇸🇪', label:'Sweden',       section:'Europe', q:'Indonesia worker Sweden OR Sweden work permit foreigner' },
  denmark:     { flag:'🇩🇰', label:'Denmark',      section:'Europe', q:'Indonesia worker Denmark OR Denmark positive list work visa' },
  ireland:     { flag:'🇮🇪', label:'Ireland',      section:'Europe', q:'Indonesia worker Ireland OR Ireland critical skills employment permit' },
  poland:      { flag:'🇵🇱', label:'Poland',       section:'Europe', q:'Indonesia worker Poland OR Poland work visa foreigner OR Poland Schengen work' },
  romania:     { flag:'🇷🇴', label:'Romania',      section:'Europe', q:'Indonesia worker Romania OR Romania work visa foreigner' },
  portugal:    { flag:'🇵🇹', label:'Portugal',     section:'Europe', q:'Indonesia worker Portugal OR Portugal job seeker visa' },
  // --- Asia-Pacific ---
  asia:       { flag:'🌏', label:'Asia (all)', section:'Asia-Pacific', q:'Indonesia migrant worker Asia visa OR Asia foreign worker program Indonesia' },
  malaysia:   { flag:'🇲🇾', label:'Malaysia',   section:'Asia-Pacific', q:'Indonesia worker Malaysia OR Malaysia foreign worker policy' },
  singapore:  { flag:'🇸🇬', label:'Singapore',  section:'Asia-Pacific', q:'Indonesia worker Singapore OR Singapore work permit foreigner' },
  hongkong:   { flag:'🇭🇰', label:'Hong Kong',  section:'Asia-Pacific', q:'Indonesia worker Hong Kong OR Hong Kong domestic worker visa' },
  newzealand: { flag:'🇳🇿', label:'New Zealand',section:'Asia-Pacific', q:'Indonesia worker New Zealand OR New Zealand working holiday visa Indonesia' },
  // --- Americas ---
  northamerica:{ flag:'🌎', label:'N. America (all)', section:'Americas', q:'Indonesia worker Canada United States visa OR North America immigration Indonesia' },
  canada:     { flag:'🇨🇦', label:'Canada',      section:'Americas', q:'Indonesia worker Canada OR Canada express entry OR Canada work permit Indonesia' },
  usa:        { flag:'🇺🇸', label:'USA',         section:'Americas', q:'Indonesia worker United States visa OR US work visa Indonesia' },
  // --- themes ---
  moves:  { flag:'🌐', label:'Openings & policy', section:'Themes', q:'Indonesia migrant worker opportunity 2026 OR Indonesia overseas job program OR Indonesia rupiah salary abroad', qid:'lowongan pekerja migran OR penempatan PMI OR program KP2MI BP2MI' },
  schengen:{ flag:'🛂', label:'Schengen pathways', section:'Themes', q:'Schengen work visa Indonesia OR EU residence permit Indonesia pathway citizenship', qid:'visa kerja Eropa Indonesia OR visa Schengen kerja' },
};
const SECTIONS = ['Your routes','Gulf','Europe','Asia-Pacific','Americas','Themes'];
const DEFAULT_TOPICS = ['taiwan','korea','japan','germany','australia','moves'];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36';

function decode(s){
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').trim();
}
function parseItems(xml, max){
  const out = []; const blocks = String(xml || '').split('<item>').slice(1); const seen = new Set();
  for (const b of blocks){
    const title = decode((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '');
    const link  = decode((b.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '');
    const pub   = decode((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
    const source= decode((b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '');
    const desc  = decode((b.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
    if (!title || !link) continue;
    const headline = title.replace(/\s+-\s+[^-]+$/, '').trim() || title;
    const key = headline.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue; seen.add(key);
    const ts = pub ? Date.parse(pub) : 0;
    out.push({ title: headline, link, source: source || '', desc, ts: isNaN(ts) ? 0 : ts, date: pub });
    if (out.length >= max) break;
  }
  return out;
}
async function fetchText(url, ms){
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), ms || 6000);
  try { const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' } });
    clearTimeout(to); return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) { clearTimeout(to); return { ok: false, status: 0, text: '', err: String(e) }; }
}
// when:30d = Google News recency operator; -site: excludes SEO spam at the source.
const withOps  = q => q + ' when:30d -site:y-axis.com';
const googleUrl = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(withOps(q)) + '&hl=en-ID&gl=ID&ceid=ID:en';
const googleIdUrl = q => 'https://news.google.com/rss/search?q=' + encodeURIComponent(withOps(q)) + '&hl=id&gl=ID&ceid=ID:id';
const bingUrl   = q => 'https://www.bing.com/news/search?q=' + encodeURIComponent(q) + '&format=rss';
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 24);
function hostOf(link){ try{ return new URL(link).hostname.replace(/^www\./,''); }catch(e){ return ''; } }

// Quality gate: fresh (≤60 days, dated), not from blocked SEO farms, and not
// India-targeted content (the reader is Indonesian) unless it mentions Indonesia.
const BLOCK = ['y-axis.com', 'y-axis'];
const MAX_AGE_MS = 60 * 86400000;
function keepItem(it){
  if (!it.ts || (Date.now() - it.ts) > MAX_AGE_MS) return false;
  const host = hostOf(it.link).toLowerCase();
  const src = (it.source || '').toLowerCase();
  if (BLOCK.some(b => host.includes(b) || src.includes(b))) return false;
  if (/\bindians?\b|\bindia'?s\b/i.test(it.title) && !/indonesia/i.test(it.title)) return false;
  return true;
}
function mergeDedupe(a, b){
  const out = a.slice(); const seen = new Set(a.map(x => x.title.toLowerCase().slice(0, 50)));
  for (const it of b){ const k = it.title.toLowerCase().slice(0, 50); if (!seen.has(k)){ seen.add(k); out.push(it); } }
  return out;
}

// Indonesian-edition query: explicit qid when curated, else built from the label.
function idQueryFor(entry, label){
  if (entry && entry.qid) return entry.qid;
  const base = String(label).replace(/\s*\(.*?\)\s*/g, '').trim();
  return 'pekerja migran ' + base + ' OR visa kerja ' + base + ' OR kerja di ' + base;
}
function buildTopics(req){
  const q = req.query || {};
  const t = (q.t ? String(q.t).split(',') : []).map(x => x.trim()).filter(x => CATALOG[x]);
  const c = (q.c ? String(q.c).split(',') : []).map(x => x.trim()).filter(Boolean);
  let topics = t.map(id => ({ id, flag: CATALOG[id].flag, label: CATALOG[id].label, q: CATALOG[id].q, qid: idQueryFor(CATALOG[id], CATALOG[id].label) }));
  for (const name of c){
    topics.push({ id: 'c_' + slug(name), flag: '🌍', label: name,
      q: 'Indonesia ' + name + ' work visa OR ' + name + ' foreign worker OR ' + name + ' immigration',
      qid: idQueryFor(null, name) });
  }
  if (!topics.length) topics = DEFAULT_TOPICS.map(id => ({ id, flag: CATALOG[id].flag, label: CATALOG[id].label, q: CATALOG[id].q, qid: idQueryFor(CATALOG[id], CATALOG[id].label) }));
  return topics.slice(0, 12);   // cap to keep it fast + within rate limits
}

module.exports = async (req, res) => {
  if (req.query && req.query.catalog){
    const catalog = Object.keys(CATALOG).map(id => ({ id, flag: CATALOG[id].flag, label: CATALOG[id].label, section: CATALOG[id].section }));
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.status(200).json({ sections: SECTIONS, catalog, defaults: DEFAULT_TOPICS });
  }
  const TOPICS = buildTopics(req);
  try {
    const results = await Promise.all(TOPICS.map(async (t) => {
      const [g, gi, b] = await Promise.all([
        fetchText(googleUrl(t.q)),
        fetchText(googleIdUrl(t.qid || t.q)),
        fetchText(bingUrl(t.q), 6000),
      ]);
      let items = g.ok ? parseItems(g.text, 10) : [];
      if (gi.ok) items = mergeDedupe(items, parseItems(gi.text, 10));
      if (b.ok){ const bing = parseItems(b.text, 6).map(x => ({ ...x, source: x.source || hostOf(x.link) })); items = mergeDedupe(items, bing); }
      items = items.filter(keepItem).sort((x, y) => y.ts - x.ts).slice(0, 14);
      return { id: t.id, flag: t.flag, label: t.label, items, _status: g.status };
    }));
    // Cross-group dedupe: the same story must not appear under several countries.
    const seenAll = new Set();
    for (const g of results){
      g.items = g.items.filter(it => {
        const k = it.title.toLowerCase().slice(0, 50);
        if (seenAll.has(k)) return false;
        seenAll.add(k); return true;
      }).slice(0, 8);
    }
    let total = results.reduce((a, g) => a + g.items.length, 0);
    let source = 'google';

    if (total === 0) {
      source = 'antara';
      const a = await fetchText('https://en.antaranews.com/rss/news', 8000);
      const all = a.ok ? parseItems(a.text, 60) : [];
      for (const g of results) g.items = [];
      const relevant = ['migrant','worker','visa','overseas','diaspora','labor','labour','job','placement','pmi','tenaga kerja','emigra'];
      const moves = results.find(g => g.id === 'moves') || results[results.length - 1];
      for (const it of all){
        const hay = (it.title + ' ' + it.desc).toLowerCase();
        if (!relevant.some(k => hay.includes(k))) continue;
        it.source = it.source || 'ANTARA';
        const hit = results.find(g => g.id !== 'moves' && (g.label && hay.includes(g.label.toLowerCase().split(' ')[0])));
        (hit || moves).items.push(it);
      }
      results.forEach(g => { g.items = g.items.slice(0, 7); });
      total = results.reduce((a, g) => a + g.items.length, 0);
    }

    if (req.query && req.query.debug){
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
