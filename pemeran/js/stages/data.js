// =============================================================
// Pemeran — Stage: Data & Tujuan (V2b — merges Setup + CP + TP + KKTP)
// -------------------------------------------------------------
// Desktop: split-pane — LEFT is the identity/config form (mapel/kelas/TA/
// JP knobs/guru — same logic setup.js used to own), RIGHT is the CP panel,
// verbatim/read-only for a national or pre-transcribed mapel ("so teachers
// see what they're working with"), or an editable/AI-draftable mulok editor
// when there's no cpFile at all. Below both panes, full-width: the TP table
// (kode/elemen/rumusan/bloom, per-row 🔄) with KKTP as an expandable
// <details> detail row per TP (auto 1:1 — every TP always has exactly one
// KKTP, kept in sync on add/remove). "⚡ Kerangka Instan" + the owner-only
// "✨ Generate Semuanya" chain both live here via oneshot.js.
//
// Mobile (<1000px, see css/paper.css .split-pane): the two panes stack;
// the CP panel and the TP&KKTP block are both wrapped in `.collapse-card`
// (<details>, open by default) so they can be collapsed to save space.
//
// V2b #7 — a TP's `kode` is now an editable field (it used to be locked
// post-generation). Renaming one cascades via pipeline.renameTpKode()
// through its KKTP (code + tpKode), any ATP unit.tpKodes, and any RPP
// entry's cached unit.tpList/kktpList — see that function's tests in
// pipeline.test.js.
// =============================================================

import {
  state, updateHeader, updateConfig, updateCp, setTps, setKktps, setStage, replaceSpine,
} from '../state.js';
import { toast } from '../api.js';
import { callAi } from '../aiApi.js';
import { assignTpCodes, assignKktpCodes, renameTpKode } from '../pipeline.js';
import { scheduleRecompute } from '../recompute.js';
import { badgeHtml, wireValidatorChips } from '../validate.js';
import { mountOneshotButton } from '../oneshot.js';

// ---- shared small helpers ---------------------------------------------------
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

const BLOOM_OPTIONS = [
  ['C1', 'C1 — Mengingat'], ['C2', 'C2 — Memahami'], ['C3', 'C3 — Menerapkan'],
  ['C4', 'C4 — Menganalisis'], ['C5', 'C5 — Mengevaluasi'], ['C6', 'C6 — Mencipta'],
];
const DUMMY_VERBS = ['menjelaskan', 'mengidentifikasi', 'menerapkan', 'membandingkan', 'menganalisis'];
const DUMMY_BLOOMS = ['C2', 'C1', 'C3', 'C2', 'C4'];
const METODE_OPTIONS = ['Deskripsi', 'Rubrik', 'Interval'];
const DUMMY_METODE_BY_BLOOM = { C1: 'Interval', C2: 'Deskripsi', C3: 'Rubrik', C4: 'Rubrik', C5: 'Deskripsi', C6: 'Rubrik' };

function dummyPerElemen(elemenList) {
  return elemenList.map((el) => Array.from({ length: 3 }, (_, i) => ({
    rumusan: `${DUMMY_VERBS[i % DUMMY_VERBS.length]} aspek terkait ${el.nama.toLowerCase()} (contoh — ganti dengan hasil AI sesungguhnya)`,
    bloom: DUMMY_BLOOMS[i % DUMMY_BLOOMS.length],
  })));
}
function dummyKktpItems(tpsList) {
  return tpsList.map((t) => {
    const metode = DUMMY_METODE_BY_BLOOM[t.bloom] || 'Deskripsi';
    return {
      metode,
      kriteria: metode === 'Interval'
        ? ''
        : `Peserta didik menunjukkan bukti konkret pencapaian "${t.rumusan.replace(/^Peserta didik dapat /i, '')}" (contoh — lengkapi kriteria sesungguhnya).`,
      instrumen: metode === 'Interval' ? 'Tes tertulis' : (metode === 'Rubrik' ? 'Rubrik penilaian produk/kinerja' : 'Lembar observasi/penilaian kualitatif'),
    };
  });
}

// ---- module state ------------------------------------------------------
let mapelList = null;
let mapelLoadState = 'idle'; // 'idle' | 'ok' | 'missing' | 'error'
let mapelRec = null;
let tps = [];
let kktps = [];
let mulokElemen = null; // editable working copy, mulok-without-cpFile only
let rootEl = null;

async function loadMapel() {
  if (mapelLoadState !== 'idle') return;
  try {
    const res = await fetch('data/mapel.json', { cache: 'no-store' });
    if (res.status === 404) { mapelLoadState = 'missing'; mapelList = []; return; }
    if (!res.ok) { mapelLoadState = 'error'; mapelList = []; return; }
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json && Array.isArray(json.mapel) ? json.mapel : null);
    if (!list) { mapelLoadState = 'error'; mapelList = []; return; }
    mapelList = list;
    mapelLoadState = 'ok';
  } catch (e) {
    mapelLoadState = 'error';
    mapelList = [];
  }
}
function pick(obj, keys, fallback) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return fallback;
}
function nameOf(rec) { return pick(rec, ['nama', 'mapel', 'name'], ''); }
function findMapelByName(name) {
  if (!name || mapelLoadState !== 'ok') return null;
  return mapelList.find((m) => nameOf(m) === name) || null;
}

