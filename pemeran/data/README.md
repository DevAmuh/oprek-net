# Pemeran — data/ (M0 + M5: curriculum data prep)

This directory holds the "burned-in" curriculum data the Pemeran wizard reads at
runtime: constants, the Fase D subject/JP table, and verbatim Capaian Pembelajaran
(CP) per mapel. Nothing here is AI-generated — every number and every CP sentence
is either transcribed from an official document or specified directly in the plan.

M0 covered 6 priority mapel; M5 (this pass) rolled out verbatim CP for every
remaining Fase D mapel — Pendidikan Agama Islam dan Budi Pekerti (PAI), PJOK,
Informatika, Koding dan Kecerdasan Artifisial, all 4 Seni Budaya variants, and all
4 Prakarya variants — 12 new `cp/*.json` files in total, all linked from
`mapel.json`.

## Files

- **`konstanta.json`** — Fixed reference tables used across all documents: the 8
  Dimensi Profil Lulusan (Permendikdasmen 13/2025), the 5 SANTRI KITAB values, the
  Bloom C1-C6 verb lists (SOP Lampiran 14.1), the default nilai interval table +
  KKTP threshold (78), default sumatif JP allocation (STS1/SAS/STS2/SAT), and
  default effective-weeks-per-semester. Source: school SOP + Permendikdasmen
  13/2025 (8 dimensi cross-checked against a web search independent of the local
  PDF — wording matches exactly).

- **`mapel.json`** — Full Fase D (SMP kelas 7-9) subject list with yearly JP
  (jam pelajaran) allocation per kelas. Source: Permendikdasmen No. 13 Tahun 2025
  Lampiran II, Tabel 6 (kelas VII-VIII) and Tabel 7 (kelas IX) — read directly from
  the official PDF (local copy, watermarked `jdih.kemendikdasmen.go.id`, filename
  matched byte-for-byte against the canonical URL found via web search). `jpPerTahun`
  uses the **Intrakurikuler** column (not the Kokurikuler-inclusive Total), a
  convention chosen because it's the only one that reproduces the school-confirmed
  ESP numbers (72/72/64). As of M5, every wajib/pilihan mapel entry has a `cpFile`
  pointing into `cp/` (M0 left 5 as `cpFile: null`; M5 filled all of them in,
  including replacing the single `seni-budaya-prakarya` placeholder with 8 separate
  entries — one per Seni/Prakarya variant, since the school teaches only one and
  the source document treats Prakarya as an alternative to Seni Budaya for the same
  JP slot). Only `mulok-lain` (a placeholder for an optional extra mulok the school
  may or may not use) still has `jpPerTahun: null`.

- **`cp/esp_kontekstual.json`** — The school's own ESP (English for Specific
  Purposes) mulok capaian, transcribed verbatim (Indonesian + English) from
  `CP B. Inggris.txt` in the school's Landasan Yuridis folder. **Important**: this
  is a 3-elemen redaksi (Menyimak-Berbicara / Membaca-Memirsa / Menulis-
  Mempresentasikan) that reads differently from the current national Bahasa
  Inggris CP (`cp/bahasa-inggris.json`) — it appears to predate 046/H/KR/2025
  (likely the 2022-era CP). It is recorded as-is per instructions, `redaksi:
  "kontekstual"`, since it's what the school's KOSP has actually sanctioned for
  the ESP mulok slot.

- **`cp/bahasa-indonesia.json`, `cp/matematika.json`, `cp/ipa.json`,
  `cp/ips.json`, `cp/bahasa-inggris.json`, `cp/pendidikan-pancasila.json`** —
  Verbatim Fase D CP for the 6 mandated subjects transcribed in M0. Source:
  **Keputusan Kepala BSKAP Kemendikdasmen No. 046/H/KR/2025**, local PDF copy.
  **Their `sumberLocalFile` still cites the M0-era path**
  (`E:\Claude Cowork\SMPI AHA\Perangkat Pembelajaran\8. Misc\...`), which **no
  longer exists** — that folder is now a `.7z` archive. See the "PERUBAHAN LOKASI
  FILE SUMBER" note in `NEEDS_SOURCE.md` for the current path; page numbers cited
  in these 6 files are still valid, only the folder location changed.

