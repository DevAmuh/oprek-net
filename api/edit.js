// =============================================================
//  Cloud editor backend  ->  /api/edit
// -------------------------------------------------------------
//  GET  /api/edit?page=graduation   -> returns the current HTML
//  POST /api/edit?page=graduation   -> publishes new HTML to GitHub
//
//  Runs as a Vercel Serverless Function. The GitHub token lives
//  ONLY here (as a Vercel Environment Variable) and is never sent
//  to the browser. Publishing is gated by EDIT_PASSWORD.
//
//  Required Vercel Environment Variables:
//    GH_TOKEN       - GitHub fine-grained token, Contents: Read+Write
//    EDIT_PASSWORD  - the password you type in the editor to publish
// =============================================================

const OWNER  = 'DevAmuh';
const REPO   = 'oprek-net';
const BRANCH = 'master';

// Only these pages can be edited (slug -> file path in the repo).
// To add another page later, add one line here and one <option> in
// edit/index.html.
const PAGES = {
  graduation: 'graduation/index.html',
  english:    'english/index.html',
  fireplace:  'fireplace/index.html',
  lab:        'lab/index.html',
};

function gh(path, options = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'oprek-cloud-editor',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    },
  });
}

module.exports = async (req, res) => {
  try {
    if (!process.env.GH_TOKEN) {
      return res.status(500).json({ error: 'Server not set up yet: GH_TOKEN is missing in Vercel.' });
    }

    const slug = String((req.query && req.query.page) || 'graduation');
    const filePath = PAGES[slug];
    if (!filePath) {
      return res.status(400).json({ error: `That page ("${slug}") can't be edited here.` });
    }

    // ---- LOAD the current page -------------------------------
    if (req.method === 'GET') {
      const r = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${BRANCH}`);
      if (!r.ok) {
        return res.status(502).json({ error: `Couldn't read the page from GitHub (${r.status}).` });
      }
      const data = await r.json();
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      return res.status(200).json({ page: slug, content });
    }

    // ---- PUBLISH a new version -------------------------------
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
      body = body || {};

      if (!process.env.EDIT_PASSWORD || body.password !== process.env.EDIT_PASSWORD) {
        return res.status(401).json({ error: 'Wrong password.' });
      }
      if (typeof body.content !== 'string' || body.content.trim() === '') {
        return res.status(400).json({ error: 'Nothing to publish — the editor is empty.' });
      }

      // Re-read the latest version to get the file SHA (GitHub needs it).
      const cur = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}?ref=${BRANCH}`);
      if (!cur.ok) {
        return res.status(502).json({ error: `Couldn't read the current page from GitHub (${cur.status}).` });
      }
      const curData = await cur.json();

      const put = await gh(`/repos/${OWNER}/${REPO}/contents/${filePath}`, {
        method: 'PUT',
        body: JSON.stringify({
          message: `${slug}: edit via cloud editor`,
          content: Buffer.from(body.content, 'utf8').toString('base64'),
          sha: curData.sha,
          branch: BRANCH,
        }),
      });
      if (!put.ok) {
        const txt = await put.text();
        return res.status(502).json({ error: `Publish failed (${put.status}). ${txt.slice(0, 300)}` });
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (e) {
    return res.status(500).json({ error: `Unexpected error: ${e && e.message ? e.message : e}` });
  }
};