const WEEKS_PER_YEAR = { 7: 36, 8: 36, 9: 32 };
function suggestJpPerMinggu(rec, kelas) {
  if (!rec || !rec.jpPerTahun || !kelas) return null;
  const total = rec.jpPerTahun[String(kelas)];
  const weeks = WEEKS_PER_YEAR[kelas];
  if (!total || !weeks) return null;
  const val = total / weeks;
  return Number.isFinite(val) ? Math.round(val * 100) / 100 : null;
}

async function loadNasionalCp(cpFile) {
  const res = await fetch('data/cp/' + cpFile, { cache: 'no-store' });
  if (!res.ok) throw new Error('Tidak bisa memuat data/cp/' + cpFile + ' (kode ' + res.status + ').');
  return res.json();
}

// =============================================================
// render()
// =============================================================
export async function render(container) {
  rootEl = container;
  await loadMapel();

  const h = state.spine.header;
  mapelRec = findMapelByName(h.mapel);
  const hasNationalFile = mapelRec && mapelRec.cpFile;

  if (hasNationalFile && !state.spine.cp.elemen.length) {
    try {
      const data = await loadNasionalCp(mapelRec.cpFile);
      updateCp({
        sumber: data.sumber || '',
        redaksi: data.redaksi || 'nasional',
        elemen: (data.elemen || []).map((e) => ({ nama: e.nama, teks: e.teks })),
      });
    } catch (e) {
      container.innerHTML = `<div class="placeholder card"><div class="big-icon">⚠️</div><h2>Gagal memuat CP</h2><p class="muted">${escapeHtml(e.message)}</p></div>`;
      return;
    }
  }

  tps = Array.isArray(state.spine.tps) ? state.spine.tps.map((t) => ({ ...t })) : [];
  kktps = Array.isArray(state.spine.kktps) ? state.spine.kktps.map((k) => ({ ...k })) : [];
  syncKktpsToTps();

  container.innerHTML = `
    <div class="stack-lg">
      <div class="split-pane">
        <div class="split-pane-left">
          <div class="card card-pad-lg">
            <div class="row-between">
              <h2>Data Perangkat</h2>
              ${badgeHtml(state.spine, 'header')}
            </div>
            <p class="muted small">Lengkapi identitas dasar. Semua bidang bisa diubah lagi nanti.</p>
            <div class="field" id="f-mapel"></div>
            <div class="field">
              <label>Kelas</label>
              <div class="choice-cards" id="kelas-cards">
                ${[7, 8, 9].map((k) => `
                  <label class="choice-card${h.kelas === k ? ' is-selected' : ''}" data-kelas="${k}">
                    <input type="radio" name="kelas" value="${k}" ${h.kelas === k ? 'checked' : ''}>
                    Kelas ${k}
                  </label>`).join('')}
              </div>
            </div>
            <div class="field">
              <label for="in-tahun">Tahun Ajaran</label>
              <input type="text" id="in-tahun" placeholder="2026/2027" value="${escapeHtml(h.tahunAjaran)}">
            </div>
            <div class="grid grid-2">
              <div class="field">
                <label for="in-jpminggu">JP / minggu</label>
                <input type="number" id="in-jpminggu" min="1" max="20" value="${state.spine.config.jpPerMinggu ?? ''}">
              </div>
              <div class="field">
                <label for="in-jppertemuan">JP / pertemuan</label>
                <input type="number" id="in-jppertemuan" min="1" max="10" value="${state.spine.config.jpPerPertemuan ?? ''}">
              </div>
            </div>
            <div class="field">
              <label for="in-menitperjp">Menit per JP</label>
              <input type="number" id="in-menitperjp" min="20" max="90" step="5" value="${state.spine.config.menitPerJp ?? 40}">
              <div class="field-hint">sesuai KOSP (umumnya 40 atau 45)</div>
            </div>
            <div class="field">
              <label for="in-totaljp">Total JP / Tahun</label>
              <input type="number" id="in-totaljp" min="1" max="400" value="${state.spine.config.totalJpTahun ?? ''}">
              <div class="field-hint">Terisi otomatis untuk mapel dengan alokasi resmi/baku — untuk Muatan Lokal tanpa data baku, isi sesuai KOSP. Dipakai ATP untuk menghitung JP per unit.</div>
            </div>
            <div class="field">
              <label for="in-guru">Guru</label>
              <input type="text" id="in-guru" value="${escapeHtml(h.guru)}" readonly>
            </div>
          </div>
        </div>
        <div class="split-pane-right">
          <details class="collapse-card" open>
            <summary><span>Capaian Pembelajaran (CP)</span></summary>
            <div class="collapse-body">
              <div class="row" id="cp-badge-host" style="margin-bottom:8px;"></div>
              <div id="cp-panel"></div>
            </div>
          </details>
        </div>
      </div>

      <div id="oneshot-host"></div>

      <details class="collapse-card" open>
        <summary><span>Tujuan Pembelajaran (TP) &amp; KKTP</span></summary>
        <div class="collapse-body">
          <div class="row" id="tp-badge-host" style="margin-bottom:8px;"></div>
          <p class="muted small">TP memecah tiap elemen CP menjadi kompetensi operasional &amp; terukur; setiap TP otomatis punya satu KKTP (klik baris "KKTP" untuk membuka/menyunting). Kode TP (D.&lt;kelas&gt;.&lt;no CP&gt;.&lt;no TP&gt;) bisa diubah — mengubahnya otomatis memperbarui KKTP, ATP, dan RPP yang merujuknya.</p>
          <div class="row" id="tp-actions">
            <button class="btn btn-primary btn-lg" id="btn-generate-tp">✨ Buatkan TP dengan AI</button>
            <button class="btn btn-outline" id="btn-dummy-tp">Isi Contoh (tanpa AI)</button>
          </div>
          <div id="tp-table-card" style="margin-top:var(--space-3);"></div>
        </div>
      </details>

      <div class="row-between">
        <span class="muted small" id="data-hint"></span>
        <button class="btn btn-primary btn-lg" id="btn-next">Simpan &amp; Lanjut →</button>
      </div>
    </div>
  `;

  const ctx = { selectedMapelRec: mapelRec };
  renderMapelField(container.querySelector('#f-mapel'), container, ctx);
  wireKelasCards(container, ctx);
  wireSimpleFields(container);

  renderCpPanel(container);
  renderTpTable(container);
  updateHint(container);

  container.querySelector('#btn-generate-tp').addEventListener('click', () => onGenerateTp(container, true));
  container.querySelector('#btn-dummy-tp').addEventListener('click', () => onGenerateTp(container, false));
  container.querySelector('#btn-next').addEventListener('click', () => onNext(container));

  // "⚡ Kerangka Instan (tanpa AI)" for every teacher, plus an owner-only
  // "✨ Generate Semuanya dengan AI" button alongside it (V2a #9, unchanged).
  mountOneshotButton(container.querySelector('#oneshot-host'));

  wireValidatorChips(container);
}

