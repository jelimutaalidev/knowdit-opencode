# KNOWDIT Phase 1 — Historical Knowledge Graph dari dataset Code4rena

Status: draft untuk direview
Tanggal: 2026-11-17
Repo: `knowdit-opencode`
Referensi implementasi: `/home/jey/Dev/knowdit` (Rust, v1.0.1)

---

## 1. Maksud dan kenapa

KNOWDIT bekerja dalam dua fase. Fase 1 menambang **Historical Database**: kumpulan
node `semantic` (mekanisme DeFi yang netral-proyek) dan node `finding` (kerentanan
dari laporan audit), dihubungkan oleh edge yang punya `strength` + `evidence`.
Fase 2 memakai database itu untuk mengaudit proyek baru.

Dokumen ini hanya merancang **Fase 1**. Tujuannya bukan menyalin paper, melainkan
mereplikasi perilaku kode Rust asli — termasuk hal-hal yang berbeda dari paper
(mis. global linking adalah finding→semantic, bukan perkalian Cartesian).

Kenapa sekarang: dataset Code4rena sudah ada di `~/c4-data/out_train` dan sudah
divalidasi. Tanpa KG, tidak ada yang bisa dipakai Fase 2.

## 2. Goals, non-goals, anti-goals

### Goals

- **G1** Menghasilkan snapshot dataset yang reproducible: 12 kontes terpilih,
  report yang sudah dipangkas, source yang sudah difilter, plus manifest + ID map.
- **G2** Menjalankan enam tahap pipeline KNOWDIT dan menulis `kg.sqlite` dengan
  skema 18 tabel yang identik dengan `knowdit-kg-model`.
- **G3** Membuktikan kompatibilitas: binary Rust asli bisa membuka `kg.sqlite`
  dan melaporkan angka yang sama dengan statistik kita.
- **G4** Menyediakan permukaan query di OpenCode (tool) supaya KG bisa dipakai
  tanpa menulis SQL manual.
- **G5** Setiap tahap resumable dan idempoten; hasil LLM di-cache sehingga
  rebuild tidak menagih ulang.
- **G6** Biaya batch pertama terukur dan wajar (lihat §11).

### Non-goals

- Agentic audit loop / pemakaian KG untuk mengaudit proyek baru (Fase 2).
- Scraping Code4rena baru atau ingest C4Audit/Zenodo.
- Kompilasi proyek (`forge build`, `scripts/autobuild.py`). Pipeline learn asli
  juga tidak mengompilasi.
- UI web, dashboard, atau server HTTP terpisah.
- Backend MySQL.

### Anti-goals

- Menghasilkan database yang tidak bisa dibuka binary asli.
- Mengikuti prosa paper ketika kode berperilaku lain.
- Menelan 111 kontes sebelum 12 kontes terbukti bersih.
- Menulis edge tanpa evidence yang bisa diverifikasi secara mekanis.
- Menyembunyikan kegagalan tahap dengan cara melanjutkan diam-diam.

## 3. Input yang sudah diverifikasi

Dataset `~/c4-data/out_train` (4,7 GB) sudah divalidasi ketat:

| Aspek | Bukti |
|---|---|
| Layout | Persis `from_dataset_dir` di `crates/knowdit-project/src/c4.rs`; komentar kode bahkan menyebut direktori `out_train/` |
| Metadata | 111/111 JSON valid, `contestId == nama file`, `title` terisi, tanpa duplikat |
| Report | 100/111; 100/100 berstruktur resmi C4, tidak terpotong, `slug` == `title`, `findings` URL == `<slug>-findings` |
| Findings | 406 High + 936 Medium (heading-level, unik) dari 100 report |
| Provenance | 111/111 remote cocok slug; clone bersih; 4/4 file sampel byte-identical dengan GitHub di SHA HEAD |
| `.sol` | 15.045 file asli; 212 direktori bernama `*.sol` adalah artefak upstream (abigen/typechain/docgen), bukan korupsi |
| Core corpus | 90 kontes punya core `.sol`; 5.829 file setelah exclude; 919.082 LOC |

Keputusan yang sudah diambil pemilik proyek:

1. **Batch pertama 12 kontes** (13.877 core LOC, 62 High + 99 Medium).
2. **Report dipangkas** ke bagian High/Medium/Low sebelum ekstraksi.
3. **ID kontes diremap** ke ID Code4rena asli dari frontmatter `contest:`.

### 3.1 Daftar 12 kontes

