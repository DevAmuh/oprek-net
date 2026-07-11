// =============================================================
//  Pemeran — generation endpoint  ->  /api/pemeran-ai
// -------------------------------------------------------------
//  Zero-dependency Vercel Node function. Same passcode gate as
//  api/pemeran.js (shared school passcode, verified against
//  Supabase), then dispatches to Haiku (claude-haiku-4-5 ONLY,
//  server-side key) for RPP content generation. Writes a
//  pemeran_gen_log row per call for cost tracking.
//
//  Required Vercel Environment Variables:
//    ANTHROPIC_API_KEY          - Claude API key (console.anthropic.com)
//    SUPABASE_SERVICE_ROLE_KEY  - service role key for project
//                                 "Sandbox" (fvrwxuwkwwrajuausuaj)
// =============================================================

const crypto = require('crypto');

const SUPA_URL = 'https://fvrwxuwkwwrajuausuaj.supabase.co';
const MODEL = 'claude-haiku-4-5';
const MAX_BODY_BYTES = 300000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v) { return typeof v === 'string' && UUID_RE.test(v); }

// ---- PostgREST helper (duplicated from api/pemeran.js — each api/*.js file
// in this repo is deliberately self-contained; zero shared modules) ---------
async function supa(path, opts) {
  opts = opts || {};
  // .trim() guards a trailing newline/space on the env var — a common paste error.
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  // Only legacy JWT keys (eyJ...) carry a role claim in the Bearer slot. The new
  // sb_secret_ keys aren't JWTs — sent as Bearer, PostgREST falls back to anon
  // (403). apikey alone maps sb_secret_ to service_role. So Bearer only for JWTs.
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  Object.assign(headers, opts.headers || {});
  const r = await fetch(SUPA_URL + path, { method: opts.method || 'GET', headers, body: opts.body });
  const text = await r.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch (e) { json = text; } }
  return { ok: r.ok, status: r.status, json };
}

// ---- passcode check (hash cached across warm invocations) -----------------
let cachedHash = null;
let lastConfigError = null; // captures WHY the settings read failed, for diagnosis

async function getPasscodeHash() {
  if (cachedHash) return cachedHash;
  const r = await supa('/rest/v1/pemeran_settings?select=value&key=eq.passcode');
  const row = r.ok && Array.isArray(r.json) && r.json[0];
  const hash = row && row.value && row.value.hash;
  if (typeof hash === 'string' && hash.length === 64) { cachedHash = hash; lastConfigError = null; }
  else {
    const msg = r.json && (r.json.message || r.json.error || r.json.msg);
    lastConfigError = 'Supabase HTTP ' + r.status + (msg ? ' — ' + msg : '');
  }
  return cachedHash;
}

// Returns 'ok' | 'bad' | 'config'. 'config' means the passcode row could not be
// read at all (wrong/missing service-role key, unreachable DB); reporting that
// as a wrong passcode sends the operator hunting for the wrong bug.
async function verifyPass(pass) {
  if (typeof pass !== 'string' || pass.length < 4 || pass.length > 200) return 'bad';
  const hash = await getPasscodeHash();
  if (!hash) return 'config';
  const digest = crypto.createHash('sha256').update(pass, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(hash, 'hex')) ? 'ok' : 'bad';
  } catch (e) {
    return 'bad'; // length mismatch etc. — treat as no match
  }
}

const CONFIG_ERROR = 'Server tidak dapat membaca pengaturan dari database. Pastikan '
  + 'SUPABASE_SERVICE_ROLE_KEY di Vercel berisi kunci service_role (secret) proyek '
  + 'Supabase "Sandbox" — bukan kunci anon/publishable — lalu redeploy.';

// ---- V2c: AES-256-GCM secret decryption (BYOK API keys) --------------------
// Duplicated verbatim from api/pemeran.js (this file is deliberately
// self-contained — zero shared modules across api/*.js). Only decryptSecret
// is needed here (pemeran.js's admin actions own the encrypt path); kept as
// a pair anyway so the format stays obviously self-describing.
//   encryptSecret(plaintext) -> "v1:<iv_b64>:<tag_b64>:<ct_b64>"
//   decryptSecret(blob)      -> plaintext, or null on ANY failure (never
//                                throws into the request path).
function pemeranSecretKey() {
  const secret = (process.env.PEMERAN_SECRET || '').trim();
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret, 'utf8').digest();
}