// ---- identity/config form (was stages/setup.js) ----------------------------
function renderMapelField(el, container, ctx) {
  const h = state.spine.header;
  if (mapelLoadState === 'ok' && mapelList.length) {
    el.innerHTML = `
      <label for="in-mapel">Mata Pelajaran</label>
      <select id="in-mapel">
        <option value="">— pilih mata pelajaran —</option>
        ${mapelList.map((m) => {
          const name = nameOf(m);
          const label = m.mulok ? (name + ' (Muatan Lokal)') : name;
          const sel = ctx.selectedMapelRec && ctx.selectedMapelRec.id === m.id ? 'selected' : '';
          return `<option value="${escapeHtml(m.id)}" ${sel}>${escapeHtml(label)}</option>`;
        }).join('')}
      </select>
      <div class="field-hint" id="mapel-hint"></div>
    `;
    updateMapelHint(container, ctx);
    el.querySelector('#in-mapel').addEventListener('change', (e) => {
      const rec = mapelList.find((m) => m.id === e.target.value) || null;
      ctx.selectedMapelRec = rec;
      mapelRec = rec;
      updateHeader({ mapel: rec ? nameOf(rec) : '' });
      applyMapelDefaults(container, ctx);
      updateMapelHint(container, ctx);
      // Mapel changed -> CP source changes entirely; reload the CP panel
      // (loses any unsaved mulok draft, matching the old cp.js behavior).
      renderCpPanel(container);
    });
  } else {
    el.innerHTML = `
      <label for="in-mapel">Mata Pelajaran</label>
      <input type="text" id="in-mapel" placeholder="Ketik nama mata pelajaran" value="${escapeHtml(h.mapel)}">
      <div class="field-hint">Daftar mata pelajaran belum tersedia — isi manual dulu, termasuk JP di bawah.</div>
    `;
    el.querySelector('#in-mapel').addEventListener('input', (e) => updateHeader({ mapel: e.target.value }));
  }
}
function updateMapelHint(container, ctx) {
  const hint = container.querySelector('#mapel-hint');
  if (!hint) return;
  const rec = ctx.selectedMapelRec;
  hint.textContent = rec && rec.mulok && !rec.jpPerTahun
    ? 'Muatan Lokal tanpa data JP baku — isi JP/minggu, JP/pertemuan, dan Total JP/Tahun secara manual (rujuk KOSP).'
    : '';
}
function applyMapelDefaults(container, ctx) {
  const rec = ctx.selectedMapelRec;
  const kelas = state.spine.header.kelas;
  if (!rec || !rec.jpPerTahun || !kelas) return;
  const total = rec.jpPerTahun[String(kelas)];
  if (total == null) return;
  updateConfig({ totalJpTahun: total });
  const totalInput = container.querySelector('#in-totaljp');
  if (totalInput) totalInput.value = total;
  const perMinggu = suggestJpPerMinggu(rec, kelas);
  if (perMinggu != null) {
    container.querySelector('#in-jpminggu').value = perMinggu;
    updateConfig({ jpPerMinggu: perMinggu });
  }
  scheduleRecompute();
}
function wireKelasCards(container, ctx) {
  const cards = Array.from(container.querySelectorAll('#kelas-cards .choice-card'));
  cards.forEach((card) => {
    card.addEventListener('click', () => {
      const kelas = Number(card.dataset.kelas);
      cards.forEach((c) => c.classList.remove('is-selected'));
      card.classList.add('is-selected');
      card.querySelector('input').checked = true;
      updateHeader({ kelas });
      applyMapelDefaults(container, ctx);
    });
  });
}
function wireSimpleFields(container) {
  container.querySelector('#in-tahun').addEventListener('input', (e) => updateHeader({ tahunAjaran: e.target.value }));
  container.querySelector('#in-jpminggu').addEventListener('input', (e) => {
    updateConfig({ jpPerMinggu: e.target.value ? Number(e.target.value) : null });
    scheduleRecompute();
  });
  container.querySelector('#in-jppertemuan').addEventListener('input', (e) => {
    updateConfig({ jpPerPertemuan: e.target.value ? Number(e.target.value) : null });
    scheduleRecompute();
  });
  container.querySelector('#in-menitperjp').addEventListener('input', (e) => {
    updateConfig({ menitPerJp: e.target.value ? Number(e.target.value) : 40 });
    scheduleRecompute();
  });
  container.querySelector('#in-totaljp').addEventListener('input', (e) => {
    updateConfig({ totalJpTahun: e.target.value ? Number(e.target.value) : null });
    scheduleRecompute();
  });
}

