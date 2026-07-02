// =============================================================
//  Cloud editor backend  ->  /api/edit
// -------------------------------------------------------------
//  GET  /api/edit?health=1          -> setup self-check (booleans only)
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
// edit/index.html. Root index.html stays excluded on purpose: it is
// overwritten by the local deploy.bat, so cloud edits would be lost.
const PAGES = {
  graduation:         'graduation/index.html',   // thank-you page
  'graduation-login': 'graduation/login.html',
  'graduation-chart': 'graduation/chart.html',   // seat chart (behind login)
  escape:             'escape/index.html',
  english:            'english/index.html',
  fireplace:          'fireplace/index.html',
  lab:                'lab/index.html',
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
    const q = req.query || {};

    // ---- SETUP SELF-CHECK ------------------------------------
    // Returns only booleans - never secrets. Lets the editor (and
    // us) see exactly which link in the chain is broken.
    if (req.method === 'GET' && q.health) {
      const out = {
        ghToken:      !!process.env.GH_TOKEN,
        editPassword: (process.env.EDIT_PASSWORD || '').trim() !== '',
        canRead:      false,
        canWrite:     false,
      };
      if (out.ghToken) {
        const r = await gh(`/repos/${OWNER}/${REPO}/contents/${PAGES.graduation}?ref=${BRANCH}`);
        out.canRead = r.ok;
        // Write test: create an unreferenced git blob. Requires
        // Contents: write, but touches no branch, file, or history.
        const w = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, {
          method: 'POST',
          body: JSON.stringify({ content: 'editor-health-check', encoding: 'utf-8' }),
        });
        out.canWrite = w.status === 201;
      }
      return res.status(200).json(out);
    }

    if (!process.env.GH_TOKEN) {
      return res.status(500).json({ error: 'Server not set up yet: GH_TOKEN is missing in Vercel.' });
    }

    const slug = String(q.page || 'graduation');
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

      const expected = (process.env.EDIT_PASSWORD || '').trim();
      if (!expected) {
        return res.status(500).json({
          error: 'Setup incomplete: EDIT_PASSWORD is not set in Vercel. Add it under Settings → Environment Variables, then redeploy.',
        });
      }
      const supplied = typeof body.password === 'string' ? body.password.trim() : '';
      if (supplied !== expected) {
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
        // GitHub answers 404/403 to writes the token isn't allowed to make.
        const hint = (put.status === 404 || put.status === 403)
          ? ' This usually means the GitHub token can\'t WRITE — on GitHub, edit the token: Permissions → Contents → "Read and write".'
          : '';
        return res.status(502).json({ error: `Publish failed (${put.status}).${hint} ${txt.slice(0, 300)}` });
      }
      const putData = await put.json().catch(() => ({}));
      return res.status(200).json({ ok: true, commit: putData.commit ? putData.commit.sha : null });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (e) {
    return res.status(500).json({ error: `Unexpected error: ${e && e.message ? e.message : e}` });
  }
};