function decryptSecret(blob) {
  try {
    const key = pemeranSecretKey();
    if (!key || typeof blob !== 'string') return null;
    const parts = blob.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ct = Buffer.from(parts[3], 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch (e) {
    return null; // tampered/foreign/corrupt blob, wrong key, etc. — never throw
  }
}

// ---- konstanta (kept in sync with pemeran/data/konstanta.json) ------------
const DIMENSI_PROFIL_LULUSAN = [
  'Keimanan dan Ketakwaan terhadap Tuhan YME',
  'Kewargaan',
  'Penalaran Kritis',
  'Kreativitas',
  'Kolaborasi',
  'Kemandirian',
  'Kesehatan',
  'Komunikasi',
];
const SANTRI_KITAB = ['Komunikasi', 'Inovasi', 'Terbuka', 'Argumentatif', 'Berintegritas'];

// ---- konstanta (M3 additions — kept in sync with pemeran/data/konstanta.json,
// same duplication pattern as DIMENSI_PROFIL_LULUSAN/SANTRI_KITAB above) ------
const BLOOM_LEVELS = ['C1', 'C2', 'C3', 'C4', 'C5', 'C6'];
const BLOOM_VERBS = {
  C1: { label: 'Mengingat', verba: ['mengidentifikasi', 'menyebutkan', 'mendaftar', 'mendefinisikan', 'mengenali'] },
  C2: { label: 'Memahami', verba: ['menjelaskan', 'mendeskripsikan', 'menginterpretasi', 'merangkum', 'membandingkan', 'mencontohkan'] },
  C3: { label: 'Menerapkan', verba: ['menerapkan', 'menggunakan', 'mendemonstrasikan', 'menghitung', 'melaksanakan', 'mengoperasikan'] },
  C4: { label: 'Menganalisis', verba: ['menganalisis', 'membedakan', 'mengorganisasi', 'menguji', 'mendekonstruksi'] },
  C5: { label: 'Mengevaluasi', verba: ['mengevaluasi', 'menilai', 'mengkritik', 'memutuskan', 'memverifikasi'] },
  C6: { label: 'Mencipta', verba: ['merancang', 'menyusun', 'mengkreasikan', 'memproduksi', 'merumuskan', 'mengembangkan'] },
};
const INTERVAL_DEFAULT = [
  { max: 60, label: 'Kurang' },
  { min: 61, max: 70, label: 'Cukup' },
  { min: 71, max: 80, label: 'Baik' },
  { min: 81, max: 100, label: 'Sangat Baik' },
];
const KKTP_THRESHOLD_DEFAULT = 78;

function bloomVerbBlock() {
  return BLOOM_LEVELS.map((lv) => `- ${lv} ${BLOOM_VERBS[lv].label}: ${BLOOM_VERBS[lv].verba.join(', ')}`).join('\n');
}

// =============================================================
// SYSTEM PROMPT — ported/expanded from eduforge's generateDocx.ts
// (lines ~624-664) + CLAUDE.md's "Content Verbosity Reference"
// (the gold-standard tone/length examples), translated into
// Bahasa Indonesia and the new per-field / per-pertemuan schema.
// This is the stable, cacheable block (cache_control ephemeral).
// =============================================================
const SYSTEM_PROMPT = `Anda adalah perancang kurikulum Kurikulum Merdeka (kerangka Deep Learning) untuk SMPI Al-Hamidiyah, sebuah SMP Islam di Depok, Indonesia. Tugas Anda: mengisi bagian KONTEN dari dokumen Rencana Pelaksanaan Pembelajaran (RPP) resmi sekolah — "Perencanaan Pembelajaran Mendalam" — untuk SATU topik/unit (satu RPP dapat mencakup beberapa pertemuan). Identitas dokumen (nama sekolah, guru, kelas, dsb.) dan kode TP/KKTP SUDAH diisi secara otomatis oleh sistem — jangan mengarangnya, jangan mengubah kode TP/KKTP yang diberikan.

KONTEKS SEKOLAH: SMPI Al-Hamidiyah adalah SMP Islam yang mengintegrasikan nilai keagamaan ke setiap mata pelajaran (bukan hanya di jam Pendidikan Agama) dan menanamkan nilai kearifan lokal khas sekolah bernama "SANTRI KITAB" (Komunikasi, Inovasi, Terbuka, Argumentatif, Berintegritas) di setiap pembelajaran. Sekolah menganut kerangka "Deep Learning" versi Kurikulum Merdeka dengan tiga prinsip pembelajaran yang harus tercermin dalam rancangan aktivitas:
- Mindful: peserta didik sadar akan tujuan & proses belajarnya sendiri (biasanya pada Opening — pertanyaan pemantik yang membuat mereka berpikir sebelum diberi tahu jawabannya).
- Meaningful: pembelajaran terhubung dengan kehidupan nyata/pengalaman peserta didik (contoh konkret, bukan teori abstrak).
- Joyful: pembelajaran terasa menyenangkan, bukan beban (permainan singkat, kerja kelompok, elemen kompetisi ringan).
Setiap RPP yang Anda buat harus terasa seperti ditulis oleh guru sungguhan di sekolah ini — praktis, spesifik untuk topik yang diberikan, dan bukan template generik yang bisa dipakai untuk topik apa saja.

KAMUS FIELD (field yang tidak dijelaskan di sini sudah cukup jelas dari namanya):
- peserta_didik: bagaimana guru mengecek kesiapan/pemahaman awal peserta didik sebelum masuk materi (asesmen diagnostik informal, 1 kalimat).
- capaian_element / capaian_competence / capaian_content: pemecahan elemen CP yang diberikan menjadi 3 bagian — elemen (nama elemen CP, boleh disalin dari konteks), kompetensi (kata kerja operasional sesuai Bloom di bawah), konten (frasa benda/topik yang dipelajari).
- lintas_disiplin_ilmu: satu mapel lain yang beririsan konsep dengan topik ini (opsional tapi usahakan diisi jika ada kaitan wajar).
- kemitraan (Kemitraan Pembelajaran): pihak/guru lain yang diajak koordinasi untuk pembelajaran ini, jika relevan.
- lingkungan (Lingkungan Pembelajaran): setting fisik/sosial kelas saat pembelajaran (individu/berpasangan/kelompok, di dalam/luar kelas).
- digital (Pemanfaatan Digital): alat/media digital konkret yang dipakai (bukan "menggunakan teknologi" secara umum).
- asesmen_awal/proses/akhir: metode asesmen SEBAGAI/UNTUK/TENTANG pembelajaran (as/for/of learning) — masing-masing sangat singkat.
- learning_media: daftar alat/bahan fisik atau digital yang benar-benar dipakai di kelas.

ATURAN FORMAT (berlaku di dalam setiap nilai string):
- Gunakan \\n untuk baris baru.
- Gunakan **teks** untuk tebal, *teks* untuk miring.
- Gunakan awalan ✓ untuk butir checklist/kegiatan (paling sering pada bagian Opening).
- Gunakan awalan • atau - untuk butir (bullet, akan terindentasi).
- Gunakan awalan o untuk sub-butir (indentasi ganda).
- Gunakan 1. 2. 3. untuk daftar bernomor (paling sering pada learning_media).
- JANGAN gunakan markdown lain (tabel, heading #, code fence). JANGAN membungkus jawaban dalam blok kode.

NADA & PANJANG (SANGAT PENTING — ini yang paling sering salah):
Setiap field harus SEPENDEK sel RPP asli yang ditulis guru sungguhan — bukan esai, bukan penjelasan buku teks. Guru menulis catatan kerja untuk dirinya sendiri, bukan narasi untuk pembaca luar. Total seluruh field (di luar bagian pertemuan) sekitar 150-250 kata; setiap bagian per-pertemuan (opening/memahami/mengaplikasi/merefleksi/closing) masing-masing 1-4 baris pendek.

CONTOH GAYA NYATA (dari RPP ESP Kelas 7 "Thermal Energy and Heat Transfer" yang benar-benar dipakai sekolah — tiru gaya & kepadatannya, JANGAN salin isinya untuk topik lain):
  peserta_didik: "Cek pemahaman awal siswa tentang panas & dingin melalui benda nyata (sendok logam vs kayu)."
  materi_pelajaran: "Language for Describing Heat Transfer" (3-6 kata, boleh berbahasa Inggris jika mapel ESP/Bahasa Inggris)
  internalisasi_nilai_agama: "QS. Ya-Sin (36): 80\\n\\"It is He who made for you fire from the green tree.\\"\\nMengaitkan sumber panas/energi dalam kehidupan dengan tanda kekuasaan Allah." — kutip surah:ayat yang benar-benar relevan dengan topik, jangan mengarang ayat, 2-3 baris saja.
  capaian_element / capaian_competence / capaian_content: pecahan singkat dari elemen CP menjadi kompetensi (kata kerja) dan konten (frasa benda) — beberapa kata/frasa, bukan kalimat panjang.
  lintas_disiplin_ilmu: "IPA (Science) - Heat Transfer" (satu baris: mapel lain + topik terkait)
  model: "Inquiry-Based Learning (IBL)" (nama model saja, boleh + singkatan bahasa Inggris)
  strategy: "Cooperative Learning" (nama strategi saja)
  method: "Demonstration, guided reading, diagramming" (2-4 metode, dipisah koma)
  kemitraan: "Koordinasi dengan guru IPA terkait demonstrasi heat transfer yang relevan." (1 kalimat pendek)
  lingkungan: "Demonstrasi benda nyata di depan kelas; kerja berpasangan untuk latihan bahasa." (1 kalimat pendek)
  digital: "Gambar/animasi pendek conduction-convection-radiation." (1 kalimat pendek, alat/media digital konkret)
  asesmen_awal / asesmen_proses / asesmen_akhir: 2-6 kata masing-masing, mis. "Sorting benda panas/dingin (diagnostik)."
  learning_media: daftar bernomor 1. 2. 3. 4. 5., tiap butir benda/alat konkret, bukan kalimat.
  Per pertemuan (opening/memahami/mengaplikasi/merefleksi/closing): 1-3 baris pendek per bagian, aktivitas KONKRET dengan contoh nyata (bukan instruksi generik seperti "guru menjelaskan materi") — mis. opening: "Sentuh 2 benda (sendok logam vs kayu dalam air hangat): \\"Which feels hotter? Why?\\""; memahami: "Perkenalkan perbedaan heat vs temperature + vocab (hot, cold, warm, degrees)."; mengaplikasi: "Siswa mengelompokkan benda sehari-hari sebagai \\"high/low temperature\\" memakai target vocabulary dalam kalimat."; merefleksi: "Pair-share: jelaskan beda heat & temperature dengan kata sendiri."; closing: "Recap vocabulary cepat (thumbs up/down game)."

CONTOH GAYA KEDUA (mapel non-bahasa, mis. Matematika/IPA/IPS — semuanya berbahasa Indonesia, tidak ada istilah bahasa Inggris kecuali nama model pembelajaran):
  peserta_didik: "Tanya jawab singkat tentang pengalaman siswa menimbang benda di rumah."
  materi_pelajaran: "Operasi Hitung Pecahan"
  internalisasi_nilai_agama: "QS. Ar-Rahman (55): 7-9\\n\\"Dan Dia telah meninggikan langit dan Dia meletakkan neraca (keadilan).\\"\\nMengaitkan konsep keseimbangan/pecahan dengan sikap adil dan proporsional."
  capaian_element: "**Bilangan**"
  capaian_competence: "Menghitung, membandingkan, menyederhanakan"
  capaian_content: "Pecahan biasa, pecahan campuran, operasi penjumlahan-pengurangan pecahan"
  lintas_disiplin_ilmu: "IPA — pengukuran & perbandingan dalam eksperimen"
  model: "**Problem-Based Learning (PBL)** — belajar dari masalah kontekstual sehari-hari"
  opening: "✓ Tunjukkan potongan kue yang dibagi tidak rata: \\"Adil tidak pembagiannya? Bagaimana caranya?\\""
  memahami: "Jelaskan konsep pecahan senilai dengan contoh potongan kue/kertas."
  mengaplikasi: "• Siswa menyelesaikan 3 soal cerita pembagian pecahan berkelompok."
  merefleksi: "Satu siswa per kelompok menjelaskan strategi penyelesaian ke kelas."
  closing: "Kuis lisan cepat 2-3 soal untuk cek pemahaman."

JANGAN — kesalahan umum yang harus dihindari:
- JANGAN menulis kalimat generik tanpa contoh konkret, mis. "Guru menjelaskan materi dengan baik" atau "Siswa memahami konsep dengan antusias" — selalu sertakan APA konkretnya (benda, pertanyaan, contoh, angka).
- JANGAN mengarang ayat/surah Al-Qur'an yang tidak relevan dengan topik — jika sungguh tidak ada kaitan alami, pilih ayat tentang menuntut ilmu/ciptaan Allah secara umum, jangan asal comot ayat acak.
- JANGAN membuat satu field lebih dari 4 baris (kecuali learning_media yang boleh 4-6 butir bernomor).
- JANGAN mengulang aktivitas yang identik di pertemuan yang berbeda — tiap pertemuan harus punya aktivitas dan fokus TP yang berbeda meski dalam topik yang sama.
- JANGAN memilih lebih dari 3 dimensi profil lulusan atau lebih dari 3 nilai SANTRI KITAB.
- JANGAN membuat model/strategy/method jadi sinonim satu sama lain — model adalah kerangka besar pembelajaran (mis. Inquiry-Based Learning, Problem-Based Learning, Project-Based Learning), strategy adalah pendekatan pelaksanaannya (mis. Cooperative Learning, Direct Instruction), method adalah teknik konkret di kelas (mis. demonstrasi, diskusi kelompok, tanya jawab, permainan peran) — ketiganya harus konsisten satu sama lain, bukan sekadar tiga kata acak.
- JANGAN abaikan konteks KKTP yang diberikan — asesmen_proses dan asesmen_akhir sebaiknya selaras dengan cara KKTP tersebut akan dinilai (mis. jika KKTP menyebut "menyebutkan 3 metode dengan benar", asesmen bisa berupa checklist/kuis yang mengukur persis itu).

PERIKSA SEBELUM MENGIRIM (self-check singkat, jangan tuliskan checklist ini di keluaran):
1. Apakah setiap field pertemuan benar-benar spesifik untuk topik ini (bukan bisa dipakai untuk topik lain apa saja)?
2. Apakah jumlah elemen array "pertemuan" persis sama dengan jumlah pertemuan yang diminta?
3. Apakah graduate_profile_selected & santri_kitab_selected masing-masing berisi 1-3 nilai PERSIS dari daftar yang diberikan (bukan variasi ejaan lain)?
4. Apakah total panjang keluaran tetap ringkas — tidak ada satu pun field yang terasa seperti esai?
5. Apakah bahasa konsisten (Indonesia untuk meta-konten, Inggris hanya untuk target bahasa jika mapelnya ESP/Bahasa Inggris)?

BAHASA: Tulis dalam Bahasa Indonesia untuk semua instruksi/meta-konten (kemitraan, lingkungan, asesmen, dsb). JIKA mata pelajaran adalah ESP (English for Specific Purposes) atau Bahasa Inggris, field yang memuat target bahasa (materi_pelajaran, capaian_content, istilah dalam bagian pertemuan) WAJAR memuat frasa/kosakata Bahasa Inggris — itu memang bahasa sasaran pembelajaran, persis seperti contoh pertama di atas. Untuk mata pelajaran lain (Matematika, IPA, IPS, PAI, dsb.), tulis semuanya dalam Bahasa Indonesia, seperti contoh kedua.

DIMENSI PROFIL LULUSAN (pilih 1-3 yang PALING relevan dengan topik & aktivitas — jangan pilih semua, jangan asal-asalan):
${DIMENSI_PROFIL_LULUSAN.map((d) => '- ' + d).join('\n')}

PENGEMBANGAN KARAKTER SANTRI KITAB (pilih 1-3 yang paling relevan; ini nilai kearifan lokal khas sekolah — pilih yang benar-benar tercermin dari aktivitas pembelajaran, bukan generik):
${SANTRI_KITAB.map((d) => '- ' + d).join('\n')}

TINGKAT KOGNITIF (Taksonomi Bloom) — gunakan sebagai acuan memilih kata kerja untuk capaian_competence agar sesuai jenjang SMP (Fase D) dan selaras dengan TP yang diberikan (jangan lompat ke C5/C6 untuk topik pengantar dasar):
- C1 Mengingat: mengidentifikasi, menyebutkan, mendaftar, mendefinisikan, mengenali
- C2 Memahami: menjelaskan, mendeskripsikan, menginterpretasi, merangkum, membandingkan, mencontohkan
- C3 Menerapkan: menerapkan, menggunakan, mendemonstrasikan, menghitung, melaksanakan, mengoperasikan
- C4 Menganalisis: menganalisis, membedakan, mengorganisasi, menguji, mendekonstruksi
- C5 Mengevaluasi: mengevaluasi, menilai, mengkritik, memutuskan, memverifikasi
- C6 Mencipta: merancang, menyusun, mengkreasikan, memproduksi, merumuskan, mengembangkan

STRUKTUR PER-PERTEMUAN: Setiap RPP mencakup satu atau lebih pertemuan (tatap muka) untuk topik yang sama, masing-masing 1 JP = 40 menit. Anda akan diberi tahu jumlah pertemuan yang tepat di pesan pengguna — array "pertemuan" pada keluaran WAJIB memiliki jumlah elemen yang PERSIS SAMA dengan jumlah itu, berurutan dari pertemuan pertama ke terakhir, dengan aktivitas yang membangun secara progresif (bukan mengulang topik yang sama tiap pertemuan) dan selaras dengan Tujuan Pembelajaran (TP) yang ditugaskan ke pertemuan tersebut jika disebutkan. Pertemuan pertama biasanya memperkenalkan konsep dasar/kosakata; pertemuan tengah memperdalam & melatih penerapan; pertemuan terakhir mengarah ke produk/penilaian akhir unit (mis. diagram, presentasi, proyek kecil).

Setiap pertemuan mengikuti alur "Mindful | Meaningful | Joyful" ala Deep Learning:
- opening: pembuka yang menarik perhatian (pertanyaan/aktivitas singkat, biasanya format ✓) — Mindful.
- memahami: kegiatan memahami konsep/kosakata baru — bagian dari Main.
- mengaplikasi: kegiatan menerapkan pemahaman (biasanya berkelompok/berpasangan) — bagian dari Main.
- merefleksi: kegiatan refleksi singkat (pair-share, tanya-jawab reflektif) — bagian dari Main.
- closing: penutup singkat (recap, exit ticket, kuis lisan, dsb.).

Jika beberapa kode TP ditugaskan ke satu pertemuan (dipisahkan koma pada konteks pesan pengguna), pastikan aktivitas memahami/mengaplikasi pertemuan itu mencakup SEMUA TP tersebut — jangan hanya menggarap TP pertama dan mengabaikan sisanya. Sebaliknya jika hanya satu TP per pertemuan, fokuskan seluruh aktivitas pertemuan itu pada TP tunggal tersebut secara mendalam, bukan melebar ke topik lain.

MEMBACA KONTEKS CP: Teks elemen Capaian Pembelajaran (CP) yang diberikan di pesan pengguna adalah kutipan VERBATIM dari CP nasional/kontekstual — jangan diubah kata-katanya, hanya jadi rujukan untuk menulis capaian_element/capaian_competence/capaian_content dan memastikan aktivitas pertemuan benar-benar mengarah ke kompetensi yang disebutkan di CP tersebut. Jika teks CP tidak diberikan (kosong), gunakan judul topik dan TP sebagai acuan utama.

KESESUAIAN JENJANG: Sesuaikan tingkat kerumitan bahasa & aktivitas dengan kelas yang diberikan — kelas VII (siswa baru transisi dari SD, aktivitas lebih konkret & bertahap, kosakata sederhana), kelas VIII (pertengahan, mulai lebih mandiri), kelas IX (menjelang kelulusan, aktivitas lebih menuntut analisis/proyek, mempersiapkan penilaian akhir jenjang). Semester Ganjil vs Genap tidak mengubah gaya, hanya konteks kalender (Ganjil = awal tahun ajaran, Genap = paruh kedua).

CONTOH LEBIH LANJUT UNTUK kemitraan/lingkungan/digital LINTAS MAPEL (variasikan sesuai konteks — jangan selalu pakai contoh yang sama):
- kemitraan: "Koordinasi dengan guru BK untuk sesi refleksi karakter." / "Kolaborasi dengan pustakawan untuk sumber bacaan tambahan." / "Berkoordinasi dengan guru IPS untuk konteks sejarah terkait." / "(kosongkan jika memang tidak ada kemitraan khusus untuk topik ini — tulis singkat: 'Tidak ada kemitraan khusus.')"
- lingkungan: "Setting kelas berkelompok 4-5 orang menghadap papan tulis." / "Ruang kelas ditata berpasangan untuk latihan dialog." / "Area luar kelas untuk observasi langsung objek nyata."
- digital: "Video pendek YouTube (diputar via proyektor)." / "Aplikasi kuis daring (mis. Kahoot/Quizizz) untuk cek pemahaman cepat." / "Google Slides berisi diagram & gambar pendukung." / "(kosongkan/tulis 'Tidak ada' jika pembelajaran memang tanpa alat digital.)"

Kembalikan HANYA data sesuai skema JSON yang diminta — tidak ada teks lain, tidak ada penjelasan.`;

// =============================================================
// JSON SCHEMA (structured outputs) — the ~37 template fields minus
// identity fields (filled deterministically client-side) and minus
// TP/KKTP codes (injected verbatim, never AI-authored).
// =============================================================
function pertemuanItemSchema() {
  return {
    type: 'object',
    properties: {
      opening: { type: 'string' },
      memahami: { type: 'string' },
      mengaplikasi: { type: 'string' },
      merefleksi: { type: 'string' },
      closing: { type: 'string' },
    },
    required: ['opening', 'memahami', 'mengaplikasi', 'merefleksi', 'closing'],
    additionalProperties: false,
  };
}

function rppContentSchema() {
  return {
    type: 'object',
    properties: {
      peserta_didik: { type: 'string' },
      materi_pelajaran: { type: 'string' },
      graduate_profile_selected: { type: 'array', items: { type: 'string', enum: DIMENSI_PROFIL_LULUSAN } },
      santri_kitab_selected: { type: 'array', items: { type: 'string', enum: SANTRI_KITAB } },
      internalisasi_nilai_agama: { type: 'string' },
      capaian_element: { type: 'string' },
      capaian_competence: { type: 'string' },
      capaian_content: { type: 'string' },
      lintas_disiplin_ilmu: { type: 'string' },
      model: { type: 'string' },
      strategy: { type: 'string' },
      method: { type: 'string' },
      kemitraan: { type: 'string' },
      lingkungan: { type: 'string' },
      digital: { type: 'string' },
      asesmen_awal: { type: 'string' },
      asesmen_proses: { type: 'string' },
      asesmen_akhir: { type: 'string' },
      learning_media: { type: 'string' },
      pertemuan: { type: 'array', items: pertemuanItemSchema() },
    },
    required: [
      'peserta_didik', 'materi_pelajaran', 'graduate_profile_selected', 'santri_kitab_selected',
      'internalisasi_nilai_agama', 'capaian_element', 'capaian_competence', 'capaian_content',
      'lintas_disiplin_ilmu', 'model', 'strategy', 'method', 'kemitraan', 'lingkungan', 'digital',
      'asesmen_awal', 'asesmen_proses', 'asesmen_akhir', 'learning_media', 'pertemuan',
    ],
    additionalProperties: false,
  };
}

const SINGLE_FIELD_TYPES = {
  peserta_didik: { type: 'string' },
  materi_pelajaran: { type: 'string' },
  graduate_profile_selected: { type: 'array', items: { type: 'string', enum: DIMENSI_PROFIL_LULUSAN } },
  santri_kitab_selected: { type: 'array', items: { type: 'string', enum: SANTRI_KITAB } },
  internalisasi_nilai_agama: { type: 'string' },
  capaian_element: { type: 'string' },
  capaian_competence: { type: 'string' },
  capaian_content: { type: 'string' },
  lintas_disiplin_ilmu: { type: 'string' },
  model: { type: 'string' },
  strategy: { type: 'string' },
  method: { type: 'string' },
  kemitraan: { type: 'string' },
  lingkungan: { type: 'string' },
  digital: { type: 'string' },
  asesmen_awal: { type: 'string' },
  asesmen_proses: { type: 'string' },
  asesmen_akhir: { type: 'string' },
  learning_media: { type: 'string' },
  opening: { type: 'string' },
  memahami: { type: 'string' },
  mengaplikasi: { type: 'string' },
  merefleksi: { type: 'string' },
  closing: { type: 'string' },
};

// =============================================================
// Anthropic call — internal SSE streaming accumulation so a slow
// generation doesn't risk the 60s function limit; the client only
// ever sees the final parsed JSON.
// =============================================================
async function streamClaude(body, apiKey) {
  if (!apiKey) {
    // V2c: no stored admin key AND no ANTHROPIC_API_KEY env var. Shaped like
    // an Anthropic auth failure (status 401) so fallbackWorthy() below
    // correctly treats it as fallback-worthy instead of a dead end.
    const e = new Error('Kunci Anthropic belum diatur (baik di panel admin maupun ANTHROPIC_API_KEY di Vercel).');
    e.status = 401;
    throw e;
  }
  // Bound the whole primary attempt with an abort timeout. A credit-throttled
  // Haiku sometimes STALLS the SSE stream instead of returning a fast 400 —
  // with no timeout that hangs the function until Vercel kills it at 60s (a
  // 504), and the OpenRouter fallback never runs. 30s is generous for a real
  // Haiku generation yet bails a hang early, leaving the entry-anchored
  // OpenRouter budget enough room to answer before the 60s cap. An abort
  // throws (no .status) → fallbackWorthy() treats it as fallback-worthy.
  const ctrl = new AbortController();
  const haikuTimer = setTimeout(() => ctrl.abort(), STREAM_TIMEOUT_MS);
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(Object.assign({}, body, { stream: true })),
    });
  } catch (e) {
    clearTimeout(haikuTimer);
    if (e && e.name === 'AbortError') throw new Error('AI utama (Anthropic) tidak merespons tepat waktu.');
    throw e;
  }

  if (!r.ok || !r.body) {
    clearTimeout(haikuTimer);
    let errText = '';
    try { errText = await r.text(); } catch (e) { /* ignore */ }
    let msg = 'Claude API error ' + r.status;
    try {
      const parsed = JSON.parse(errText);
      if (parsed && parsed.error && parsed.error.message) msg = parsed.error.message;
    } catch (e) { if (errText) msg += ': ' + errText.slice(0, 300); }
    const err = new Error(msg);
    err.status = r.status; // lets callModel() classify billing/outage vs our-own-bug
    throw err;
  }

  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const blocks = [];
  const message = { stop_reason: null, usage: {}, model: null };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let dataStr = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('data:')) dataStr += line.slice(5).trim();
        }
        if (!dataStr) continue;
        let evt;
        try { evt = JSON.parse(dataStr); } catch (e) { continue; }

        if (evt.type === 'message_start' && evt.message) {
          message.usage = evt.message.usage || {};
          message.model = evt.message.model;
        } else if (evt.type === 'content_block_start') {
          blocks[evt.index] = Object.assign({ text: '' }, evt.content_block);
        } else if (evt.type === 'content_block_delta') {
          const b = blocks[evt.index];
          if (b && evt.delta && evt.delta.type === 'text_delta') b.text += evt.delta.text;
        } else if (evt.type === 'message_delta') {
          if (evt.delta && evt.delta.stop_reason) message.stop_reason = evt.delta.stop_reason;
          if (evt.usage) Object.assign(message.usage, evt.usage);
        } else if (evt.type === 'error' && evt.error) {
          const err = new Error(evt.error.message || 'Claude stream error');
          err.midStream = true; // e.g. overloaded_error — provider-side, fallback-worthy
          throw err;
        }
      }
    }
  } catch (e) {
    // Timeout mid-stream (abort) or transport error → fallback-worthy (no .status).
    if (e && e.name === 'AbortError') throw new Error('AI utama (Anthropic) berhenti merespons di tengah jalan.');
    throw e;
  } finally {
    clearTimeout(haikuTimer);
  }

  message.content = blocks;
  return message;
}