| local | c4_id | slug | core | LOC | H/M |
|---|---|---|---|---|---|
| 110 | dari frontmatter | 2024-11-nibiru | 17 | 591 | 6/10 |
| 33 | ” | 2024-01-curves | 5 | 690 | 5/10 |
| 40 | ” | 2024-02-althea-liquid-infrastructure | 7 | 837 | 1/4 |
| 32 | ” | 2024-01-canto | 4 | 1.020 | 2/2 |
| 23 | ” | 2023-11-kelp | 17 | 1.100 | 3/2 |
| 12 | ” | 2023-09-asymmetry | 15 | 1.118 | 5/10 |
| 65 | ” | 2024-04-gondi | 26 | 1.129 | 17/20 |
| 54 | ” | 2024-03-neobase | 5 | 1.312 | 1/7 |
| 34 | ” | 2024-01-decent | 17 | 1.377 | 4/5 |
| 57 | ” | 2024-03-pooltogether | 6 | 1.422 | 1/8 |
| 96 | ” | 2024-08-superposition | 13 | 1.594 | 7/12 |
| 64 | ” | 2024-04-dyad | 25 | 1.687 | 10/9 |
| **total** | | | **~236 file** | **13.877** | **62/99** |

Angka H/M dihitung dari heading finding yang unik (`[H-nn]`/`[M-nn]` pada heading),
bukan dari kemunculan string di seluruh badan report. Baseline yang mengikat
untuk G-A adalah **62 High + 99 Medium**, bukan angka 74/110 yang muncul dari
penghitungan longgar.

`c4_id` diisi saat prepare dari `contest:` di frontmatter; ke-12 report ini semuanya
punya nilai tersebut.

### 3.2 Yang dibuang dan alasannya

- 11 kontes tanpa report: 42, 53, 59, 62, 63, 69, 73, 80, 100, 102, 111.
- 21 kontes tanpa `.sol`: 1, 19, 36, 37, 41, 42, 44, 49, 53, 56, 59, 62, 63, 69,
  73, 80, 99, 100, 102, 103, 107.
- id 1 adalah template (`Sample, eh?`, `YYYY-MM-DD`).
- Total yang tidak pernah masuk kandidat: 26 kontes.

## 4. Arsitektur

### 4.1 Bentuk paket

Plugin server OpenCode V2, dimuat otomatis dari `.opencode/plugins/` (dan
`.opencode/plugin/`), dengan entry `index.ts` yang mengimpor
`{ Plugin }` dari paket `@opencode/plugin` (versi 2.3.0) dan mengekspor
`Plugin.define({ id: "knowdit", setup })`. Paket lama `@opencode-ai/plugin@1.x`
tidak dipakai: tipe `Context`-nya tidak punya `tool` maupun `experimental`.

```
.opencode/plugins/knowdit/
  index.ts                  # Plugin.define({ id, setup })
  src/
    tools/                  # registrasi tool lewat ctx.tool.transform
      dataset.ts
      build.ts
      query.ts
      stats.ts
    dataset/
      select.ts             # eligibility + manifest
      remap.ts              # local id -> c4 id
      trim.ts               # pemangkas report deterministik
      snapshot.ts           # salin source terpilih + sha256
    pipeline/
      categorize.ts
      extract-semantics.ts
      extract-findings.ts
      link-in-project.ts
      merge.ts
      link-global.ts
      finalize.ts
    db/
      schema.sql            # DDL 18 tabel, hasil port entity Rust
      client.ts             # probe binding + helper transaksi
    llm/
      session-transport.ts   # ctx.session.generate sekali pakai (Opsi B)
      types.ts
      json.ts
      cache.ts
      caller.ts             # validasi + retry + estimasi biaya
    prompts/                # hasil port dari prompts.rs
  data/                     # generated, di-gitignore
    dataset/                # snapshot 12 kontes + manifest.json + id_map.json
    kg.sqlite
    runs.sqlite             # journal eksekusi (BUKAN bagian KG)
    cache/                  # respons LLM per hash prompt
    llm-scratch/            # direktori session sekali pakai (tanpa AGENTS.md)
```

Tidak ada paket npm terpisah dan tidak ada proses daemon. Semua berjalan di dalam
server OpenCode.

### 4.2 Tool yang didaftarkan

Namespace `knowdit`, semuanya deterministik kecuali `build`:

| Tool | Fungsi | LLM? |
|---|---|---|
| `knowdit_dataset_prepare` | validasi dataset, susun `manifest.json` + `id_map.json`, tulis snapshot terpangkas | tidak |
| `knowdit_kg_build` | jalankan satu atau semua tahap untuk kontes terpilih; opsi `stage`, `ids`, `force`, `concurrency` | ya |
| `knowdit_kg_status` | progres per kontes per tahap, estimasi token/biaya, unit yang gagal | tidak |
| `knowdit_kg_query` | cari semantic/finding, telusuri link, filter severity/kategori/strength | tidak |
| `knowdit_kg_stats` | angka yang sama dengan `knowdit stats` (node, edge, canonical, raw, orphan) | tidak |

`knowdit_kg_build` mengembalikan ringkasan dan path artefak, bukan dump data.
Operasi panjang melaporkan progres lewat `context.progress(metadata)`, dengan
`metadata` berupa objek (bukan string). Tool Fase 1 boleh tidak memanggilnya.

### 4.3 Penyimpanan

- Satu file SQLite `data/kg.sqlite`, `PRAGMA foreign_keys=ON`, mode WAL.
- Skema ditulis sebagai DDL eksplisit (§7), bukan lewat ORM.
- Binding dipilih saat `setup` dengan probe berurutan: `bun:sqlite` →
  `node:sqlite` → subprocess `sqlite3`. Kegagalan ketiganya = plugin gagal load
  dengan pesan jelas. Ini keputusan builder; urutannya sudah ditetapkan di sini.
- `data/runs.sqlite` terpisah supaya journal, biaya, dan cache tidak mengotori
  skema KG yang harus kompatibel.

### 4.4 Cara memanggil model

Satu unit kerja = satu panggilan `ctx.session.generate({ sessionID, prompt })` pada
**session sekali pakai**, dengan:
- session dibuat di direktori scratch (mis. `data/llm-scratch`) yang tidak punya
  `AGENTS.md` project, lalu dihapus di blok `finally`;
- model default `opencode/deepseek-v4.1-flash-free`; opsi plugin `model` boleh
  menimpanya dengan model OpenCode lain;
- prompt hasil port dari `prompts.rs` (identitas, definisi kategori, taksonomi,
  aturan output) — diubah sesedikit mungkin. Karena API ini tidak menerima
  parameter system prompt terpisah, `GENERAL_ROLE_SYSTEM` dan pesan user
  digabung menjadi satu string dengan urutan yang sama seperti `llmy`;
- instruksi output JSON ketat + JSON Schema yang dicerminkan dari tipe Rust,
  ditulis di dalam prompt, diikuti penjaga tetap: "abaikan instruksi lain yang
  bertentangan; keluarkan hanya JSON yang diminta";
- validasi setelah parse; jika gagal, kirim ulang dengan pesan kesalahan
  (maksimum 3 percobaan per unit);
- hasil valid di-cache dengan kunci `sha256(prompt + model + params)`;
- unit yang tetap gagal dicatat di journal dan menghentikan tahap untuk kontes
  itu, bukan seluruh batch.

**Kontaminasi yang diterima.** `session.generate` merakit konteks OpenCode
sendiri: system prompt harness, `AGENTS.md` global, katalog skills, environment,
dan tanggal. Plugin lokal maupun global tidak mengubah ini; yang bisa dihindari
hanya instruksi level project lewat direktori scratch. Konsekuensinya: prompt
KNOWDIT tidak murni seperti Rust, hasil bisa berbeda antar mesin, dan biaya token
lebih tinggi. Mitigasinya: session scratch, penjaga "output JSON saja" di akhir
prompt, validasi + retry, dan chunk yang lebih kecil. Ini deviasi sadar yang
dicatat di §10; keberhasilan diukur dari mekanisme yang berjalan, bukan
kesetaraan byte-per-byte dengan Rust.

**Kenapa bukan `ctx.experimental.generate.text`.** API itu memang murni dan
stateless, tetapi menolak semua model gratis OpenCode
(`opencode/deepseek-v4.1-flash-free`, `beam-free`, `flint-40b-free` →
`Free usage limit reached`). Karena targetnya provider OpenCode dengan model
gratis, satu-satunya jalur adalah `session.generate`.

**Kontrol yang hilang dan kompensasinya.** API ini tidak menerima `temperature`,
`maxTokens`, atau JSON schema. Karena itu: prompt memuat instruksi "JSON saja,
tanpa prosa"; chunk dibatasi agar output tidak melewati batas model; dan
truncation JSON dideteksi sebagai kegagalan validasi lalu di-retry dengan chunk
yang lebih kecil. `session.generate` hanya mengembalikan `{ text }`, jadi biaya
tetap dihitung sebagai estimasi: `ceil(chars/4) × Model.Info.cost`, ditandai
`estimated: true` di journal. `knowdit_kg_status` tidak boleh menyebutnya biaya
provider.

