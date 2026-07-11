# Status mapel di luar 6 prioritas M0

M0 mewajibkan verbatim CP Fase D untuk 6 mapel: Bahasa Indonesia, Matematika, IPA, IPS,
Bahasa Inggris, Pendidikan Pancasila — **semuanya sudah berhasil ditranskripsi** ke
`data/cp/*.json` (lihat README.md). ESP kontekstual juga sudah selesai
(`data/cp/esp_kontekstual.json`).

M5 menyelesaikan rollout seluruh mapel yang tersisa. **Status: SEMUA mapel yang
tercantum di `NEEDS_SOURCE.md` M0 sudah berhasil ditranskripsi verbatim** — tidak ada
item yang genuinely-missing tersisa dari daftar M0. Rincian di bawah.

Sumber untuk semua mapel di bawah: **sama seperti 6 mapel yang sudah selesai** —
Keputusan Kepala BSKAP Kemendikdasmen No. 046/H/KR/2025.

## PERUBAHAN LOKASI FILE SUMBER SEJAK M0 (penting untuk verifikasi)

Folder sumber telah direorganisasi oleh pemilik sejak M0. Path yang dicatat di M0
(`E:\Claude Cowork\SMPI AHA\Perangkat Pembelajaran\8. Misc\...`) **sudah tidak ada** —
folder `Perangkat Pembelajaran` sekarang berupa arsip `.7z` terkompresi. File PDF yang
sama kini hidup di path baru (dikonfirmasi ada, 1691 halaman, watermark cocok):

```
E:\Claude Cowork\SMPI AHA\Mr. D\8. Misc\uncategorized\School & Exam Admin\Landasan Yuridis\Kepka_BSKAP_No_01k17e8396ajn15j3hcw0k773b_copy.pdf
```

Semua 12 file `cp/*.json` baru pada M5 mengutip path BARU ini di `sumberLocalFile`.
**File `cp/*.json` lama dari M0** (bahasa-indonesia, matematika, ipa, ips,
bahasa-inggris, pendidikan-pancasila) **masih mengutip path lama** yang sekarang tidak
ada — nomor halaman yang dicatat di sana tetap valid (halaman PDF tidak berubah), tapi
pemilik perlu membuka file di path BARU di atas saat spot-check, bukan path yang
tertulis di file tersebut. Lihat item verifikasi di README.md.

## Mapel yang berhasil ditranskripsi pada M5

| Mapel | Bagian dokumen | PDF hal. (Fase D) | File |
|---|---|---|---|
| Pendidikan Agama Islam dan Budi Pekerti (redaksi Islam) | I.1 | 28-29 | `cp/pai.json` |
| Informatika | XI | 182-183 | `cp/informatika.json` |
| Seni Musik | XVIII.1 | 241 | `cp/seni-musik.json` |
| Seni Rupa | XVIII.2 | 248-249 | `cp/seni-rupa.json` |
| Seni Tari | XVIII.3 | 258-259 | `cp/seni-tari.json` |
| Seni Teater | XVIII.4 | 266-267 | `cp/seni-teater.json` |
| Prakarya Budi Daya | XIX.1 | 272 | `cp/prakarya-budidaya.json` |
| Prakarya Kerajinan | XIX.2 | 277 | `cp/prakarya-kerajinan.json` |
| Prakarya Pengolahan | XIX.3 | 281 | `cp/prakarya-pengolahan.json` |
| Prakarya Rekayasa | XIX.4 | 285-286 | `cp/prakarya-rekayasa.json` |
| Pendidikan Jasmani, Olahraga, dan Kesehatan (PJOK) | XXI | 313-314 | `cp/pjok.json` |
| Koding dan Kecerdasan Artifisial | XXVIII | 344 | `cp/koding-ai.json` |

Semua 12 file di atas sudah dihubungkan dari `mapel.json` (`cpFile`) dan
tervalidasi sebagai JSON yang sah.

## Catatan struktural yang ditemukan saat transkripsi (bukan kegagalan sumber)

- **Informatika Fase D hanya mencakup 2 dari 4 elemen resmi mapel ini** (Berpikir
  Komputasional, Literasi Digital) — elemen Analisis Data dan Algoritma dan
  Pemrograman baru muncul pada Fase F (SMA kelas XI-XII). Ini diverifikasi langsung
  dari struktur dokumen (Fase D dan E sama-sama hanya 2 elemen; Fase F menambahkan
  2 elemen lagi), bukan kesalahan ekstraksi PDF.
- **Koding dan Kecerdasan Artifisial MEMANG memiliki Fase D** di dokumen ini
  (Bagian XXVIII, PDF hal. 344, butir 2.1-2.4) — pertanyaan M0 soal "apakah Fase D
  ada untuk mapel ini" terjawab: ADA, sudah ditranskripsi.
  ​Bagian XXVIII "hanya" ~338 di estimasi M0 vs 344 aktual untuk Fase D — dalam
  rentang perkiraan, hanya offset karena bagian A-C (rasional/tujuan/karakteristik)
  memakan beberapa halaman sebelum tabel Capaian Pembelajaran per fase dimulai.
- **Prakarya memang berlaku di Fase D** (dikonfirmasi eksplisit di teks dokumen:
  "Mata Pelajaran Prakarya terdiri dari empat aspek berdasarkan jenis keterampilan
  yaitu kerajinan, rekayasa, budi daya, dan pengolahan") dan berkedudukan sebagai
  ALTERNATIF terhadap Seni Budaya pada slot JP yang sama (nama asli slot di
  Permendikdasmen 13/2025: "Seni, Budaya, dan Prakarya") — karena itu kedelapan
  varian (4 Seni + 4 Prakarya) dimodelkan sebagai entri `mapel.json` terpisah,
  bukan hanya 4 varian Seni.
- Prakarya Kerajinan butir 1.4 (Evaluasi dan Refleksi) memiliki redaksi asli yang
  sedikit janggal ("Pada akhir fase D, murid mampu merefleksikan...", mengulang
  frasa fase di dalam butirnya sendiri) — dipertahankan verbatim, dicatat di
  `cp/prakarya-kerajinan.json`.
- Prakarya Rekayasa memiliki varian lanjutan terpisah "Prakarya dan Kewirausahaan
  Rekayasa" untuk Fase F (SMK), di luar cakupan Fase D — tidak ditranskripsi
  (tidak relevan untuk kurikulum SMP).

## Tidak ada item genuinely-missing tersisa

Tidak ada mapel dari daftar asli M0 yang gagal ditemukan di dokumen. Jika ke depannya
ditemukan mapel Fase D lain yang perlu ditranskripsi, catat page range perkiraan di
sini dulu sebelum transkripsi (pola yang sama dipakai M0 → M5).