function textOf(message) {
  return (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// =============================================================
// V2a #8 — fallback-output sanitizer. Free/fallback OpenRouter models (and,
// occasionally, Haiku too under pressure) emit unresolved placeholder
// brackets ("[masukkan topik]"), stray pseudo-HTML tags, control chars, or
// junk/mojibake Unicode instead of real content. A real character
// WHITELIST (not just stripping a few known-bad patterns) is used here —
// applied to every string in every parsed AI response, for ALL providers
// (cheap insurance, not just the OpenRouter path), right where
// extractJsonObject() turns raw model text into a JS value, so nothing
// downstream (client UI, DOCX/MHT/PDF export) ever sees it.
// =============================================================
const SANITIZE_KEEP_EXTRA = new Set([
  '✓', // ✓
  '•', // •
  '–', '—', // – —
  '☐', '☑', // ☐ ☑
  '°', // °
  '≥', '≤', // ≥ ≤
  '×', // ×
  '′', // ′
  '‘', '’', // ' '
  '“', '”', // " "
  '…', // …
]);
// [masukkan topik di sini] / [...] placeholder brackets a lazy model left unresolved.
const BRACKET_PLACEHOLDER_RE = /\[[^[\]\n]{0,80}\]/g;
// stray <tag>/</tag> pseudo-HTML/markdown a model wasn't asked to produce.
const STRAY_TAG_RE = /<\/?[a-zA-Z][^<>\n]{0,80}>/g;

function isAllowedChar(ch) {
  const code = ch.codePointAt(0);
  if (code === 9 || code === 10 || code === 13) return true; // tab / \n / \r
  if (code >= 0x20 && code <= 0x7e) return true; // ASCII printable
  if (code >= 0xa0 && code <= 0xff) return true; // Latin-1 supplement (loanwords/accents)
  return SANITIZE_KEEP_EXTRA.has(ch);
}

function sanitizeText(s) {
  if (typeof s !== 'string' || !s) return s;
  const before = s.length;
  let out = s.replace(BRACKET_PLACEHOLDER_RE, '').replace(STRAY_TAG_RE, '');
  out = Array.from(out).filter(isAllowedChar).join('');
  out = out
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (before > 20 && (before - out.length) / before > 0.05) {
    console.warn('[sanitize] stripped ~' + Math.round((1 - out.length / before) * 100) + '% of a field (' + before + ' -> ' + out.length + ' chars): "' + s.slice(0, 60) + '..."');
  }
  return out;
}

/** Recursively sanitize every string value in a parsed AI JSON response. */
function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitizeDeep(value[k]);
    return out;
  }
  return value;
}