Model default: `opencode/deepseek-v4.1-flash-free`. Override lewat opsi plugin
`model` (mis. `{ "providerID": "opencode", "id": "..." }`).

Deviasi sadar dari loop tool-calling asli dijelaskan di §10.

## 5. Remediasi dataset (deterministik, tanpa LLM)

### 5.1 ID map

`data/dataset/id_map.json`:

```json
{
  "7":  { "c4_id": 229, "slug": "2023-04-rubicon", "selected": true },
  "42": { "c4_id": null, "slug": null, "selected": false, "reason": "no report" }
}
```

Aturan: `c4_id` diambil dari frontmatter report (`contest:`). Jika report tidak
ada, entri tetap ditulis dengan `selected: false` dan alasan. `platform_id` di KG
menjadi `c4-<c4_id>`, bukan `c4-<local_id>`.

### 5.2 Snapshot source

- Ambil hanya file `.sol` yang lolos `DEFAULT_VENDORED_EXCLUDES` (42 pola:
  `lib`, `node_modules`, `build`, `artifacts`, `cache`, `test`, `mock`, `deploy`,
  `script`, `target`, `.git`, `src/vendor`, dst).
- Salin ke `data/dataset/contracts/<c4_id>/` dengan path relatif repo dipertahankan.
- Jangan salin `.git`, `typechain-types/`, `docs/`, `discord-export/`, gambar.
- Catat `sha256`, ukuran, dan path asal setiap file di manifest.
- Total yang diharapkan: ~13.877 LOC / ~230 file.

### 5.3 Pemangkas report

Parser deterministik berbasis heading level-1:

1. Pertahankan frontmatter YAML (`sponsor`, `slug`, `date`, `title`, `contest`).
2. Pertahankan `# Overview` dan `# Scope`.
3. Pertahankan `# High Risk Findings (N)` dan `# Medium Risk Findings (N)` beserta
   seluruh isinya.
4. Untuk Low, dataset memakai dua bentuk: **96 report** memakai satu bagian
   gabungan `# Low Risk and Non-Critical Issues`, sedangkan satu report memakai
   `# Low Risk Findings (42)` + `# Non-Critical Findings (15)`. Keduanya
   dipertahankan **utuh** — bagian Low tidak dipisah dari Non-Critical karena
   pemisahannya tidak konsisten di seluruh korpus.
5. Buang `# Summary`, `# Wardens`, `# QA Report`, `# Gas Optimizations`,
   `# Gas Report`, `# Disclosures`, dan bagian lain.
6. Jika hasil pangkasan tidak memuat satu pun bagian H/M, jatuhkan ke report utuh
   dan tandai `trim_fallback: true` di manifest.

Pada 12 kontes terpilih, aturan ini menyisakan **76% karakter** (1.474.097 dari
1.944.422 karakter, ≈368k token). Manifest mencatat section yang dibuang, ukuran
sebelum/sesudah, dan estimasi token per report. Tujuannya: hasil bisa diaudit dan
dipangkas ulang tanpa menyentuh data asli.

### 5.4 Manifest

Satu `manifest.json` berisi: versi skema manifest, timestamp, hash dataset asli,
daftar kontes dengan status eligibility, file source + sha256, report terpangkas +
sha256, section yang dibuang, dan total estimasi token. Semua tool build membaca
manifest ini, bukan `~/c4-data` langsung.

## 6. Pipeline

Semua tahap menulis ke `kg.sqlite`. Satu transaksi per kontes untuk tahap 1–4,
satu transaksi per kontes untuk merge, satu transaksi per batch untuk global link.

### Tahap 1 — Kategorisasi proyek

- Input: daftar file + isi source (dipotong), definisi 14 kategori DeFi.
- Output: subset kategori (≥1) + alasan singkat.
- Validasi: setiap nilai ada di enum `DeFiCategory`; kosong = retry; setelah 3
  gagal, kontes dihentikan.
- Tulis: baris `project`, `project_platform` (`c4-<c4_id>`),
  `project_category`.

### Tahap 2 — Ekstraksi semantic

- Source dipecah menjadi chunk berdasarkan budget token (default mengikuti
  `DEFAULT_CONTEXT_WINDOW_UTILIZATION = 0.2`; batas jumlah item juga diterapkan
  seperti di kode asli).