// ---- CP panel (right pane) — was stages/cp.js ------------------------------
function renderCpPanel(container) {
  const badgeHost = container.querySelector('#cp-badge-host');
  if (badgeHost) badgeHost.innerHTML = badgeHtml(state.spine, 'cp');

  const panel = container.querySelector('#cp-panel');
  const hasNationalFile = mapelRec && mapelRec.cpFile;
  if (hasNationalFile) renderCpReadOnly(panel);
  else renderCpMulokEditable(panel, container);
}

function renderCpReadOnly(panel) {
  const cp = state.spine.cp;
  const badge = cp.redaksi === 'kontekstual'
    ? '<span class="chip chip-accent">Kontekstual — disahkan KOSP</span>'
    : '<span class="chip chip-accent">Nasional — verbatim</span>';
  panel.innerHTML = `
    <div class="row" style="gap:6px; margin-bottom:8px;">${badge}</div>
    <p class="muted small">Teks CP dikutip verbatim (tidak dapat diedit di sini) — SOP mewajibkan CP tidak diparafrasakan ulang antar dokumen.</p>
    <p class="field-hint">Sumber: ${escapeHtml(cp.sumber || '(tidak dicantumkan)')}</p>
    <div class="stack" id="cp-elemen-list"></div>
  `;
  const list = panel.querySelector('#cp-elemen-list');
  if (!cp.elemen.length) {
    list.innerHTML = '<p class="muted">Belum ada elemen CP.</p>';
  } else {
    list.innerHTML = cp.elemen.map((e) => `
      <div class="card" style="background:var(--bg-soft);">
        <h3>${escapeHtml(e.nama)}</h3>
        <p>${escapeHtml(e.teks)}</p>
      </div>
    `).join('');
  }
}