function extractJsonObject(text) {
  let raw = (text || '').trim();
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (e) { /* fall through */ }
  if (!parsed) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (e) { /* ignore */ } }
  }
  return parsed ? sanitizeDeep(parsed) : null;
}

// =============================================================
// OpenRouter fallback — keeps the app alive when the Anthropic
// wallet runs dry. Haiku stays PRIMARY (quality); free OpenRouter
// models catch billing/outage failures so generation never bricks.
// Requires Vercel env OPENROUTER_API_KEY (free account key).
// =============================================================

// Free-model cascade, FAST-first (verified free + response_format-capable on
// openrouter.ai/api/v1/models, 2026-07-12). Speed matters more than peak
// quality here — this is a fallback whose output is already flagged "draft,
// periksa lebih teliti", and the whole cascade must finish inside Vercel's
// 60s Hobby function cap (cannot be raised). The 80B/120B models that were
// here before regularly blew the budget → 504; small MoE/instruct models
// respond in time. `openrouter/free` is OpenRouter's auto-router catch-all.
// Roster rots — the V2c admin panel makes this list editable.
const OPENROUTER_MODELS = [
  'google/gemma-4-26b-a4b-it:free',
  'openai/gpt-oss-20b:free',
  'openrouter/free',
];
// Hard wall-clock budget for the WHOLE cascade, measured from function entry
// (requestStartMs) so the time Haiku already burned on the auto path counts.
// 48s < the 60s Vercel cap, leaving margin to serialize the response. Without
// this, 3 sequential slow attempts 504'd instead of returning a clean error.
const OR_TOTAL_BUDGET_MS = 44000; // whole OpenRouter cascade, from function entry
const OR_MIN_ATTEMPT_MS = 8000;   // don't start an attempt that can't plausibly finish
const OR_MAX_ATTEMPT_MS = 30000;  // per-attempt ceiling even when budget is ample
// Bound the PRIMARY Anthropic attempt so a credit-throttled Haiku that stalls
// the SSE stream can't hang the whole function to the 60s Vercel cap (which
// left the fallback no room and 504'd). Generous enough for a real generation.
const STREAM_TIMEOUT_MS = 30000;

// One request per Vercel invocation → module scope is a safe per-request slot.
let forceProvider = null;   // 'anthropic' | 'openrouter' | null (auto)
let requestStartMs = 0;     // set at handler entry; anchors the OpenRouter budget
let cachedAiConfig = null;  // set at handler entry; V2c BYOK resolution (see below)

// =============================================================
// V2c BYOK — reads the `ai_config` row from pemeran_settings ONCE per
// request (cachedAiConfig is reset to null at handler entry, so this is a
// per-invocation cache, not a warm-lambda cache — the admin panel can change
// the row between requests and every new request picks it up). Resolution
// order per key: decrypted stored key ?? process.env.<ENV> ?? null. This
// closes the "roster rots" problem (model/fallback list now admin-editable)
// AND lets the school switch models (e.g. to claude-sonnet-4-6) without a
// redeploy. Falls back to the pre-V2c hardcoded defaults if the row is
// missing/unreadable, so nothing breaks for a project that hasn't run the
// V2c migration or hasn't set PEMERAN_SECRET yet.
// =============================================================
async function resolveAiConfig() {
  if (cachedAiConfig) return cachedAiConfig;
  let ai = {};
  try {
    const r = await supa('/rest/v1/pemeran_settings?select=value&key=eq.ai_config');
    const row = r.ok && Array.isArray(r.json) && r.json[0];
    ai = (row && row.value) || {};
  } catch (e) {
    ai = {}; // Supabase hiccup — fall through to env-var-only resolution below
  }
  const keys = ai.keys || {};
  cachedAiConfig = {
    anthropicKey: decryptSecret(keys.anthropic) || (process.env.ANTHROPIC_API_KEY || '').trim() || null,
    openrouterKey: decryptSecret(keys.openrouter) || (process.env.OPENROUTER_API_KEY || '').trim() || null,
    anthropicModel: (ai.anthropicModel && String(ai.anthropicModel).trim()) || MODEL,
    openrouterModels: (Array.isArray(ai.openrouterModels) && ai.openrouterModels.length) ? ai.openrouterModels : OPENROUTER_MODELS,
  };
  return cachedAiConfig;
}

// Anthropic failures that justify falling back: billing/credit (the whole point),
// auth, rate-limit, and provider-side outages. Plain 400s do NOT fall back —
// those are our own request bugs and masking them would hide real defects.
function fallbackWorthy(err) {
  if (!err) return false;
  if (err.midStream) return true;                    // mid-stream provider error
  const s = Number(err.status);
  if ([401, 402, 403, 429, 500, 502, 503, 529].includes(s)) return true;
  if (s === 400) return /credit|billing|balance/i.test(String(err.message || ''));
  if (!s) return true;                               // network-level failure (fetch threw)
  return false;
}

function flattenAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join('\n');
  }
  return '';
}

async function callOpenRouter(anthropicBody, cfg) {
  const key = (cfg && cfg.openrouterKey) || '';
  if (!key) {
    const e = new Error('OPENROUTER_KEY_MISSING');
    e.noKey = true;
    throw e;
  }
  const models = (cfg && Array.isArray(cfg.openrouterModels) && cfg.openrouterModels.length)
    ? cfg.openrouterModels : OPENROUTER_MODELS;

  const messages = [];
  const sys = flattenAnthropicContent(anthropicBody.system);
  if (sys) messages.push({ role: 'system', content: sys });
  for (const m of (anthropicBody.messages || [])) {
    messages.push({ role: m.role, content: flattenAnthropicContent(m.content) });
  }

  const schema = anthropicBody.output_config
    && anthropicBody.output_config.format
    && anthropicBody.output_config.format.schema;

  // Free models honour a response_format schema only loosely (strict:false is
  // required — many reject strict:true outright). Reinforcing the EXACT shape
  // as plain-text instruction dramatically improves the odds their JSON matches
  // what the deterministic caller expects (e.g. the top-level `perElemen` key),
  // instead of a validly-parsed-but-wrong-shape object the caller then rejects.
  if (schema) {
    messages.push({
      role: 'user',
      content: 'PENTING (format keluaran): Balas HANYA dengan satu objek JSON yang '
        + 'PERSIS mengikuti struktur/kunci skema berikut — tanpa teks lain, tanpa '
        + 'membungkusnya di bawah kunci tambahan, tanpa markdown/```:\n'
        + JSON.stringify(schema),
    });
  }

  let lastErr = null;
  let ranOutOfTime = false;
  const anchor = requestStartMs || Date.now();
  for (const model of models) {
    // Budget guard: only start an attempt if enough wall-clock remains to
    // plausibly finish it AND still return before the 60s function cap.
    const remaining = OR_TOTAL_BUDGET_MS - (Date.now() - anchor);
    if (remaining < OR_MIN_ATTEMPT_MS) { ranOutOfTime = true; break; }
    const attemptMs = Math.min(OR_MAX_ATTEMPT_MS, remaining - 3000);

    const payload = {
      model,
      messages,
      max_tokens: anthropicBody.max_tokens || 4000,
    };
    // strict:false = best-effort guidance; support varies wildly across free
    // models and we validate the JSON ourselves below anyway.
    if (schema) {
      payload.response_format = {
        type: 'json_schema',
        json_schema: { name: 'result', strict: false, schema },
      };
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), attemptMs);
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          Authorization: 'Bearer ' + key,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://www.dhiya.id/pemeran',
          'X-Title': 'Pemeran',
        },
        body: JSON.stringify(payload),
      });
      clearTimeout(timer);
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        lastErr = new Error((data && data.error && data.error.message) || ('OpenRouter HTTP ' + r.status));
        continue; // next model
      }
      const text = data && data.choices && data.choices[0]
        && data.choices[0].message && data.choices[0].message.content;
      if (!text) { lastErr = new Error('OpenRouter: jawaban kosong dari ' + model); continue; }
      // Actions assume parseable JSON — enforce it here so a schema-ignoring
      // free model rolls to the next candidate instead of breaking the caller.
      if (schema && !extractJsonObject(text)) {
        lastErr = new Error('OpenRouter: ' + model + ' tidak mengembalikan JSON valid');
        continue;
      }
      const u = (data && data.usage) || {};
      return {
        content: [{ type: 'text', text }],
        usage: { input_tokens: u.prompt_tokens ?? null, output_tokens: u.completion_tokens ?? null },
        model: 'or:' + ((data && data.model) || model), // 'or:' prefix marks fallback rows in gen_log
        stop_reason: 'end_turn',
        _fb: true,
      };
    } catch (e) {
      lastErr = (e && e.name === 'AbortError')
        ? new Error('OpenRouter: ' + model + ' melebihi batas waktu')
        : e;
    }
  }
  if (ranOutOfTime || (lastErr && /batas waktu/.test(String(lastErr.message)))) {
    throw new Error('Model cadangan gratis sedang lambat/sibuk (kehabisan waktu). '
      + 'Coba lagi sebentar lagi, atau isi ulang kredit AI utama untuk hasil instan.');
  }
  throw (lastErr || new Error('Semua model cadangan gratis gagal.'));
}