- Satu panggilan per chunk. Item mengikuti `ExtractedSemantic` apa adanya:
  `name`, `category`, `definition`, `description`,
  `functions[{ name, contract, signature? }]`.
- Validasi: `name` tidak kosong; `category` ada di enum; `functions` minimal satu
  dan `contract` menunjuk file yang ada di snapshot (dinormalisasi ke path
  relatif); `name` unik setelah dedup dalam proyek. `signature` opsional dan
  **tidak dipersistenkan** (kolomnya tidak ada di `semantic_function`).
- Tulis: `semantic_node` (raw, kategori disimpan sebagai kolom skalar
  `semantic_node.category`), `semantic_function`, `project_semantic`.

### Tahap 3 — Ekstraksi finding

- Input: **hanya report terpangkas**, dipecah per budget. Ekstraktor finding di
  kode asli tidak menerima source code sama sekali (`extract_findings` hanya
  memakai `build_report_prompt_body`), jadi source tidak boleh ditambahkan —
  menambahkannya akan mengubah prompt dan biaya secara signifikan.
- Output per item: `title`, `severity`, `category`, `subcategory`, `root_cause`,
  `description`, `patterns`, `exploits`.
- Validasi: pasangan `(category, subcategory)` harus ada di 45 entri taksonomi
  (pakai validator yang sama dengan `validate_taxonomy_pair`); `severity` ∈
  {High, Medium, Low}; dedup berdasarkan `title` dalam proyek.
- Tulis: `audit_finding` (raw), `audit_finding_category`, `project_finding`.

### Tahap 4 — In-project link

- Satu panggilan per kontes: seluruh finding proyek × seluruh semantic proyek.
- Output model **hanya pasangan indeks** `{ finding_index, semantic_indices[] }`.
  Model tidak mengeluarkan `strength` atau `evidence`; ini penting agar sama
  dengan kode asli.
- Validasi keras: setiap finding harus muncul dengan ≥1 indeks semantic; indeks
  harus valid; target harus semantic milik proyek yang sama; finding tanpa link =
  panggilan diulang, gagal lagi = kontes dihentikan.
- Tulis: `semantic_finding_link` untuk node raw (sebelum merge) dengan nilai
  **persis seperti Rust**: `strength = "High"` dan `evidence =
  "in-project link: finding and semantic co-emitted by the extract pipeline
  against the same project; finding instantiates the semantic in its originating
  codebase"`.
- Prefix `in-project link: ...` bersifat load-bearing: `kg_stats` memakainya
  untuk memisahkan `links_in_project` dari `links_cross`, dan
  `clear_finding_link_progress` memakainya untuk mereset link global tanpa
  menghapus link in-project. Prefix tidak boleh diubah.

### Tahap 5 — Merge lintas proyek

- Serial, kontes demi kontes, setelah tahap 1–4 kontes itu selesai.
- Kandidat: canonical + raw children, di-chunk.
- Keputusan per item: `NEW`, atau `MERGE` ke satu/lebih target.
- Aturan yang ditegakkan mekanis:
  - `name`/`definition` (semantic) dan `title`/`severity`/`root_cause` (finding)
    **beku** pada canonical;
  - `updated_*` harus non-blank; "lebih konkret" adalah instruksi prompt, bukan
    pemeriksaan mekanis. Di Rust pemeriksaan itu hidup di handler tool agen yang
    tidak diport; di sini yang ditegakkan adalah validasi skema + non-blank;
  - setiap edge merge wajib menyertakan catatan `appended_*` (aturan lapisan
    kita; Rust sendiri menyimpan string kosong bila agen tidak memberi);
  - multi-target merge menulis satu edge per target;
  - target tidak boleh node yang sudah merged-away;
  - edge provenance `project_semantic`/`project_finding` ditambahkan ke canonical
    untuk setiap raw yang di-merge, sama seperti Rust.
- Tulis: `semantic_merge`, `finding_merge`, update baris canonical. **Tidak**
  menulis `merge_status` — tabel itu menyimpan progres merge antar-KG
  (`source_key`, `native_sem_ceiling`, `phase`), bukan status merge per node.

### Tahap 6 — Global link

- Kandidat: seluruh semantic canonical.
- Finding diproses per batch; maksimum 2 link per finding.
- `strength` ∈ {High, Medium, Low} dengan rubrik yang diport dari `link.rs`.
- Untuk `High`, evidence wajib memuat ≥6 kata verbatim dari teks finding;
  pemeriksaan mekanis, gagal = ulang untuk finding itu.
