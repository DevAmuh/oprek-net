// =============================================================
// Pemeran — Stage: CP (Capaian Pembelajaran)
// -------------------------------------------------------------
// National mapel (cpFile set in data/mapel.json): verbatim, read-only,
// with sumber cited (SOP §3.3 "CP tidak boleh diubah redaksinya").
// Mulok without a cpFile (e.g. "Muatan Lokal lainnya"): teacher pastes
// elemen manually, or drafts with AI — clearly badged as a KOSP draft,
// never presented as an official national CP.
// =============================================================

import { state, updateCp, setStage } from '../state.js';
import { toast } from '../api.js';
import { callAi } from '../aiApi.js';
import { badgeHtml } from '../validate.js';

let mapelRec = null; // the matched data/mapel.json record, or null
let loadState = 'idle'; // 'idle' | 'ok' | 'notfound' | 'error'

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

async function findMapelRecord() {
  const name = state.spine.header.mapel;
  if (!name) return null;
  try {
    const res = await fetch('data/mapel.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const json = await res.json();
    const list = Array.isArray(json) ? json : (json.mapel || []);
    return list.find((m) => (m.nama || m.mapel) === name) || null;
  } catch (e) {
    return null;
  }
}

async function loadNasionalCp(cpFile) {
  const res = await fetch('data/cp/' + cpFile, { cache: 'no-store' });
  if (!res.ok) throw new Error('Tidak bisa memuat data/cp/' + cpFile + ' (kode ' + res.status + ').');
  return res.json();
}

export async function render(container) {
  mapelRec = await findMapelRecord();
  const cp = state.spine.cp;
  const hasNationalFile = mapelRec && mapelRec.cpFile;

  if (hasNationalFile && !cp.elemen.length) {
    try {
      const data = await loadNasionalCp(mapelRec.cpFile);
      updateCp({
        sumber: data.sumber || '',
        redaksi: data.redaksi || 'nasional',
        elemen: (data.elemen || []).map((e) => ({ nama: e.nama, teks: e.teks })),
      });
    } catch (e) {
      loadState = 'error';
      container.innerHTML = `<div class="placeholder card"><div class="big-icon">⚠️</div><h2>Gagal memuat CP</h2><p class="muted">${escapeHtml(e.message)}</p></div>`;
      return;
    }
  }

  if (hasNationalFile) {
    // Either a national BSKAP CP or a pre-transcribed kontekstual file (ESP) —
    // both are verbatim/read-only, just badged differently by cp.redaksi.
    renderReadOnly(container);
  } else {
    // No transcribed CP available at all: genuine mulok without a KOSP file
    // yet, OR a national mapel M0 deferred to M5 (data/NEEDS_SOURCE.md) —
    // either way, the teacher pastes/drafts it manually for now.
    renderMulokEditable(container);
  }
}

function renderReadOnly(container) {
  const cp = state.spine.cp;
  const badge = cp.redaksi === 'kontekstual'
    ? '<span class="chip chip-accent">Kontekstual — disahkan KOSP</span>'
    : '<span class="chip chip-accent">Nasional — verbatim</span>';

  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg">
        <div class="row-between">
          <h2>Capaian Pembelajaran</h2>
          <div class="row" style="gap:6px;">${badge}${badgeHtml(state.spine, 'cp')}</div>
        </div>
        <p class="muted small">Teks CP dikutip verbatim (tidak dapat diedit di sini) — SOP mewajibkan CP tidak diparafrasakan ulang antar dokumen.</p>
        <p class="field-hint">Sumber: ${escapeHtml(cp.sumber || '(tidak dicantumkan)')}</p>
        <div class="stack" id="cp-elemen-list"></div>
      </div>
      <div class="row-between">
        <span></span>
        <button class="btn btn-primary btn-lg" id="btn-next">Simpan &amp; Lanjut →</button>
      </div>
    </div>
  `;

  const list = container.querySelector('#cp-elemen-list');
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

  container.querySelector('#btn-next').addEventListener('click', async () => {
    if (!cp.elemen.length) return toast('CP belum tersedia untuk mata pelajaran ini.', { error: true });
    const ok = await setStage('tp');
    if (ok) location.hash = '#/tp';
  });
}

function renderMulokEditable(container) {
  const cp = state.spine.cp;
  container.innerHTML = `
    <div class="stack-lg">
      <div class="card card-pad-lg">
        <div class="row-between">
          <h2>Capaian Pembelajaran (Muatan Lokal)</h2>
          <div class="row" style="gap:6px;"><span class="chip">Draf — sahkan via KOSP</span>${badgeHtml(state.spine, 'cp')}</div>
        </div>
        <p class="muted small">Mata pelajaran ini belum punya CP nasional/kontekstual tersimpan. Tempel teks CP yang sudah disahkan KOSP di bawah, atau minta AI membuat draf awal untuk dilengkapi tim kurikulum.</p>

        <div class="field">
          <label for="in-outline">Garis besar topik/tujuan (untuk draf AI — opsional jika Anda menempel CP sendiri di bawah)</label>
          <textarea id="in-outline" rows="3" placeholder="mis. Tahfidz Juz 30, kaidah tajwid dasar, adab membaca Al-Qur'an..."></textarea>
        </div>
        <div class="row">
          <button class="btn btn-outline" id="btn-draft-ai">✨ Draf dengan AI</button>
          <button class="btn btn-outline" id="btn-draft-dummy">Isi Contoh (tanpa AI)</button>
        </div>

        <div class="stack" id="cp-elemen-editor" style="margin-top:var(--space-4);"></div>
        <button class="btn btn-ghost" id="btn-add-elemen" type="button">+ Tambah elemen</button>
      </div>
      <div class="row-between">
        <span></span>
        <button class="btn btn-primary btn-lg" id="btn-next">Simpan &amp; Lanjut →</button>
      </div>
    </div>
  `;

  let elemen = cp.elemen.length ? cp.elemen.map((e) => ({ ...e })) : [{ nama: '', teks: '' }];

  function renderEditor() {
    const wrap = container.querySelector('#cp-elemen-editor');
    wrap.innerHTML = elemen.map((e, i) => `
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
      elemen[Number(ev.target.dataset.i)].nama = ev.target.value;
      persist();
    }));
    wrap.querySelectorAll('.in-elemen-teks').forEach((el) => el.addEventListener('input', (ev) => {
      elemen[Number(ev.target.dataset.i)].teks = ev.target.value;
      persist();
    }));
    wrap.querySelectorAll('[data-remove]').forEach((el) => el.addEventListener('click', () => {
      elemen.splice(Number(el.dataset.remove), 1);
      if (!elemen.length) elemen = [{ nama: '', teks: '' }];
      renderEditor();
      persist();
    }));
  }

  function persist() {
    updateCp({ redaksi: 'kontekstual', sumber: cp.sumber || 'Draf mulok — belum disahkan KOSP', elemen: elemen.map((e) => ({ ...e })) });
  }

  renderEditor();

  container.querySelector('#btn-add-elemen').addEventListener('click', () => {
    elemen.push({ nama: '', teks: '' });
    renderEditor();
    persist();
  });

  container.querySelector('#btn-draft-ai').addEventListener('click', async () => {
    const topikOutline = container.querySelector('#in-outline').value.trim();
    if (!topikOutline) return toast('Isi garis besar topik dulu untuk membuat draf AI.', { error: true });
    const btn = container.querySelector('#btn-draft-ai');
    btn.disabled = true; btn.textContent = 'Membuat draf…';
    try {
      const r = await callAi('draft_capaian_mulok', { planId: state.planId, topikOutline, mapel: state.spine.header.mapel });
      elemen = r.elemen.map((e) => ({ nama: e.nama, teks: e.teks }));
      renderEditor();
      persist();
      toast('Draf CP berhasil dibuat — tinjau dan lengkapi sebelum disahkan KOSP.');
    } catch (e) {
      // already toasted
    } finally {
      btn.disabled = false; btn.textContent = '✨ Draf dengan AI';
    }
  });

  container.querySelector('#btn-draft-dummy').addEventListener('click', () => {
    elemen = [
      { nama: 'Elemen Contoh 1', teks: 'Pada akhir Fase D, peserta didik mampu memahami dan menerapkan konsep dasar mata pelajaran ini dalam konteks kehidupan sehari-hari (contoh — lengkapi dengan teks CP yang disahkan KOSP).' },
      { nama: 'Elemen Contoh 2', teks: 'Pada akhir Fase D, peserta didik mampu mengomunikasikan pemahamannya secara lisan maupun tertulis dengan runtut (contoh — lengkapi dengan teks CP yang disahkan KOSP).' },
    ];
    renderEditor();
    persist();
    toast('Contoh CP diisi (offline, tanpa AI) — ganti dengan teks CP yang sesungguhnya.');
  });

  container.querySelector('#btn-next').addEventListener('click', async () => {
    if (!elemen.length || elemen.every((e) => !e.nama && !e.teks)) {
      return toast('Isi minimal satu elemen CP dulu.', { error: true });
    }
    persist();
    const ok = await setStage('tp');
    if (ok) location.hash = '#/tp';
  });
}