function renderCpMulokEditable(panel, container) {
  const cp = state.spine.cp;
  if (!mulokElemen) mulokElemen = cp.elemen.length ? cp.elemen.map((e) => ({ ...e })) : [{ nama: '', teks: '' }];

  panel.innerHTML = `
    <span class="chip">Draf — sahkan via KOSP</span>
    <p class="muted small" style="margin-top:8px;">Mata pelajaran ini belum punya CP nasional/kontekstual tersimpan. Tempel teks CP yang sudah disahkan KOSP di bawah, atau minta AI membuat draf awal untuk dilengkapi tim kurikulum.</p>
    <div class="field">
      <label for="in-outline">Garis besar topik/tujuan (untuk draf AI)</label>
      <textarea id="in-outline" rows="3" placeholder="mis. Tahfidz Juz 30, kaidah tajwid dasar, adab membaca Al-Qur'an..."></textarea>
    </div>
    <div class="row">
      <button class="btn btn-outline" id="btn-draft-ai">✨ Draf dengan AI</button>
      <button class="btn btn-outline" id="btn-draft-dummy">Isi Contoh (tanpa AI)</button>
    </div>
    <div class="stack" id="cp-elemen-editor" style="margin-top:var(--space-3);"></div>
    <button class="btn btn-ghost" id="btn-add-elemen" type="button">+ Tambah elemen</button>
  `;

  function renderEditor() {
    const wrap = panel.querySelector('#cp-elemen-editor');
    wrap.innerHTML = mulokElemen.map((e, i) => `
      <div class="card" style="background:var(--bg-soft);">
        <div class="field">
          <label>Nama Elemen</label>
          <input type="text" data-i="${i}" class="in-elemen-nama" value="${escapeHtml(e.nama)}" placeholder="mis. Tahfidz">
        </div>
        <div class="field">
          <label>Teks Capaian</label>
          <textarea data-i="${i}" class="in-elemen-teks" rows="3" placeholder="Pada akhir Fase D, peserta didik ...">${escapeHtml(e.teks)}</textarea>
        </div>
        <button type="button" class="btn btn-ghost" data-remove="${i}">Hapus elemen</button>
      </div>
    `).join('');
    wrap.querySelectorAll('.in-elemen-nama').forEach((el) => el.addEventListener('input', (ev) => {
      mulokElemen[Number(ev.target.dataset.i)].nama = ev.target.value;
      persistMulok();
    }));
    wrap.querySelectorAll('.in-elemen-teks').forEach((el) => el.addEventListener('input', (ev) => {
      mulokElemen[Number(ev.target.dataset.i)].teks = ev.target.value;
      persistMulok();
    }));
    wrap.querySelectorAll('[data-remove]').forEach((el) => el.addEventListener('click', () => {
      mulokElemen.splice(Number(el.dataset.remove), 1);
      if (!mulokElemen.length) mulokElemen = [{ nama: '', teks: '' }];
      renderEditor();
      persistMulok();
    }));
  }

  function persistMulok() {
    updateCp({ redaksi: 'kontekstual', sumber: state.spine.cp.sumber || 'Draf mulok — belum disahkan KOSP', elemen: mulokElemen.map((e) => ({ ...e })) });
  }

  renderEditor();

  panel.querySelector('#btn-add-elemen').addEventListener('click', () => {
    mulokElemen.push({ nama: '', teks: '' });
    renderEditor();
    persistMulok();
  });
  panel.querySelector('#btn-draft-ai').addEventListener('click', async () => {
    const topikOutline = panel.querySelector('#in-outline').value.trim();
    if (!topikOutline) return toast('Isi garis besar topik dulu untuk membuat draf AI.', { error: true });
    const btn = panel.querySelector('#btn-draft-ai');
    btn.disabled = true; btn.textContent = 'Membuat draf…';
    try {
      const r = await callAi('draft_capaian_mulok', { planId: state.planId, topikOutline, mapel: state.spine.header.mapel });
      mulokElemen = r.elemen.map((e) => ({ nama: e.nama, teks: e.teks }));
      renderEditor();
      persistMulok();
      toast('Draf CP berhasil dibuat — tinjau dan lengkapi sebelum disahkan KOSP.');
    } catch (e) {
      // already toasted
    } finally {
      btn.disabled = false; btn.textContent = '✨ Draf dengan AI';
    }
  });
  panel.querySelector('#btn-draft-dummy').addEventListener('click', () => {
    mulokElemen = [
      { nama: 'Elemen Contoh 1', teks: 'Pada akhir Fase D, peserta didik mampu memahami dan menerapkan konsep dasar mata pelajaran ini dalam konteks kehidupan sehari-hari (contoh — lengkapi dengan teks CP yang disahkan KOSP).' },
      { nama: 'Elemen Contoh 2', teks: 'Pada akhir Fase D, peserta didik mampu mengomunikasikan pemahamannya secara lisan maupun tertulis dengan runtut (contoh — lengkapi dengan teks CP yang disahkan KOSP).' },
    ];
    renderEditor();
    persistMulok();
    toast('Contoh CP diisi (offline, tanpa AI) — ganti dengan teks CP yang sesungguhnya.');
  });
}

// ---- TP + KKTP table (was stages/tp.js + stages/kktp.js) -------------------
function syncKktpsToTps() {
  const tpKodes = new Set(tps.map((t) => t.kode));
  kktps = kktps.filter((k) => tpKodes.has(k.tpKode));
  for (const t of tps) {
    if (!kktps.some((k) => k.tpKode === t.kode)) {
      kktps.push({ kode: 'KKTP-' + t.kode, tpKode: t.kode, metode: 'Deskripsi', kriteria: '', instrumen: '' });
    }
  }
}
function persistTps() { setTps(tps); }
function persistKktps() { setKktps(kktps); }