- **`cp/pai.json`, `cp/pjok.json`, `cp/informatika.json`, `cp/koding-ai.json`,
  `cp/seni-musik.json`, `cp/seni-rupa.json`, `cp/seni-teater.json`,
  `cp/seni-tari.json`, `cp/prakarya-budidaya.json`, `cp/prakarya-kerajinan.json`,
  `cp/prakarya-pengolahan.json`, `cp/prakarya-rekayasa.json`** — Verbatim Fase D
  CP for every remaining mapel, transcribed in M5 from the same
  **Kepka BSKAP No. 046/H/KR/2025** PDF, using the **current** file path (see
  `NEEDS_SOURCE.md`). Same method as M0: PyMuPDF (`fitz`) text extraction, exact
  PDF page range cited per file in `sumberLocalFile`. Notable findings recorded
  in each file's `catatan`: Informatika's Fase D only defines 2 of the mapel's 4
  elements (Analisis Data / Algoritma dan Pemrograman start at Fase F); Koding
  dan Kecerdasan Artifisial's Fase D CP does exist (M0 had flagged this as
  uncertain); Prakarya is confirmed as a genuine Fase D alternative to Seni
  Budaya for the same JP slot, not a separate mapel.

- **`NEEDS_SOURCE.md`** — Confirms all mapel from the M0 punch list are now
  transcribed; documents the source-folder relocation since M0 and the
  structural findings above in more detail.

## Sources (full citations)

1. Permendikdasmen No. 13 Tahun 2025 (Perubahan atas Permendikbudristek No. 12
   Tahun 2024), Lampiran II — struktur kurikulum & JP.
   `https://jdih.kemendikdasmen.go.id/sjdih/siperpu/dokumen/salinan/Permendikdasmen_No_13_Tahun_2025_ttg_Perubahan_atas_Permendikbudristek_No_12_Tahun_2024_ttg_Kurikulum_pada_Pendidikan_Anak_Usia_Dini_Jenjang_Dikdasmen.pdf`
2. Kepka BSKAP No. 046/H/KR/2025 — Capaian Pembelajaran PAUD/Dikdasmen (all
   subjects, all fases). Local copy only; canonical portal is
   `jdih.kemendikdasmen.go.id` / `guru.kemendikdasmen.go.id`.
3. School file `CP B. Inggris.txt` (ESP kontekstual), provided by the owner.

## OWNER MUST VERIFY (SOP §12.B human checkpoint)

This is the mandatory human spot-check before these files feed the generation
pipeline. Please verify:

- [ ] **Spot-check 2-3 CP files against the source PDF directly**, including at
      least one of the 12 new M5 files (e.g. PAI = PDF hal. 28-29, PJOK = PDF
      hal. 313-314) — open
      `Kepka_BSKAP_No_01k17e8396ajn15j3hcw0k773b_copy.pdf` at the **current**
      path (see `NEEDS_SOURCE.md` — the M0-era path no longer exists) at the
      page numbers cited in each `cp/*.json`'s `sumberLocalFile`, and confirm
      every sentence matches character-for-character. This is the highest-risk
      step: verbatim transcription errors would silently corrupt every
      downstream TP/KKTP/ATP/RPP for that subject.
- [ ] **Confirm `bahasa-inggris.json` vs `esp_kontekstual.json` are meant to
      diverge.** They currently describe Fase D English competency quite
      differently (current national wording vs. an apparently older redaksi the
      school uses for ESP). Confirm this is intentional and that ESP's redaksi is
      still the one the KOSP actually approved — if the school meant to reuse the
      *current* national wording for ESP instead, `esp_kontekstual.json` needs a
      different source file.
- [ ] **Confirm the `jpPerTahun` = Intrakurikuler-only convention in `mapel.json`**
      matches how the school actually schedules JP/minggu (i.e., Kokurikuler hours
      are handled separately from the weekly subject schedule Prosem will
      distribute). If the school actually wants Total JP (Intra+Koku) as the
      pacing basis, every non-mulok number in `mapel.json` needs to change.
- [ ] **Pick the ONE Seni/Prakarya variant the school actually teaches.** All 8
      variants now ship as separate `mapel.json` entries
      (`seni-musik`/`seni-rupa`/`seni-teater`/`seni-tari`/
      `prakarya-budidaya`/`prakarya-kerajinan`/`prakarya-pengolahan`/
      `prakarya-rekayasa`) so the wizard/generator can offer a choice, but the
      school still needs to settle on one for actual lesson-plan generation —
      the other 7 entries should stay unused (or be removed later) once decided.
- [ ] **Confirm "Muatan Lokal lainnya" is actually needed** — right now it's a
      placeholder with `jpPerTahun: null`; if the school's only mulok is ESP,
      this entry can be deleted.