// The single entry every action uses. Primary = Anthropic (BYOK-resolved
// model/key via resolveAiConfig()); on billing/outage failures (or an
// explicit provider override) → OpenRouter (also BYOK-resolved).
async function callModel(requestBody) {
  const cfg = await resolveAiConfig();
  // V2c: the admin-configured model (or its 'claude-haiku-4-5' default)
  // always wins over whatever literal the caller put in requestBody.model —
  // every call site still writes `model: MODEL` for readability, but this is
  // the actual model that goes out over the wire.
  const body = Object.assign({}, requestBody, { model: cfg.anthropicModel });

  if (forceProvider === 'openrouter') {
    try {
      return await callOpenRouter(body, cfg);
    } catch (e) {
      if (e && e.noKey) {
        throw new Error('Cadangan gratis belum disiapkan — tambahkan OPENROUTER_API_KEY '
          + '(kunci akun gratis openrouter.ai) di Vercel → Environment Variables atau di panel admin, lalu coba lagi.');
      }
      throw e;
    }
  }
  try {
    return await streamClaude(body, cfg.anthropicKey);
  } catch (err) {
    if (forceProvider === 'anthropic' || !fallbackWorthy(err)) throw err;
    try {
      return await callOpenRouter(body, cfg);
    } catch (orErr) {
      if (orErr && orErr.noKey) {
        throw new Error('AI utama gagal (' + String(err.message || err).slice(0, 200) + ') '
          + 'dan cadangan gratis belum disiapkan — tambahkan OPENROUTER_API_KEY '
          + '(kunci akun gratis openrouter.ai) di Vercel → Environment Variables atau di panel admin, lalu redeploy.');
      }
      throw new Error('AI utama gagal (' + String(err.message || err).slice(0, 160) + ') '
        + 'dan semua model cadangan gratis juga gagal (' + String(orErr.message || orErr).slice(0, 160) + '). Coba lagi nanti.');
    }
  }
}

async function logGen(planId, action, message) {
  try {
    const usage = message.usage || {};
    const row = {
      plan_id: isUuid(planId) ? planId : null,
      action,
      model: message.model || MODEL,
      input_tokens: usage.input_tokens ?? null,
      output_tokens: usage.output_tokens ?? null,
      cache_read: usage.cache_read_input_tokens ?? null,
      cache_write: usage.cache_creation_input_tokens ?? null,
    };
    await supa('/rest/v1/pemeran_gen_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (e) {
    // Cost logging must never break the actual generation response.
  }
}

// ---- request-shaping helpers -----------------------------------------------
function clampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function normalizeUnit(unit) {
  unit = unit && typeof unit === 'object' ? unit : {};
  const tpList = Array.isArray(unit.tpList) ? unit.tpList.slice(0, 30).map((t) => ({
    kode: clampStr(t && t.kode, 40),
    rumusan: clampStr(t && t.rumusan, 400),
  })) : [];
  const kktpList = Array.isArray(unit.kktpList) ? unit.kktpList.slice(0, 30).map((k) => ({
    kode: clampStr(k && k.kode, 40),
    kriteria: clampStr(k && k.kriteria, 400),
  })) : [];
  const jp = Number(unit.jp) > 0 ? Number(unit.jp) : 2;
  const jpPerPertemuan = Number(unit.jpPerPertemuan) > 0 ? Number(unit.jpPerPertemuan) : 2;
  const pertemuanCount = Number(unit.pertemuanCount) > 0
    ? Math.round(Number(unit.pertemuanCount))
    : Math.max(1, Math.ceil(jp / jpPerPertemuan));
  return {
    topik: clampStr(unit.topik || unit.nama, 200),
    mapel: clampStr(unit.mapel, 100),
    kelas: unit.kelas != null ? Number(unit.kelas) : null,
    semester: Number(unit.semester) === 2 ? 2 : 1,
    cpElemen: clampStr(unit.cpElemen, 2000),
    jp,
    jpPerPertemuan,
    pertemuanCount: Math.min(pertemuanCount, 20),
    tpList,
    kktpList,
  };
}

function buildUserPrompt(unit) {
  const tpLines = unit.tpList.length
    ? unit.tpList.map((t) => `${t.kode}: ${t.rumusan}`).join('\n')
    : '(belum ada TP spesifik — susun konten berdasarkan topik & CP saja)';
  const kktpLines = unit.kktpList.length
    ? unit.kktpList.map((k) => `${k.kode}: ${k.kriteria}`).join('\n')
    : '(belum ada KKTP spesifik)';

  return `Buatkan konten RPP untuk unit/topik berikut.

Mata Pelajaran: ${unit.mapel || '(tidak disebutkan)'}
Kelas: ${unit.kelas ? 'VII/VIII/IX (angka ' + unit.kelas + ')' : '(tidak disebutkan)'}
Semester: ${unit.semester === 2 ? 'Genap' : 'Ganjil'}
Topik/Judul Unit: "${unit.topik || '(tidak disebutkan)'}"
Total JP unit ini: ${unit.jp} JP (1 JP = 40 menit)
Jumlah pertemuan untuk unit ini: ${unit.pertemuanCount} — array "pertemuan" pada keluaran HARUS berisi TEPAT ${unit.pertemuanCount} elemen.

Konteks Capaian Pembelajaran (elemen terkait, verbatim dari CP nasional/kontekstual — jangan diubah, hanya jadi acuan):
${unit.cpElemen || '(tidak disebutkan — gunakan judul topik sebagai acuan utama)'}

Tujuan Pembelajaran (TP) yang harus dicapai unit ini (kode TP JANGAN diulang di keluaran Anda — ini hanya konteks):
${tpLines}

Kriteria Ketercapaian TP (KKTP) terkait (konteks saja):
${kktpLines}

Susun seluruh field sesuai skema yang diberikan, mengikuti aturan format, nada, dan panjang pada instruksi sistem.`;
}

// V2a #3 root cause: the OLD generate_rpp asked for ALL meetings' content
// (up to 15 x 5 rich-text fields) in ONE Haiku call (max_tokens 8000) — the
// 504 on any unit with more than a handful of meetings. Split into:
//   generate_rpp_base    — the ~19 unit-level fields only, NO "pertemuan".
//   generate_rpp_meeting — ONE meeting's 5 phases only.
// so the client can orchestrate N small, individually-retriable calls with
// visible progress instead of one big one that either fully succeeds or
// times out with nothing to show for it.

function rppBaseSchema() {
  const full = rppContentSchema();
  const properties = Object.assign({}, full.properties);
  delete properties.pertemuan;
  return {
    type: 'object',
    properties,
    required: full.required.filter((k) => k !== 'pertemuan'),
    additionalProperties: false,
  };
}

function buildBaseUserPrompt(unit) {
  const tpLines = unit.tpList.length
    ? unit.tpList.map((t) => `${t.kode}: ${t.rumusan}`).join('\n')
    : '(belum ada TP spesifik — susun konten berdasarkan topik & CP saja)';
  const kktpLines = unit.kktpList.length
    ? unit.kktpList.map((k) => `${k.kode}: ${k.kriteria}`).join('\n')
    : '(belum ada KKTP spesifik)';

  return `Buatkan HANYA bagian identitas/konten tingkat-UNIT RPP berikut — BUKAN isi per pertemuan. Field "pertemuan" TIDAK termasuk skema ini; setiap pertemuan akan diminta secara terpisah setelah ini, jadi jangan menyinggung konten pertemuan tertentu di field manapun.

Mata Pelajaran: ${unit.mapel || '(tidak disebutkan)'}
Kelas: ${unit.kelas ? 'VII/VIII/IX (angka ' + unit.kelas + ')' : '(tidak disebutkan)'}
Semester: ${unit.semester === 2 ? 'Genap' : 'Ganjil'}
Topik/Judul Unit: "${unit.topik || '(tidak disebutkan)'}"
Total JP unit ini: ${unit.jp} JP (1 JP = 40 menit), ${unit.pertemuanCount} pertemuan.

Konteks Capaian Pembelajaran (elemen terkait, verbatim dari CP nasional/kontekstual — jangan diubah, hanya jadi acuan):
${unit.cpElemen || '(tidak disebutkan — gunakan judul topik sebagai acuan utama)'}

Tujuan Pembelajaran (TP) yang harus dicapai unit ini (kode TP JANGAN diulang di keluaran Anda — ini hanya konteks):
${tpLines}

Kriteria Ketercapaian TP (KKTP) terkait (konteks saja):
${kktpLines}

Susun seluruh field sesuai skema yang diberikan (field tingkat-unit saja, TANPA "pertemuan"), mengikuti aturan format, nada, dan panjang pada instruksi sistem.`;
}

function buildMeetingUserPrompt(unit, meetingIndex, tpChunk, jp, menit) {
  const chunk = Array.isArray(tpChunk) && tpChunk.length ? tpChunk : unit.tpList;
  const tpLines = chunk.length
    ? chunk.map((t) => `${t.kode}: ${t.rumusan}`).join('\n')
    : '(tidak ada TP spesifik untuk pertemuan ini — gunakan topik/CP unit sebagai acuan)';
  const jpThis = Number(jp) > 0 ? Number(jp) : unit.jpPerPertemuan;
  const menitThis = Number(menit) > 0 ? Number(menit) : jpThis * 40;

  return `Buatkan HANYA konten 5 fase SATU pertemuan RPP (opening, memahami, mengaplikasi, merefleksi, closing) — bukan seluruh RPP, bukan pertemuan lain.

Mata Pelajaran: ${unit.mapel || '(tidak disebutkan)'}
Kelas: ${unit.kelas ? 'VII/VIII/IX (angka ' + unit.kelas + ')' : '(tidak disebutkan)'}
Semester: ${unit.semester === 2 ? 'Genap' : 'Ganjil'}
Topik/Judul Unit: "${unit.topik || '(tidak disebutkan)'}"
Pertemuan ke: ${meetingIndex + 1} dari ${unit.pertemuanCount} — sesuaikan posisi (pengantar/pendalaman/penutup unit) dengan urutan ini.
JP pertemuan ini: ${jpThis} JP (${menitThis} menit total).

Konteks Capaian Pembelajaran (acuan, verbatim, jangan diubah):
${unit.cpElemen || '(tidak disebutkan — gunakan judul topik sebagai acuan utama)'}

Tujuan Pembelajaran (TP) yang menjadi FOKUS pertemuan ini (kode TP JANGAN diulang di keluaran):
${tpLines}

Kembalikan HANYA field opening/memahami/mengaplikasi/merefleksi/closing sesuai skema, mengikuti aturan format, nada, dan panjang pada instruksi sistem.`;
}

/** Shared core: one Haiku/OpenRouter call for the unit-level base fields
 *  (no "pertemuan"). Used by both generate_rpp_base and the deprecated
 *  generate_rpp alias below. */
async function generateRppBaseContent(unit) {
  const requestBody = {
    model: MODEL,
    max_tokens: 2500,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildBaseUserPrompt(unit) }],
    output_config: { format: { type: 'json_schema', schema: rppBaseSchema() } },
  };
  const message = await callModel(requestBody);
  if (message.stop_reason === 'refusal') return { refusal: true, message };
  return { data: extractJsonObject(textOf(message)), message };
}

/** Shared core: one Haiku/OpenRouter call for ONE meeting's 5 phases. */
async function generateRppMeetingContent(unit, meetingIndex, tpChunk, jp, menit) {
  const requestBody = {
    model: MODEL,
    max_tokens: 1200,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildMeetingUserPrompt(unit, meetingIndex, tpChunk, jp, menit) }],
    output_config: { format: { type: 'json_schema', schema: pertemuanItemSchema() } },
  };
  const message = await callModel(requestBody);
  if (message.stop_reason === 'refusal') return { refusal: true, message };
  return { data: extractJsonObject(textOf(message)), message };
}