- Tulis: `semantic_finding_link` (canonical), `finding_link_status`.
- Semantic yang baru muncul setelah sebuah finding selesai dilink masuk ke
  `pending_semantic` dan diproses retro-link.

### Tahap 7 — Finalisasi

- Tulis baris `operation_history` (idempoten pada `(type, args)`).
- Jalankan pemeriksaan integritas (§8) dan tulis ringkasan ke journal.

## 7. Skema dan kompatibilitas

18 tabel, nama kolom dan nilai enum diambil apa adanya dari entity Rust:

`project`, `project_platform`, `category`, `project_category`, `semantic_node`,
`semantic_function`, `semantic_merge`, `audit_finding`, `finding_category`,
`audit_finding_category`, `semantic_finding_link`, `finding_link_status`,
`finding_merge`, `project_semantic`, `project_finding`, `pending_semantic`,
`merge_status`, `operation_history`.

`knowdit-kg-model` juga punya entity `semantic_node_category`, tetapi
`create_tables` **tidak membuat tabelnya** dan pipeline tidak pernah menulisnya —
kategori semantic hidup di kolom skalar `semantic_node.category`. Karena itu
`schema.sql` hanya berisi 18 tabel dan plugin tidak boleh mempopulasi tabel join
yang tidak ada di database referensi.

Sebaliknya, tabel `merge_status` **dibuat** tetapi **tidak ditulis** oleh pipeline
Fase 1: entity-nya menyimpan progres merge antar-KG (`source_key`,
`native_sem_ceiling`, `phase`), bukan status merge per node. Merge node hidup di
`semantic_merge`/`finding_merge` ditambah update baris canonical. `G-B` karena
itu memeriksa bahwa `merge_status` tetap kosong setelah build.

Aturan kompatibilitas:

- Target kompatibilitas adalah **v1.0.1 dari clone `/home/jey/Dev/knowdit`**
  (18 tabel, 45 subkategori, 14 kategori DeFi, 7 kategori kerentanan). Binary
  `knowdit` v2.0.1 yang terpasang di `~/.cargo/bin` **bukan** target: ia punya
  19 tabel dan men-seed 45 subkategori.
- Nama tabel/kolom, tipe, dan `string_value` enum harus sama persis.
- Foreign key memakai nama dan aksi yang sama dengan `create_tables` Rust
  (mis. `fk-semantic_merge-from_semantic_id`, cascade/restrict sesuai aslinya).
- Tabel referensi `category` dan `finding_category` di-seed dari taksonomi.
- Tidak ada kolom tambahan pada tabel bersama. Data internal kita (journal,
  biaya, cache) hidup di `runs.sqlite`, bukan di sini.
- `schema_is_initialized` di Rust hanya mengecek keberadaan tabel `project`;
  tetap, kita tidak boleh mengandalkan itu — DDL harus lengkap.
- Binary Rust boleh **membaca** `kg.sqlite`; ia tidak boleh menulis di Fase 1.

## 8. Gerbang verifikasi

**G-A Dataset.** 12 kontes, masing-masing core > 0 dan report punya ≥1 High;
ID map lengkap; sha256 snapshot tercatat; total LOC dalam ±5% dari 13.877.

**G-B Integritas KG** (query SQL, dijalankan otomatis di akhir build):

- setiap finding punya `project_finding`;
- setiap semantic punya `project_semantic`;
- setiap finding hasil tahap 1–4 punya ≥1 `semantic_finding_link`;
- tidak ada edge merge menggantung, tidak ada siklus, tidak ada canonical yang
  punya outgoing merge;
- setiap baris `finding_link_status` merujuk finding yang ada;
- semua kolom enum berisi nilai yang diizinkan;
- setiap link **cross-project** berstrength `High` lolos uji ≥6 kata verbatim.
  Link in-project dikecualikan karena evidence-nya sintetis dan sudah ditandai
  prefix `in-project link: ...` — menguji keduanya akan selalu gagal dan itu
  perilaku yang benar.

**G-C Kompatibilitas.** Juri eksternalnya adalah **binary yang dibangun dari clone
`/home/jey/Dev/knowdit` (v1.0.1)**, bukan binary `knowdit` yang terpasang di
`~/.cargo/bin` (itu v2.0.1: 19 tabel, 45 subkategori, seed berbeda). Binary
v1.0.1 dibangun dengan `cargo build --release -p knowdit` dan dipakai untuk:

- `knowdit learn --database-url "sqlite://<abs-path>?mode=rwc" validate-db`
  keluar dengan status 0 (bersih). Perintah ini juga mencetak `KgStats`; ia
  **gagal** bila ada masalah integritas, jadi ini lebih kuat daripada G-B.
  Perhatikan urutan argumen: `--database-url` milik `learn`, jadi ia mendahului
  subcommand, dan URL butuh `?mode=rwc` agar file bisa dibuat.
- `knowdit db --database-url ... snapshot --format json --output ...` berhasil
  menulis snapshot (argumen mengikuti `db snapshot --help`).
- Subset `KgStats` berikut harus sama persis dengan `knowdit_kg_stats`:
  `projects_total`, `semantics_total`, `semantics_canonical`, `findings_total`,
  `findings_canonical`, `links_total`, `links_in_project`, `links_cross`,
  `link_processed_findings`, `pending_semantics`.
- Statistik panjang render (`variant_render_cap`, `raw_child_char_cap`, distribusi
  panjang field) **tidak** wajib direplikasi: itu kaliber investigasi yang
  bergantung pada `render_with_variants_capped`, bukan kontrak data.
- Konfirmasi tambahan: jalur consumer Rust (`connect_init_for_consumer`) menolak
  KG yang punya `semantic_finding_link` untuk finding tanpa baris
  `finding_link_status`. Database hasil build harus lolos jalur itu, bukan hanya
  jalur writer.

**G-D Makna.** Sampel acak 20 link direview manusia; target ≥16/20 masuk akal
(finding benar-benar berkaitan dengan semantic yang ditunjuk).

**G-E Reproduksibilitas.** Pada `concurrency = 1` (default), build ulang dari
cache menghasilkan jumlah baris dan hash tabel yang identik; build ulang penuh
dari nol menghasilkan jumlah yang sama. Dengan `concurrency > 1`, urutan commit
dan ID autoincrement boleh berbeda, jadi jaminan hash **tidak berlaku**; yang
tetap dijamin hanya kebenaran isi dan lolosnya G-B.

## 9. Resume, cache, dan kegagalan

- `runs.sqlite` mencatat `(stage, c4_id, unit_index, status, attempt, prompt_hash,
  response_hash, tokens_est, cost_est, error)`.
- Cache respons: `data/cache/<prompt_hash>.json`. Rebuild tanpa LLM memakai cache.
- Tahap dianggap selesai untuk sebuah kontes hanya jika transaksinya commit dan
  baris journal-nya `done`.
- Kegagalan satu kontes tidak membatalkan kontes lain, tetapi menghentikan tahap
  merge/link global sampai kontes itu ditandai `skipped` secara eksplisit —
  merge tidak boleh melihat proyek setengah jadi.
- `force` bersifat dua tingkat, karena setelah merge sebuah kontes berbagi
  canonical dengan kontes lain (`project_semantic`/`project_finding` menyimpan
  provenance, dan `semantic_merge.to_semantic_id` ber-`RESTRICT`):
  - **sebelum tahap 5** (kontes belum pernah di-merge): `force` menghapus baris
    KG milik kontes itu, baris `project_semantic`/`project_finding`-nya, dan
    journal-nya, lalu mengulang.
  - **setelah tahap 5**: `force` **menolak** kecuali dipanggil dengan
    `reset_all=true`, yang menjatuhkan seluruh isi KG dan membangun ulang dari
    nol. Tidak ada unmerge parsial di Fase 1: memisahkan kontribusi satu kontes
    dari canonical bersama terlalu mudah merusak provenance.
- `reset_all` mencatat alasan di journal agar rebuild penuh tidak terlihat
  seperti hasil normal.

## 10. Deviasi dari KNOWDIT asli

