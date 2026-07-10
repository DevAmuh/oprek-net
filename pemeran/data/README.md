# Pemeran — data/ (M0: curriculum data prep)

This directory holds the "burned-in" curriculum data the Pemeran wizard reads at
runtime: constants, the Fase D subject/JP table, and verbatim Capaian Pembelajaran
(CP) per mapel. Nothing here is AI-generated — every number and every CP sentence
is either transcribed from an official document or specified directly in the plan.

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
  ESP numbers (72/72/64). 6 of 12 wajib mapel have `cpFile` pointing into `cp/`;
  the remaining 5 (Agama Islam, PJOK, Informatika, Seni Budaya, Koding & AI) plus
  the "Muatan Lokal lainnya" placeholder are flagged `cpFile: null` with a reason —
  see `NEEDS_SOURCE.md`.

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
  Verbatim Fase D CP for the 6 mandated subjects. Source: **Keputusan Kepala
  BSKAP Kemendikdasmen No. 046/H/KR/2025**, local PDF copy at
  `E:\Claude Cowork\SMPI AHA\Perangkat Pembelajaran\8. Misc\uncategorized\School & Exam Admin\Landasan Yuridis\Kepka_BSKAP_No_01k17e8396ajn15j3hcw0k773b_copy.pdf`
  (1691 pages, watermarked `jdih.kemendikdasmen.go.id`). The portal
  (guru.kemendikdasmen.go.id) was not scraped — the owner already had the exact
  gazetted PDF on disk, which is a stronger source than a portal summary. Each
  file cites the exact PDF page range in `sumberLocalFile`. Text extraction used
  PyMuPDF (`fitz`) — plain `pypdf` produced garbled word-per-line output on this
  particular PDF and was abandoned after a first failed attempt.

- **`NEEDS_SOURCE.md`** — The 5 remaining wajib mapel (Agama Islam, PJOK,
  Informatika, Seni Budaya, Koding & AI) are out of M0's 6-subject scope, not a
  fetch failure. Their section/page locations in the same 046/H/KR/2025 PDF are
  already recorded there so M5 doesn't need to re-search.

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

- [ ] **Spot-check 2-3 CP files against the source PDF directly** (open
      `Kepka_BSKAP_No_01k17e8396ajn15j3hcw0k773b_copy.pdf` at the page numbers
      cited in each `cp/*.json`'s `sumberLocalFile`, e.g. Matematika = PDF hal.
      116-118) — confirm every sentence matches character-for-character. This is
      the highest-risk step: verbatim transcription errors would silently corrupt
      every downstream TP/KKTP/ATP/RPP for that subject.
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
- [ ] **Decide the 5 deferred mapel's scope for M5** (Agama Islam, PJOK,
      Informatika, Seni Budaya, Koding & AI) — in particular, which single Seni
      and Prakarya variant the school actually teaches (the source document lists
      4 Seni options and 4 Prakarya options as alternatives, only 1 of which
      should be locked into that subject's `cp/*.json`).
- [ ] **Confirm "Muatan Lokal lainnya" is actually needed** — right now it's a
      placeholder with `jpPerTahun: null`; if the school's only mulok is ESP,
      this entry can be deleted.