async function onGenerateTp(container, useAi) {
  const cp = state.spine.cp;
  if (!cp.elemen.length) return toast('CP belum diisi — lengkapi panel CP dulu.', { error: true });
  const kelas = state.spine.header.kelas;
  const btns = container.querySelectorAll('#tp-actions button');
  btns.forEach((b) => { b.disabled = true; });
  try {
    let perElemenTps;
    if (useAi) {
      const r = await callAi('generate_tp', { planId: state.planId, cp: { elemen: cp.elemen }, kelas, mapel: state.spine.header.mapel });
      perElemenTps = r.perElemen.map((e) => e.tps);
    } else {
      perElemenTps = dummyPerElemen(cp.elemen);
    }
    const { tps: built, warnings } = assignTpCodes(cp.elemen, perElemenTps, kelas);
    tps = built;
    syncKktpsToTps();
    persistTps(); persistKktps();
    renderTpTable(container);
    updateHint(container);
    toast(useAi ? 'TP berhasil dibuat oleh AI.' : 'TP contoh berhasil diisi (offline, tanpa AI).');
    if (warnings.length) toast(warnings[0], { error: true });
  } catch (e) {
    // already toasted
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

async function onGenerateKktpAll(container, useAi) {
  if (!tps.length) return toast('Buat TP dulu.', { error: true });
  try {
    let items;
    if (useAi) {
      toast('Membuat KKTP untuk semua TP dengan AI…');
      const r = await callAi('generate_kktp', { planId: state.planId, tps });
      items = r.items;
    } else {
      items = dummyKktpItems(tps);
    }
    const { kktps: built, warnings } = assignKktpCodes(tps, items, undefined, state.spine.config.kktpThreshold);
    kktps = built;
    persistKktps();
    renderTpTable(container);
    toast(useAi ? 'KKTP berhasil dibuat oleh AI.' : 'KKTP contoh berhasil diisi (offline, tanpa AI).');
    if (warnings.length) toast(warnings[0], { error: true });
  } catch (e) {
    // already toasted
  }
}

function renderTpTable(container) {
  const card = container.querySelector('#tp-table-card');
  const badgeHost = container.querySelector('#tp-badge-host');
  if (badgeHost) badgeHost.innerHTML = badgeHtml(state.spine, 'tp') + badgeHtml(state.spine, 'kktp');

  if (!tps.length) {
    card.innerHTML = '<p class="muted">Belum ada TP. Klik "Buatkan TP dengan AI" atau "Isi Contoh" di atas, atau pakai "⚡ Kerangka Instan" untuk menyusun semuanya sekaligus.</p>';
    return;
  }

  card.innerHTML = `
    <div class="row" style="margin-bottom:var(--space-2);">
      <button class="btn btn-outline btn-sm" id="btn-generate-kktp-all">✨ Buatkan semua KKTP dengan AI</button>
      <button class="btn btn-ghost btn-sm" id="btn-dummy-kktp-all">Isi Contoh KKTP (tanpa AI)</button>
    </div>
    <div class="table-scroll">
      <table style="width:100%; border-collapse:collapse;">
        <thead>
          <tr style="text-align:left; border-bottom:2px solid var(--line-strong);">
            <th style="padding:8px 6px; width:120px;">Kode</th>
            <th style="padding:8px 6px; width:140px;">Elemen</th>
            <th style="padding:8px 6px;">Rumusan TP</th>
            <th style="padding:8px 6px; width:170px;">Bloom</th>
            <th style="padding:8px 6px; width:70px;"></th>
          </tr>
        </thead>
        <tbody id="tp-tbody"></tbody>
      </table>
    </div>
    <button class="btn btn-ghost" id="btn-add-tp" type="button">+ Tambah TP manual</button>
  `;

  const tbody = card.querySelector('#tp-tbody');
  tbody.innerHTML = tps.map((t, i) => {
    const k = kktps.find((x) => x.tpKode === t.kode) || {};
    const kIdx = kktps.indexOf(k);
    return `
    <tr data-i="${i}" style="border-bottom:1px solid var(--line);">
      <td style="padding:6px; vertical-align:top;"><input type="text" class="in-tp-kode" data-i="${i}" value="${escapeHtml(t.kode)}" style="font-weight:700; width:100%;"></td>
      <td style="padding:6px; vertical-align:top;">${escapeHtml(t.elemen)}</td>
      <td style="padding:6px;"><textarea class="in-rumusan" data-i="${i}" rows="2" style="min-height:auto;">${escapeHtml(t.rumusan)}</textarea></td>
      <td style="padding:6px; vertical-align:top;">
        <select class="in-bloom" data-i="${i}">
          <option value="">—</option>
          ${BLOOM_OPTIONS.map(([v, label]) => `<option value="${v}" ${t.bloom === v ? 'selected' : ''}>${label}</option>`).join('')}
        </select>
      </td>
      <td style="padding:6px; vertical-align:top; white-space:nowrap;">
        <button type="button" class="btn-ghost" data-regen-tp="${i}" title="Regenerasi TP dengan AI" style="border:none;background:none;cursor:pointer;font-size:1.1rem;">🔄</button>
        <button type="button" class="btn-ghost" data-remove-tp="${i}" title="Hapus" style="border:none;background:none;cursor:pointer;font-size:1.1rem;">🗑</button>
      </td>
    </tr>
    <tr class="kktp-row" style="border-bottom:1px solid var(--line); background:var(--bg-soft);">
      <td colspan="5" style="padding:0;">
        <details class="collapse-card" style="border:none; box-shadow:none; margin:0;">
          <summary style="padding:6px 10px;">KKTP — ${escapeHtml(k.metode || 'Deskripsi')}${k.kriteria ? ': ' + escapeHtml(k.kriteria.slice(0, 70)) + (k.kriteria.length > 70 ? '…' : '') : ' (belum diisi)'}</summary>
          <div class="collapse-body" style="padding:8px 10px 12px;">
            <div class="grid grid-2">
              <div class="field" style="margin-bottom:8px;">
                <label>Metode</label>
                <select class="in-metode" data-kidx="${kIdx}">
                  ${METODE_OPTIONS.map((m) => `<option value="${m}" ${k.metode === m ? 'selected' : ''}>${m}</option>`).join('')}
                </select>
              </div>
              <div class="field" style="margin-bottom:8px;">
                <label>Instrumen</label>
                <input type="text" class="in-instrumen" data-kidx="${kIdx}" value="${escapeHtml(k.instrumen || '')}">
              </div>
            </div>
            <div class="field" style="margin-bottom:6px;">
              <label>Kriteria</label>
              <textarea class="in-kriteria" data-kidx="${kIdx}" rows="2" style="min-height:auto;">${escapeHtml(k.kriteria || '')}</textarea>
            </div>
            <button type="button" class="btn-ghost" data-regen-kktp="${kIdx}" style="border:none;background:none;cursor:pointer;">🔄 Regenerasi KKTP dengan AI</button>
          </div>
        </details>
      </td>
    </tr>
    `;
  }).join('');

  wireTpRows(container, tbody);
  card.querySelector('#btn-generate-kktp-all').addEventListener('click', () => onGenerateKktpAll(container, true));
  card.querySelector('#btn-dummy-kktp-all').addEventListener('click', () => onGenerateKktpAll(container, false));
  card.querySelector('#btn-add-tp').addEventListener('click', () => onAddTp(container));
}

function wireTpRows(container, tbody) {
  tbody.querySelectorAll('.in-rumusan').forEach((el) => el.addEventListener('input', (ev) => {
    tps[Number(ev.target.dataset.i)].rumusan = ev.target.value;
    persistTps();
  }));
  tbody.querySelectorAll('.in-bloom').forEach((el) => el.addEventListener('change', (ev) => {
    tps[Number(ev.target.dataset.i)].bloom = ev.target.value || null;
    persistTps();
  }));
  tbody.querySelectorAll('.in-tp-kode').forEach((el) => el.addEventListener('blur', (ev) => onTpKodeBlur(container, ev)));
  tbody.querySelectorAll('[data-remove-tp]').forEach((el) => el.addEventListener('click', (ev) => {
    const i = Number(ev.currentTarget.dataset.removeTp);
    tps.splice(i, 1);
    syncKktpsToTps();
    persistTps(); persistKktps();
    renderTpTable(container);
    updateHint(container);
  }));
  tbody.querySelectorAll('[data-regen-tp]').forEach((el) => el.addEventListener('click', (ev) => onRegenTp(container, Number(ev.currentTarget.dataset.regenTp))));

  tbody.querySelectorAll('.in-metode').forEach((el) => el.addEventListener('change', (ev) => {
    kktps[Number(ev.target.dataset.kidx)].metode = ev.target.value;
    persistKktps();
  }));
  tbody.querySelectorAll('.in-kriteria').forEach((el) => el.addEventListener('input', (ev) => {
    kktps[Number(ev.target.dataset.kidx)].kriteria = ev.target.value;
    persistKktps();
  }));
  tbody.querySelectorAll('.in-instrumen').forEach((el) => el.addEventListener('input', (ev) => {
    kktps[Number(ev.target.dataset.kidx)].instrumen = ev.target.value;
    persistKktps();
  }));
  tbody.querySelectorAll('[data-regen-kktp]').forEach((el) => el.addEventListener('click', (ev) => onRegenKktp(container, Number(ev.currentTarget.dataset.regenKktp))));
}

/** V2b #7 — TP kode is now editable; a real change cascades everywhere the
 *  old code was referenced via pipeline.renameTpKode(). */
function onTpKodeBlur(container, ev) {
  const i = Number(ev.target.dataset.i);
  const oldKode = tps[i].kode;
  const newKode = ev.target.value.trim();
  if (!newKode || newKode === oldKode) { ev.target.value = oldKode; return; }
  if (tps.some((t, idx) => idx !== i && t.kode === newKode)) {
    toast('Kode "' + newKode + '" sudah dipakai TP lain.', { error: true });
    ev.target.value = oldKode;
    return;
  }
  const mutated = renameTpKode(state.spine, oldKode, newKode);
  replaceSpine(mutated);
  tps = state.spine.tps.map((t) => ({ ...t }));
  kktps = state.spine.kktps.map((k) => ({ ...k }));
  renderTpTable(container);
  toast(`Kode TP diganti "${oldKode}" → "${newKode}" — KKTP, ATP, dan RPP terkait ikut diperbarui.`);
}

async function onRegenTp(container, i) {
  const tp = tps[i];
  if (!tp) return;
  const elemenObj = state.spine.cp.elemen.find((e) => e.nama === tp.elemen) || {};
  const tpLainnya = tps.filter((t, j) => j !== i && t.elemen === tp.elemen).map((t) => t.rumusan);
  toast('Meregenerasi TP ' + tp.kode + '…');
  try {
    const r = await callAi('regenerate_item', {
      planId: state.planId,
      target: 'tp',
      context: { elemenNama: tp.elemen, elemenTeks: elemenObj.teks || '', tpLainnya },
      current: { rumusan: tp.rumusan, bloom: tp.bloom },
    });
    tps[i] = { ...tp, rumusan: r.value.rumusan, bloom: r.value.bloom };
    persistTps();
    renderTpTable(container);
    toast('TP ' + tp.kode + ' berhasil diregenerasi.');
  } catch (e) {
    // already toasted
  }
}

async function onRegenKktp(container, kIdx) {
  const k = kktps[kIdx];
  if (!k) return;
  const tp = tps.find((t) => t.kode === k.tpKode) || {};
  toast('Meregenerasi ' + k.kode + '…');
  try {
    const r = await callAi('regenerate_item', {
      planId: state.planId,
      target: 'kktp',
      context: { tpKode: k.tpKode, tpRumusan: tp.rumusan || '' },
      current: { metode: k.metode, kriteria: k.kriteria },
    });
    kktps[kIdx] = { ...k, metode: r.value.metode, kriteria: r.value.kriteria, instrumen: r.value.instrumen };
    persistKktps();
    renderTpTable(container);
    toast(k.kode + ' berhasil diregenerasi.');
  } catch (e) {
    // already toasted
  }
}

function onAddTp(container) {
  const lastElemen = tps.length ? tps[tps.length - 1].elemen : (state.spine.cp.elemen[0] || {}).nama;
  const noCP = state.spine.cp.elemen.findIndex((e) => e.nama === lastElemen) + 1 || 1;
  const noTP = tps.filter((t) => t.elemen === lastElemen).length + 1;
  const kode = `D.${state.spine.header.kelas}.${noCP}.${noTP}`;
  tps.push({ kode, elemen: lastElemen || '', rumusan: 'Peserta didik dapat …', bloom: null });
  syncKktpsToTps();
  persistTps(); persistKktps();
  renderTpTable(container);
  updateHint(container);
}

function updateHint(container) {
  const el = container.querySelector('#data-hint');
  if (el) el.textContent = tps.length ? `${tps.length} TP di ${new Set(tps.map((t) => t.elemen)).size} elemen, ${kktps.length} KKTP.` : '';
}

// ---- forward nav ------------------------------------------------------------
async function onNext(container) {
  const h = state.spine.header;
  if (!h.mapel) return toast('Isi mata pelajaran dulu.', { error: true });
  if (!h.kelas) return toast('Pilih kelas dulu.', { error: true });
  if (!h.tahunAjaran) return toast('Isi tahun ajaran dulu.', { error: true });
  if (!state.spine.cp.elemen.length) return toast('CP belum tersedia/terisi.', { error: true });
  if (!tps.length) return toast('Buat TP dulu sebelum lanjut.', { error: true });
  if (tps.some((t) => !t.rumusan || !t.rumusan.trim())) return toast('Ada TP dengan rumusan kosong.', { error: true });

  const btn = container.querySelector('#btn-next');
  btn.disabled = true;
  btn.textContent = 'Menyimpan…';
  const ok = await setStage('atp');
  btn.disabled = false;
  btn.textContent = 'Simpan & Lanjut →';
  if (ok) {
    location.hash = '#/atp';
  } else if (state.saveStatus !== 'error') {
    toast('Tidak bisa menyimpan — sesi guru tidak ditemukan. Kembali ke Beranda dan pilih nama Anda lagi.', { error: true });
  }
}