async function generateRppBase(body, res) {
  const unit = normalizeUnit(body.unit);
  if (!unit.topik) return res.status(400).json({ error: 'Topik/nama unit wajib diisi.' });

  let result;
  try {
    result = await generateRppBaseContent(unit);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
  }
  if (result.refusal) {
    return res.status(502).json({ error: 'AI menolak membuat konten untuk permintaan ini. Coba ubah topik atau data unit, lalu coba lagi.' });
  }
  if (!result.data) {
    return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
  }

  await logGen(body.planId, 'generate_rpp_base', result.message);
  return res.status(200).json({ ok: true, fallback: (result.message && result.message._fb) || undefined, data: result.data });
}

async function generateRppMeeting(body, res) {
  const unit = normalizeUnit(body.unit);
  if (!unit.topik) return res.status(400).json({ error: 'Topik/nama unit wajib diisi.' });

  const meetingIndex = Number.isInteger(body.meetingIndex) && body.meetingIndex >= 0 ? body.meetingIndex : 0;
  const tpChunk = Array.isArray(body.tpChunk) ? body.tpChunk.slice(0, 10).map((t) => ({
    kode: clampStr(t && t.kode, 40),
    rumusan: clampStr(t && t.rumusan, 400),
  })) : unit.tpList;
  const jp = Number(body.jp) > 0 ? Number(body.jp) : unit.jpPerPertemuan;
  const menit = Number(body.menit) > 0 ? Number(body.menit) : jp * 40;

  let result;
  try {
    result = await generateRppMeetingContent(unit, meetingIndex, tpChunk, jp, menit);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
  }
  if (result.refusal) {
    return res.status(502).json({ error: 'AI menolak permintaan ini. Coba lagi.' });
  }
  if (!result.data) {
    return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
  }

  await logGen(body.planId, 'generate_rpp_meeting', result.message);
  return res.status(200).json({ ok: true, fallback: (result.message && result.message._fb) || undefined, meetingIndex, data: result.data });
}

/** DEPRECATED — kept only so an old cached client page (or anything mid-
 *  deploy) doesn't hard-break: delegates to the same base+per-meeting core
 *  functions above, looped server-side. New client code MUST use
 *  generate_rpp_base + generate_rpp_meeting instead (per-meeting progress,
 *  per-meeting retry, resumability — none of which this alias provides). */
async function generateRpp(body, res) {
  const unit = normalizeUnit(body.unit);
  if (!unit.topik) return res.status(400).json({ error: 'Topik/nama unit wajib diisi.' });

  let baseResult;
  try {
    baseResult = await generateRppBaseContent(unit);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
  }
  if (baseResult.refusal) {
    return res.status(502).json({ error: 'AI menolak membuat konten untuk permintaan ini. Coba ubah topik atau data unit, lalu coba lagi.' });
  }
  if (!baseResult.data) {
    return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
  }

  const data = baseResult.data;
  data.pertemuan = [];
  let usedFallback = !!(baseResult.message && baseResult.message._fb);

  for (let i = 0; i < unit.pertemuanCount; i++) {
    let mResult;
    try {
      mResult = await generateRppMeetingContent(unit, i, unit.tpList, unit.jpPerPertemuan, unit.jpPerPertemuan * 40);
    } catch (e) {
      data.pertemuan.push({ opening: '', memahami: '', mengaplikasi: '', merefleksi: '', closing: '' });
      continue;
    }
    data.pertemuan.push(mResult.data || { opening: '', memahami: '', mengaplikasi: '', merefleksi: '', closing: '' });
    if (mResult.message && mResult.message._fb) usedFallback = true;
  }

  await logGen(body.planId, 'generate_rpp', baseResult.message);
  return res.status(200).json({ ok: true, fallback: usedFallback || undefined, data, pertemuanCount: unit.pertemuanCount });
}

async function regenerateField(body, res) {
  const field = typeof body.field === 'string' ? body.field : '';
  const schemaType = SINGLE_FIELD_TYPES[field];
  if (!schemaType) return res.status(400).json({ error: 'Field tidak dikenal: ' + field });

  const unit = normalizeUnit(body.unit);
  const current = typeof body.current === 'string' ? body.current.slice(0, 4000)
    : (Array.isArray(body.current) ? body.current.slice(0, 20) : '');
  const meetingIndex = Number.isInteger(body.meetingIndex) ? body.meetingIndex : null;

  const isPertemuanField = ['opening', 'memahami', 'mengaplikasi', 'merefleksi', 'closing'].includes(field);
  const meetingNote = isPertemuanField && meetingIndex != null
    ? `\nField ini adalah bagian "${field}" untuk pertemuan ke-${meetingIndex + 1} dari ${unit.pertemuanCount}.`
    : '';

  const userPrompt = `Regenerasi HANYA satu field RPP: "${field}".

${buildUserPrompt(unit)}
${meetingNote}

Isi field "${field}" saat ini (untuk konteks — buat versi BARU yang lebih baik/berbeda, jangan hanya menyalinnya):
${typeof current === 'string' ? current : JSON.stringify(current)}

Kembalikan HANYA objek JSON {"value": ...} sesuai skema.`;

  const requestBody = {
    model: MODEL,
    max_tokens: 1200,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
    output_config: {
      format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: { value: schemaType },
          required: ['value'],
          additionalProperties: false,
        },
      },
    },
  };

  let message;
  try {
    message = await callModel(requestBody);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
  }

  if (message.stop_reason === 'refusal') {
    return res.status(502).json({ error: 'AI menolak permintaan ini. Coba lagi.' });
  }

  const data = extractJsonObject(textOf(message));
  if (!data || !('value' in data)) {
    return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
  }

  await logGen(body.planId, 'regenerate_field', message);
  return res.status(200).json({ ok: true, fallback: (message && message._fb) || undefined, field, value: data.value, meetingIndex });
}

// =============================================================
// M3 — generate_tp / generate_kktp / generate_atp / draft_capaian_mulok
// / regenerate_item. Deterministic code (kode assignment, JP math,
// coverage validation) lives in pemeran/js/pipeline.js on the client —
// these actions return AI content only, per the plan's "AI (Haiku)
// returns / deterministic code" split.
// =============================================================

// ---- TAHAP 1 — TP (SOP §5.2) ------------------------------------------------
const TP_SYSTEM_PROMPT = `Anda adalah asisten kurikulum Kurikulum Merdeka untuk sekolah Fase D (SMP kelas VII-IX), mengikuti Panduan Teknis Penyusunan Perangkat Pembelajaran sekolah (SOP §5 — Menyusun TP/Tujuan Pembelajaran). Tugas Anda: memecah (breakdown) SATU teks Capaian Pembelajaran (CP) per elemen menjadi beberapa TP (Tujuan Pembelajaran) operasional dan terukur.

ALGORITMA (SOP §5.2 — ikuti persis):
Langkah 1. Teks CP yang diberikan adalah kutipan VERBATIM dari sumber resmi — jangan diparafrasakan, hanya jadi bahan analisis.
Langkah 2. Uraikan teks CP menjadi 3 komponen: (a) Kompetensi — kata kerja inti (mis. "memahami", "menjelaskan", "membuat"), (b) Konten — materi/objek yang dipelajari, (c) Konteks/Variasi — kondisi, media, atau tingkat kerumitan yang disebutkan CP.
Langkah 3. Untuk setiap kombinasi Kompetensi+Konten yang BERBEDA dalam CP tersebut, buat SATU baris TP terpisah. WAJIB pakai kata kerja operasional dan terukur (lihat daftar Bloom di bawah) — JANGAN pakai kata kerja tidak terukur seperti "mengetahui" atau "memahami" secara mentah sebagai kata kerja TP itu sendiri (boleh muncul di teks CP, tapi TP harus lebih spesifik/operasional).
Langkah 4. Rumuskan tiap TP dengan pola PERSIS: "Peserta didik dapat [Kata Kerja Operasional] [Konten/Materi] [Konteks, jika relevan]." Contoh pola: "Peserta didik dapat menjelaskan proses perpindahan panas melalui konduksi, konveksi, dan radiasi dalam bahasa Inggris sederhana."
Langkah 5. Validasi cakupan diri sendiri sebelum menjawab: jumlah TP yang dihasilkan harus benar-benar mewakili SELURUH kompetensi yang disebutkan CP (tidak under-coverage — ada kompetensi CP yang tidak terwakili; tidak over-coverage/scope creep — TP menambahkan kompetensi yang TIDAK ada di teks CP).

JUMLAH TP: hasilkan 3-6 TP per elemen CP (secukupnya untuk mewakili kompetensi dalam teks — jangan memaksa jumlah tertentu jika teks CP memang hanya memuat sedikit kompetensi berbeda, tapi jangan kurang dari 3 kecuali CP-nya benar-benar sangat sempit).

TINGKAT KOGNITIF (Taksonomi Bloom Revisi, SOP Lampiran 14.1) — setiap TP WAJIB diberi label level Bloom (C1-C6) sesuai kata kerja operasionalnya:
${bloomVerbBlock()}
Sesuaikan level dengan jenjang SMP (Fase D): kelas VII cenderung C1-C3, kelas VIII C2-C4, kelas IX dapat mencapai C4-C5 untuk topik lanjutan — jangan lompat ke C5/C6 untuk kompetensi pengantar/dasar.

JANGAN — kesalahan umum yang harus dihindari (temuan nyata SOP §5.5):
- JANGAN mengubah/memparafrasakan teks CP — hanya jadikan acuan analisis.
- JANGAN membuat TP yang menambahkan kompetensi di luar teks CP (scope creep).
- JANGAN mengulang TP yang secara substansi sama dengan kalimat berbeda.
- JANGAN memakai kata kerja yang sama untuk semua TP dalam satu elemen — variasikan sesuai kompetensi yang berbeda dalam teks CP.

BAHASA: Tulis rumusan TP dalam Bahasa Indonesia. Jika mata pelajaran adalah ESP (English for Specific Purposes) atau Bahasa Inggris dan CP menyebut keterampilan berbahasa Inggris, bagian Konten/Materi boleh memuat istilah/topik dalam Bahasa Inggris (target bahasa), tetapi kerangka kalimat TP ("Peserta didik dapat ...") tetap Bahasa Indonesia.

Anda akan menerima BEBERAPA elemen CP sekaligus (dalam urutan yang diberikan) — kembalikan hasil untuk SETIAP elemen tersebut, dalam urutan yang SAMA PERSIS dengan urutan elemen yang diberikan (elemen pertama di pesan = elemen pertama di keluaran, dst. — jangan diacak atau dilewati).

Kembalikan HANYA data sesuai skema JSON yang diminta — tidak ada teks lain, tidak ada penjelasan, tidak ada checklist yang dituliskan.`;

function tpSchema(nElemen) {
  return {
    type: 'object',
    properties: {
      perElemen: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  rumusan: { type: 'string' },
                  bloom: { type: 'string', enum: BLOOM_LEVELS },
                },
                required: ['rumusan', 'bloom'],
                additionalProperties: false,
              },
            },
          },
          required: ['tps'],
          additionalProperties: false,
        },
      },
    },
    required: ['perElemen'],
    additionalProperties: false,
  };
}

