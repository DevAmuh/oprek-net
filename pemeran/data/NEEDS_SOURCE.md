# Mapel yang belum ditranskripsi (di luar scope M0)

M0 mewajibkan verbatim CP Fase D untuk 6 mapel: Bahasa Indonesia, Matematika, IPA, IPS,
Bahasa Inggris, Pendidikan Pancasila — **semuanya sudah berhasil ditranskripsi** ke
`data/cp/*.json` (lihat README.md). ESP kontekstual juga sudah selesai
(`data/cp/esp_kontekstual.json`).

Mapel di bawah ini ADA di `mapel.json` (untuk struktur JP) tetapi **belum** punya file
`data/cp/<mapel>.json` karena berada di luar 6 mapel prioritas M0. Ini bukan kegagalan
fetch — sumbernya sudah ditemukan dan lokasinya dicatat di bawah supaya M5 (rollout
semua mapel) tidak perlu mencari ulang.

Sumber untuk semua mapel di bawah: **sama seperti 6 mapel yang sudah selesai** —
Keputusan Kepala BSKAP Kemendikdasmen No. 046/H/KR/2025, file lokal:

```
E:\Claude Cowork\SMPI AHA\Perangkat Pembelajaran\8. Misc\uncategorized\School & Exam Admin\Landasan Yuridis\Kepka_BSKAP_No_01k17e8396ajn15j3hcw0k773b_copy.pdf
(1691 halaman, watermark jdih.kemendikdasmen.go.id — cocok dengan dokumen resmi)
```

| Mapel | Bagian dokumen | PDF hal. (perkiraan awal seksi) |
|---|---|---|
| Pendidikan Agama Islam dan Budi Pekerti | I.1 | ~23 |
| Informatika | XI | ~177 |
| Seni Musik | XVIII.1 | ~234 |
| Seni Rupa | XVIII.2 | ~243 |
| Seni Tari | XVIII.3 | ~250 |
| Seni Teater | XVIII.4 | ~260 |
| Prakarya (Budi Daya/Kerajinan/Pengolahan/Rekayasa) | XIX.1-XIX.4 | ~268+ |
| Pendidikan Jasmani, Olahraga, dan Kesehatan (PJOK) | XXI | ~302 |
| Koding dan Kecerdasan Artifisial | XXVIII | ~338 |

**Cara mengerjakan saat M5**: dalam setiap seksi, cari heading "D. Capaian Pembelajaran"
lalu subbagian "Fase D (Umumnya untuk Kelas VII, VIII dan IX SMP/MTs/Program Paket B)" —
salin persis (verbatim, per elemen) sampai sebelum "Fase E" berikutnya. Ekstraksi teks
PDF dengan `pypdf` menghasilkan teks acak kata-per-baris (tidak terpakai); gunakan
**PyMuPDF (`fitz`)** `page.get_text()` yang menghasilkan teks bersih dan siap transkrip
langsung (metode ini yang dipakai untuk 6 mapel yang sudah selesai).

Catatan tambahan:
- Untuk PJOK/Seni/Prakarya, dokumen sering punya beberapa varian pilihan (mis. 4 jenis
  seni, 4 jenis prakarya) — sekolah perlu menentukan 1 jenis yang benar-benar diajarkan
  sebelum CP-nya di-lock ke `data/cp/`.
- Pendidikan Agama Islam: sekolah (SMPI Al-Hamidiyah) hanya butuh redaksi Islam, bukan
  agama lain — cukup transkrip I.1 saja.