| # | Deviasi | Alasan | Risiko | Mitigasi |
|---|---|---|---|---|
| 1 | Loop tool-calling → satu generasi JSON + validasi/retry | determinisme, retry per unit, biaya, resume | model bisa menghasilkan JSON besar yang terpotong | batas ukuran chunk + retry + validasi schema; kontrak tool tetap 1:1 di schema |
| 2 | `GENERAL_ROLE_SYSTEM` digabung ke prompt user; tanpa `temperature`/`maxTokens` | `experimental.generate.text` tidak punya parameter itu | hasil bisa lebih bervariasi | instruksi output eksplisit, retry, dan cache |
| 3 | Biaya = estimasi `chars/4 × Model.Info.cost` | hanya `session.generate` yang melaporkan biaya asli, tapi ia membawa riwayat sesi | estimasi bisa meleset | ditandai `estimated: true`; tidak diklaim sebagai biaya provider |
| 4 | Report dipangkas (76% karakter dipertahankan) | biaya dan noise QA/Gas | konteks finding bisa hilang | simpan report asli, manifest mencatat pemangkasan, `trim_fallback` |
| 5 | ID diremap ke ID C4 asli | `platform_id` yang benar, join ke dataset lain | salah parse frontmatter | validasi: `c4_id` integer unik, ada di report |
| 6 | Tidak ada kompilasi/autobuild | tidak dibutuhkan untuk ekstraksi | tidak ada | — |
| 7 | SQLite saja | cukup untuk Fase 1 | MySQL nanti | DDL dipisah dari kode akses |
| 8 | Tanpa subagent per chunk | biaya dan kontrol | tidak memakai agent loop native | didokumentasikan; transport bisa diganti tanpa mengubah schema |

Yang **bukan** deviasi, dan harus tetap sama: in-project link tanpa strength/evidence
dari model, ekstraksi finding dari report saja tanpa source, dan skema 18 tabel.

## 11. Estimasi biaya batch pertama

Asumsi yang bisa dihitung ulang dari manifest:

- source: 13.877 LOC ≈ 150k token;
- report terpangkas: 1.474.097 karakter ≈ 368k token;
- overhead prompt (definisi kategori, taksonomi, instruksi charta) ≈ 2–4k token
  per chunk;
- merge dan link global ≈ 2–3× volume ekstraksi karena kandidat canonical
  diulang di setiap batch.

Perkiraan kasar: **1–2,5 juta token input** untuk 12 kontes, output jauh lebih
kecil. Ini orde besaran, bukan angka kontraktual. `knowdit_kg_status` melaporkan
estimasi per tahap dari journal, bukan tagihan provider.

## 12. Yang diserahkan ke builder (keputusan saya)

- Urutan probe binding SQLite dan pesan kegagalannya.
- Konstanta ukuran chunk dan batas item per panggilan (mengikuti default Rust
  selama tidak ada alasan untuk menyimpang).
- Format `runs.sqlite` dan nama file cache, termasuk skema kolom untuk estimasi
  biaya (`tokens_est`, `cost_est`).
- Nama opsi tool dan bentuk ringkasan output.
- Strategi representasi `functions` bila file tidak punya batas fungsi yang jelas.
- Angka retry/backoff dan timeout per panggilan model.
- Cara memotong chunk bila output JSON ter-truncate (perkecil chunk vs minta
  item lebih sedikit).

## 13. Definisi selesai Fase 1

Fase 1 selesai bila, untuk 12 kontes:

1. `knowdit_dataset_prepare` menghasilkan snapshot + manifest yang lolos G-A.
2. `knowdit_kg_build` menyelesaikan tahap 1–7 dan lolos G-B.
3. Binary Rust asli membaca database dan angkanya cocok (G-C).
4. Review 20 link lolos ambang G-D.
5. Rebuild dari cache identik (G-E).
6. `knowdit_kg_query` bisa menjawab tiga pertanyaan contoh: “semantic apa yang
   paling sering muncul bersama finding High?”, “finding apa yang bertaut ke
   semantic kategori Lending?”, “berapa canonical semantic tanpa finding?”

### 13.1 Status implementasi (parsial, 2026-11-17)

Batch 12 kontes belum selesai; build berhenti karena kuota model gratis habis
dan dilanjutkan dengan `kg_build` yang sama setelah kuota pulih.

- Dataset: 12 kontes, 13.983 LOC, 62 High + 99 Medium, 0 trim fallback.
- C4 453: 24 findings, 48 links, finalize lolos.
- C4 316: 23 findings, integrity gate lolos.
- C4 331: categorize/semantics/findings selesai (12 findings, 7 semantik);
  unit `link` menunggu retry.
- Total KG parsial: 3 project, 20 semantik, 59 findings, 91 links
  (80 in-project, 11 cross-project).
- `scripts/verify-compat.ts` pada DB parsial: `compat OK`.

Progress `kg_build` juga tampil sebagai satu baris di atas composer TUI
(`tui.tsx`), memakai penanda `source: "knowdit"` pada setiap update dan hilang
saat tool selesai. `data/progress.log` tetap menjadi riwayat JSONL.