function normalizeCpElemen(cp) {
  const elemen = (cp && Array.isArray(cp.elemen)) ? cp.elemen : [];
  return elemen.slice(0, 12).map((e) => ({
    nama: clampStr(e && e.nama, 200),
    teks: clampStr(e && e.teks, 3000),
  })).filter((e) => e.nama || e.teks);
}

async function generateTp(body, res) {
  const elemen = normalizeCpElemen(body.cp);
  if (!elemen.length) return res.status(400).json({ error: 'CP (elemen) wajib diisi.' });
  const kelas = [7, 8, 9].includes(Number(body.kelas)) ? Number(body.kelas) : 7;
  const mapel = clampStr(body.mapel, 200) || '(tidak disebutkan)';

  const userPrompt = `Mata Pelajaran: ${mapel}\nKelas: ${kelas} (Fase D)\n\n` +
    `Pecah SETIAP elemen CP berikut menjadi TP (dalam urutan yang sama):\n\n` +
    elemen.map((e, i) => `--- Elemen ${i + 1}: "${e.nama}" ---\n${e.teks}`).join('\n\n');

  const requestBody = {
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: 'text', text: TP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
    output_config: { format: { type: 'json_schema', schema: tpSchema(elemen.length) } },
  };

  let message;
  try {
    message = await callModel(requestBody);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
  }
  if (message.stop_reason === 'refusal') {
    return res.status(502).json({ error: 'AI menolak permintaan ini. Coba lagi.' });
  }
  const data = extractJsonObject(textOf(message));
  if (!data || !Array.isArray(data.perElemen)) {
    return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
  }

  await logGen(body.planId, 'generate_tp', message);
  return res.status(200).json({ ok: true, fallback: (message && message._fb) || undefined, perElemen: data.perElemen });
}

// ---- TAHAP 2 — KKTP (SOP §6.2 pohon keputusan) -----------------------------
const KKTP_SYSTEM_PROMPT = `Anda adalah asisten kurikulum Kurikulum Merdeka untuk sekolah Fase D, mengikuti SOP §6 — Menyusun KKTP (Kriteria Ketercapaian Tujuan Pembelajaran). Tugas Anda: untuk SETIAP TP (Tujuan Pembelajaran) yang diberikan, tentukan metode KKTP dan rumuskan kriterianya.

POHON KEPUTUSAN METODE KKTP (SOP §6.2 — ikuti persis, per TP):
Langkah 1. Baca kata kerja operasional dan bentuk TP tersebut.
Langkah 2. JIKA TP bersifat kualitatif holistik/tunggal (mis. sikap, satu produk kreatif utuh yang dinilai sebagai satu kesatuan) → gunakan metode "Deskripsi".
Langkah 3. JIKA TIDAK, dan TP memiliki lebih dari satu aspek/dimensi yang dinilai terpisah (mis. isi + struktur + kosakata dalam satu tulisan) → gunakan metode "Rubrik".
Langkah 4. JIKA TIDAK, dan capaian TP mudah dikuantifikasi langsung (skor tes, jumlah jawaban benar, persentase) → gunakan metode "Interval".

FORMAT PER METODE:
- Deskripsi: kriteria berupa satu-dua kalimat naratif yang menjelaskan bukti konkret bahwa TP tercapai (bukan angka). Contoh (TP "menulis definisi sederhana konsep sains dalam bahasa Inggris"): "Kalimat sesuai struktur dasar subject-verb, kosakata sains tepat, ejaan benar." (tingkat "Sudah memenuhi kriteria").
- Rubrik: kriteria menyebutkan aspek-aspek yang dinilai terpisah (mis. "Aspek dinilai: kosakata sains, struktur kalimat, kejelasan penjelasan proses — skala Belum Muncul/Muncul Sebagian Kecil/Muncul Sebagian Besar/Terlihat Keseluruhan per aspek.").
- Interval: kriteria menyebutkan rentang skor & predikat memakai tabel default berikut kecuali ada alasan kuat untuk berbeda:
${INTERVAL_DEFAULT.map((r) => `  ${r.min ?? 0}-${r.max}: ${r.label}`).join('\n')}
  KKTP (skor tuntas minimum) = ${KKTP_THRESHOLD_DEFAULT} kecuali disebutkan lain. Sebutkan APA yang diukur secara spesifik (mis. "≥80% istilah teridentifikasi benar pada tes identifikasi kosakata").

INSTRUMEN: untuk setiap TP, sebutkan singkat instrumen asesmen yang sesuai (mis. "Tes tulis pilihan ganda", "Rubrik penilaian presentasi", "Lembar observasi", "Vocabulary Recognition Test") — instrumen harus selaras dengan metode KKTP yang dipilih (Interval → instrumen terukur seperti tes/kuis; Rubrik/Deskripsi → instrumen observasi/penilaian produk).

Anda akan menerima BEBERAPA TP sekaligus (dalam urutan yang diberikan) — kembalikan hasil untuk SETIAP TP tersebut, dalam urutan yang SAMA PERSIS (TP pertama di pesan = hasil pertama di keluaran array, dst.).

Kembalikan HANYA data sesuai skema JSON yang diminta — tidak ada teks lain.`;

function kktpSchema(n) {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            metode: { type: 'string', enum: ['Deskripsi', 'Rubrik', 'Interval'] },
            kriteria: { type: 'string' },
            instrumen: { type: 'string' },
          },
          required: ['metode', 'kriteria', 'instrumen'],
          additionalProperties: false,
        },
      },
    },
    required: ['items'],
    additionalProperties: false,
  };
}

function normalizeTpList(tps) {
  return (Array.isArray(tps) ? tps : []).slice(0, 60).map((t) => ({
    kode: clampStr(t && t.kode, 40),
    elemen: clampStr(t && t.elemen, 200),
    rumusan: clampStr(t && t.rumusan, 400),
  })).filter((t) => t.kode);
}

async function generateKktp(body, res) {
  const tps = normalizeTpList(body.tps);
  if (!tps.length) return res.status(400).json({ error: 'Daftar TP wajib diisi.' });

  const userPrompt = `Tentukan metode, kriteria, dan instrumen KKTP untuk setiap TP berikut (dalam urutan yang sama):\n\n` +
    tps.map((t, i) => `${i + 1}. [${t.kode}] (${t.elemen}) ${t.rumusan}`).join('\n');

  const requestBody = {
    model: MODEL,
    max_tokens: 4000,
    system: [{ type: 'text', text: KKTP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
    output_config: { format: { type: 'json_schema', schema: kktpSchema(tps.length) } },
  };

  let message;
  try {
    message = await callModel(requestBody);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
  }
  if (message.stop_reason === 'refusal') {
    return res.status(502).json({ error: 'AI menolak permintaan ini. Coba lagi.' });
  }
  const data = extractJsonObject(textOf(message));
  if (!data || !Array.isArray(data.items)) {
    return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
  }

  await logGen(body.planId, 'generate_kktp', message);
  return res.status(200).json({ ok: true, fallback: (message && message._fb) || undefined, items: data.items });
}

// ---- TAHAP 3 — ATP (SOP §7.2 pengelompokan + urutan prasyarat) ------------
const ATP_SYSTEM_PROMPT = `Anda adalah asisten kurikulum Kurikulum Merdeka untuk sekolah Fase D, mengikuti SOP §7 — Menyusun ATP (Alur Tujuan Pembelajaran). Tugas Anda: mengurutkan dan mengelompokkan seluruh TP (Tujuan Pembelajaran) yang diberikan menjadi unit/topik pembelajaran. Perhitungan JP (jam pelajaran) TIDAK dilakukan oleh Anda — itu dihitung oleh kode deterministik setelah Anda mengelompokkan; tugas Anda HANYA pengelompokan, urutan, dan bobot kompleksitas relatif.

ALGORITMA (SOP §7.2, Langkah 1-4 — Langkah 5-8 dilakukan kode setelah ini):
Langkah 1. Anda menerima SELURUH TP berkode lintas elemen untuk kelas ini.
Langkah 2. Analisis prasyarat (prerequisite mapping): untuk setiap TP, pertimbangkan TP lain mana yang idealnya sudah dikuasai lebih dulu (mis. TP tentang "menjelaskan heat transfer" mensyaratkan TP tentang "membedakan states of matter").
Langkah 3. Urutkan TP mengikuti DUA prinsip sekaligus: (a) logis — TP prasyarat selalu ditempatkan sebelum TP lanjutannya; (b) psikologis — konsep konkret/sederhana sebelum konsep abstrak/kompleks, tingkat kesulitan meningkat bertahap.
Langkah 4. Kelompokkan TP yang berurutan dan bertema sama menjadi SATU unit/topik pembelajaran — SETIAP unit berisi 3-5 TP (jangan kurang dari 3 kecuali sisa TP yang tersedia memang tidak cukup, jangan lebih dari 5).

ATURAN WAJIB — SETIAP TP HARUS DIPAKAI PERSIS SATU KALI:
- SETIAP kode TP yang diberikan WAJIB muncul di TEPAT SATU unit dalam keluaran Anda — tidak boleh ada TP yang tidak dipakai sama sekali (under-coverage), dan tidak boleh ada TP yang dipakai di lebih dari satu unit (duplikasi). Ini akan diverifikasi otomatis oleh kode — jika gagal, Anda akan diminta mengulang.
- JANGAN mengarang kode TP baru — HANYA gunakan kode TP yang benar-benar diberikan di pesan pengguna, disalin persis (case-sensitive, termasuk tanda titik).

BOBOT KOMPLEKSITAS (bobot, skala 0.7-1.3): berikan tiap unit sebuah bobot mencerminkan kompleksitas relatifnya — unit dengan lebih banyak TP atau konten yang secara kognitif lebih berat (level Bloom lebih tinggi, konsep baru yang rumit) mendapat bobot > 1 (hingga 1.3); unit yang lebih ringan/pengantar mendapat bobot < 1 (turun hingga 0.7). Unit dengan kompleksitas rata-rata mendapat bobot mendekati 1.0. Bobot ini akan dikalikan dengan alokasi JP dasar oleh kode — jangan menghitung JP sendiri, cukup berikan bobot relatifnya.

PEMBAGIAN SEMESTER: bagi seluruh unit ke Semester 1 (Ganjil) atau Semester 2 (Genap) secara URUT (unit-unit awal/prasyarat masuk semester 1) dan JUMLAH TP di kedua semester diusahakan SEIMBANG (mendekati 50/50) kecuali jumlah TP ganjil membuatnya sedikit tidak imbang — jangan menaruh mayoritas TP di satu semester saja.

PENAMAAN UNIT: beri nama singkat & deskriptif (2-6 kata) yang mencerminkan topik/tema TP-TP di dalamnya (mis. "Heat and Temperature", "Ekosistem dan Interaksi Makhluk Hidup") — bukan nama generik seperti "Unit 1".

Kembalikan HANYA data sesuai skema JSON yang diminta — tidak ada teks lain, tidak ada penjelasan.`;

function atpSchema(allTpKodes) {
  return {
    type: 'object',
    properties: {
      units: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            nama: { type: 'string' },
            tpKodes: { type: 'array', items: { type: 'string', enum: allTpKodes } },
            bobot: { type: 'number' },
            semester: { type: 'integer', enum: [1, 2] },
          },
          required: ['nama', 'tpKodes', 'bobot', 'semester'],
          additionalProperties: false,
        },
      },
    },
    required: ['units'],
    additionalProperties: false,
  };
}

async function generateAtp(body, res) {
  const tps = normalizeTpList(body.tps);
  if (tps.length < 2) return res.status(400).json({ error: 'Minimal 2 TP diperlukan untuk menyusun ATP.' });
  const mapel = clampStr(body.mapel, 200) || '(tidak disebutkan)';
  const kelas = [7, 8, 9].includes(Number(body.kelas)) ? Number(body.kelas) : 7;
  const nUnitsHint = Number(body.nUnitsHint) > 0 ? Math.round(Number(body.nUnitsHint)) : Math.max(1, Math.round(tps.length / 4));

  // atp.js (client) retries once on client-side coverage-validation failure
  // (pipeline.buildUnits errors) by resending this same action with
  // retryFeedback filled in — the plan's "reject+retry once, else surface".
  const retryFeedback = clampStr(body.retryFeedback, 1000);
  const retryNote = retryFeedback
    ? `\n\nPERCOBAAN SEBELUMNYA GAGAL VALIDASI — perbaiki ini: ${retryFeedback}\nPastikan kali ini SETIAP kode TP di bawah muncul di TEPAT SATU unit, tidak kurang tidak lebih.`
    : '';

  const userPrompt = `Mata Pelajaran: ${mapel}\nKelas: ${kelas} (Fase D)\nPerkiraan jumlah unit yang wajar: sekitar ${nUnitsHint} unit (boleh berbeda 1-2 jika pengelompokan TP lebih masuk akal dengan jumlah lain).\n\n` +
    `Seluruh TP yang HARUS dikelompokkan (setiap kode WAJIB dipakai tepat sekali):\n` +
    tps.map((t) => `${t.kode} [${t.elemen}]: ${t.rumusan}`).join('\n') +
    retryNote;

  const requestBody = {
    model: MODEL,
    max_tokens: 3000,
    system: [{ type: 'text', text: ATP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
    output_config: { format: { type: 'json_schema', schema: atpSchema(tps.map((t) => t.kode)) } },
  };

  let message;
  try {
    message = await callModel(requestBody);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
  }
  if (message.stop_reason === 'refusal') {
    return res.status(502).json({ error: 'AI menolak permintaan ini. Coba lagi.' });
  }
  const data = extractJsonObject(textOf(message));
  if (!data || !Array.isArray(data.units)) {
    return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
  }

  await logGen(body.planId, 'generate_atp', message);
  return res.status(200).json({ ok: true, fallback: (message && message._fb) || undefined, units: data.units });
}

// ---- Mulok — draft capaian kontekstual (clearly badged as a KOSP draft) ---
const MULOK_SYSTEM_PROMPT = `Anda membantu menyusun DRAF Capaian Pembelajaran (CP) kontekstual untuk mata pelajaran Muatan Lokal/kekhasan satuan pendidikan (bukan CP nasional resmi). Draf ini WAJIB disahkan lewat KOSP sekolah sebelum dipakai resmi — Anda hanya membuat draf awal untuk mempercepat kerja tim kurikulum, BUKAN dokumen final.

Berdasarkan garis besar topik/tujuan mata pelajaran mulok yang diberikan pengguna, susun 2-4 elemen capaian (mengikuti pola CP nasional: tiap elemen punya nama singkat + satu paragraf capaian akhir fase). Pola kalimat: "Pada akhir Fase D, peserta didik [kemampuan inti] ... [konteks/keterampilan pendukung]." — satu paragraf padat per elemen (3-5 kalimat), bukan daftar poin.

Kembalikan HANYA data sesuai skema JSON yang diminta — tidak ada teks lain, tidak ada disclaimer di dalam field (disclaimer ditampilkan oleh aplikasi, bukan oleh Anda).`;

function mulokSchema() {
  return {
    type: 'object',
    properties: {
      elemen: {
        type: 'array',
        items: {
          type: 'object',
          properties: { nama: { type: 'string' }, teks: { type: 'string' } },
          required: ['nama', 'teks'],
          additionalProperties: false,
        },
      },
    },
    required: ['elemen'],
    additionalProperties: false,
  };
}

async function draftCapaianMulok(body, res) {
  const topikOutline = clampStr(body.topikOutline, 2000);
  if (!topikOutline) return res.status(400).json({ error: 'Garis besar topik/tujuan mapel wajib diisi.' });
  const mapel = clampStr(body.mapel, 200) || '(mata pelajaran muatan lokal)';

  const userPrompt = `Mata Pelajaran Muatan Lokal: ${mapel}\n\nGaris besar topik/tujuan yang ingin dicapai (dari guru):\n${topikOutline}`;

  const requestBody = {
    model: MODEL,
    max_tokens: 2000,
    system: [{ type: 'text', text: MULOK_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userPrompt }],
    output_config: { format: { type: 'json_schema', schema: mulokSchema() } },
  };

  let message;
  try {
    message = await callModel(requestBody);
  } catch (e) {
    return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
  }
  if (message.stop_reason === 'refusal') {
    return res.status(502).json({ error: 'AI menolak permintaan ini. Coba lagi.' });
  }
  const data = extractJsonObject(textOf(message));
  if (!data || !Array.isArray(data.elemen)) {
    return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
  }

  await logGen(body.planId, 'draft_capaian_mulok', message);
  return res.status(200).json({ ok: true, fallback: (message && message._fb) || undefined, elemen: data.elemen });
}

// ---- per-row regenerate (TP row / KKTP row) — sibling to regenerate_field -
async function regenerateItem(body, res) {
  const target = body.target;
  const ctx = body.context && typeof body.context === 'object' ? body.context : {};

  if (target === 'tp') {
    const userPrompt = `Regenerasi SATU TP saja (bukan seluruh elemen).\n\n` +
      `Elemen CP: "${clampStr(ctx.elemenNama, 200)}"\nTeks CP elemen ini (verbatim, acuan saja):\n${clampStr(ctx.elemenTeks, 3000)}\n\n` +
      `TP lain yang SUDAH ada di elemen ini (untuk konteks — buat TP baru yang TIDAK tumpang tindih dengan ini):\n` +
      (Array.isArray(ctx.tpLainnya) ? ctx.tpLainnya.slice(0, 20).map((r) => '- ' + clampStr(r, 300)).join('\n') : '(tidak ada)') +
      `\n\nTP saat ini yang ingin diregenerasi (buat versi BARU yang lebih baik/berbeda):\nRumusan: ${clampStr(body.current && body.current.rumusan, 400)}\nBloom: ${clampStr(body.current && body.current.bloom, 10)}\n\n` +
      `Kembalikan HANYA objek JSON {"rumusan": "...", "bloom": "C1".."C6"}.`;

    const requestBody = {
      model: MODEL,
      max_tokens: 600,
      system: [{ type: 'text', text: TP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: { rumusan: { type: 'string' }, bloom: { type: 'string', enum: BLOOM_LEVELS } },
            required: ['rumusan', 'bloom'],
            additionalProperties: false,
          },
        },
      },
    };
    let message;
    try { message = await callModel(requestBody); } catch (e) {
      return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
    }
    const data = extractJsonObject(textOf(message));
    if (!data) return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
    await logGen(body.planId, 'regenerate_item_tp', message);
    return res.status(200).json({ ok: true, fallback: (message && message._fb) || undefined, target, value: data });
  }

  if (target === 'kktp') {
    const userPrompt = `Regenerasi SATU KKTP saja.\n\nTP: [${clampStr(ctx.tpKode, 40)}] ${clampStr(ctx.tpRumusan, 400)}\n\n` +
      `KKTP saat ini yang ingin diregenerasi (buat versi BARU yang lebih baik/berbeda):\nMetode: ${clampStr(body.current && body.current.metode, 20)}\nKriteria: ${clampStr(body.current && body.current.kriteria, 500)}\n\n` +
      `Kembalikan HANYA objek JSON {"metode": "Deskripsi"|"Rubrik"|"Interval", "kriteria": "...", "instrumen": "..."}.`;

    const requestBody = {
      model: MODEL,
      max_tokens: 600,
      system: [{ type: 'text', text: KKTP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              metode: { type: 'string', enum: ['Deskripsi', 'Rubrik', 'Interval'] },
              kriteria: { type: 'string' },
              instrumen: { type: 'string' },
            },
            required: ['metode', 'kriteria', 'instrumen'],
            additionalProperties: false,
          },
        },
      },
    };
    let message;
    try { message = await callModel(requestBody); } catch (e) {
      return res.status(502).json({ error: 'Gagal menghubungi AI: ' + String((e && e.message) || e) });
    }
    const data = extractJsonObject(textOf(message));
    if (!data) return res.status(502).json({ error: 'AI mengirim respons yang tidak bisa dibaca. Coba lagi.' });
    await logGen(body.planId, 'regenerate_item_kktp', message);
    return res.status(200).json({ ok: true, fallback: (message && message._fb) || undefined, target, value: data });
  }

  return res.status(400).json({ error: 'target tidak dikenal (gunakan "tp" atau "kktp").' });
}

// ---- entry point ------------------------------------------------------------
module.exports = async (req, res) => {
  try {
    requestStartMs = Date.now(); // anchor the OpenRouter fallback wall-clock budget
    cachedAiConfig = null;       // V2c: force a fresh ai_config read for this invocation
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    let approxBytes = 0;
    try { approxBytes = Buffer.byteLength(JSON.stringify(body)); } catch (e) { approxBytes = 0; }
    if (approxBytes > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Permintaan terlalu besar.' });
    }

    // V2c: no more hard upfront requirement for ANTHROPIC_API_KEY — an
    // admin-configured stored key (BYOK) can substitute. If NEITHER is
    // configured, callModel()/streamClaude() below surface a clear error
    // per-action instead of a blanket 500 here.
    if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({
        error: 'Server belum disiapkan — tambahkan SUPABASE_SERVICE_ROLE_KEY di Vercel → Settings → Environment Variables, lalu redeploy.',
      });
    }

    const gate = await verifyPass(body.pass);
    if (gate === 'config') return res.status(500).json({ error: CONFIG_ERROR, detail: lastConfigError });
    if (gate !== 'ok') return res.status(401).json({ error: 'Kode akses salah.' });

    // Optional per-request provider override ('anthropic' | 'openrouter').
    // Passcode-gated like everything else; used for testing the fallback
    // path and as a manual free-mode escape hatch.
    forceProvider = (body.provider === 'openrouter' || body.provider === 'anthropic') ? body.provider : null;

    switch (body.action) {
      case 'generate_rpp_base':     return await generateRppBase(body, res);
      case 'generate_rpp_meeting':  return await generateRppMeeting(body, res);
      case 'generate_rpp':          return await generateRpp(body, res);
      case 'regenerate_field':      return await regenerateField(body, res);
      case 'generate_tp':           return await generateTp(body, res);
      case 'generate_kktp':         return await generateKktp(body, res);
      case 'generate_atp':          return await generateAtp(body, res);
      case 'draft_capaian_mulok':   return await draftCapaianMulok(body, res);
      case 'regenerate_item':       return await regenerateItem(body, res);
      default:
        return res.status(400).json({ error: 'Aksi tidak dikenal.' });
    }
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
