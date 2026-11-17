# KNOWDIT Phase 1 (Historical KG) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Membangun plugin OpenCode V2 yang menyiapkan dataset Code4rena terpilih dan menambang Historical Knowledge Graph KNOWDIT ke dalam SQLite dengan skema yang bisa dibaca binary Rust v1.0.1.

**Architecture:** Plugin server OpenCode mendaftarkan lima tool; logika inti adalah modul TypeScript murni tanpa dependensi eksternal. Dataset disiapkan deterministik lebih dulu (manifest + snapshot + report terpangkas), lalu tujuh tahap pipeline menulis 18 tabel KG lewat adapter SQLite. Semua panggilan model diisolasi di satu `LlmCaller` sehingga pengujian memakai transport palsu.

**Tech Stack:** TypeScript (ESM, type-stripping Node 24), `node:test`, `node:sqlite` (dev/test) dengan probe `bun:sqlite` (runtime OpenCode), SQLite, plugin server `@opencode/plugin`.

**Spec:** `docs/superpowers/specs/2026-11-17-knowdit-kg-phase1-design.md`

## Global Constraints

- Target kompatibilitas: **clone `/home/jey/Dev/knowdit` v1.0.1** — 18 tabel user, 14 kategori DeFi, 7 kategori kerentanan, 45 subkategori. Binary `knowdit` 2.0.1 di `~/.cargo/bin` **bukan** target.
- Plugin entry: `.opencode/plugins/knowdit/index.ts`, `Plugin.define({ id: "knowdit", setup })`; namespace tool `knowdit`.
- Tanpa dependensi runtime tambahan selain paket host `@opencode/plugin`; satu-satunya import host ada di `index.ts`.
- TypeScript yang bisa di-strip Node: tanpa `enum`, tanpa parameter properties, tanpa `namespace`. Gunakan `type`, `interface`, `as const`.
- Test: `node --test` dari root repo. File test: `test/**/*.test.ts`.
- SQLite: `PRAGMA foreign_keys=ON`, `journal_mode=WAL`; URL untuk binary Rust wajib `sqlite://<abs-path>?mode=rwc`.
- 14 kategori DeFi: `Lending`, `Dexes`, `Yield`, `Services`, `Derivatives`, `Yield Aggregator`, `Real World Assets`, `Stablecoins`, `Indexes`, `Insurance`, `NFT Marketplace`, `NFT Lending`, `Cross Chain`, `Others`.
- 7 kategori kerentanan: `Access Control`, `Arithmetic`, `Block Manipulation`, `Cryptographic`, `Denial of Services`, `Reentrancy`, `Storage & Memory`.
- `severity` hanya `High`, `Medium`, `Low`.
- Context utilization `0.2`; maksimum `3` percobaan per unit; maksimum `2` link global per finding; evidence `High` minimal `6` kata verbatim.
- Prefix evidence in-project (harus persis): `in-project link: finding and semantic co-emitted by the extract pipeline`.
- Batch kontes (local id): `110, 33, 40, 32, 23, 12, 65, 54, 34, 57, 96, 64`; baseline `62` High + `99` Medium; `13.877` core LOC ±5%.
- Tidak ada kolom tambahan pada 18 tabel KG; journal/cache/biaya hidup di `data/runs.sqlite`.
- Semua artefak generate masuk `data/` dan di-gitignore; `~/c4-data` tidak pernah ditulis.
- Satu-satunya harga yang dilaporkan adalah estimasi (`ceil(chars/4) × cost`) dan harus ditandai `estimated`.
- Default `concurrency = 1`; jaminan hash rebuild (G-E) hanya berlaku pada nilai itu.
- Fakta skema yang tidak boleh salah tebak (diverifikasi dari entity Rust):
  - `semantic_finding_link` ber-PK komposit `(semantic_node_id, audit_finding_id)` dan **tidak punya kolom `id`**.
  - `merge_status` adalah progres merge antar-KG (`source_key`, `native_sem_ceiling`, `phase`), **bukan** status merge per node. Pipeline Fase 1 tidak menulisnya.
  - `project.status` wajib diisi; nilai yang dipakai Rust adalah `"completed"`.
  - `operation_history.operation_type` hanya menerima `c4learn`, `sherlocklearn`, `link`.
  - `semantic_function` menyimpan `function_name` dan `contract_path` (bukan `name`/`contract`).
  - `finding_link_status` hanya punya `audit_finding_id` (PK); `pending_semantic` hanya punya `semantic_node_id` (PK).
- Helper test yang dipakai lebih dari satu task tinggal di `test/helpers/` dan dibuat di task pertama yang membutuhkannya. Nama `seededCtx`, `seededSemantic`, `seededFinding`, `seededGlobalCtx`, `seededBroken`, `seededStats` adalah helper lokal di file test pemakainya.

## Review Focus

1. **Bentuk section Low yang tidak dikenal** (mis. `# Gas Report` atau Low/Non-Critical terpisah): trimmer harus tetap mempertahankan High/Medium, dan jatuh ke report utuh bila tidak menemukan keduanya — bukan menghasilkan report kosong. Test: Task 5.
2. **Respons model tidak valid atau ter-truncate**: harus retry lalu menggagalkan unit tanpa menulis baris parsial. Test: Task 10.
3. **Semantic tanpa `functions` atau kategori di luar enum**: ditolak dengan error spesifik dan kontes tidak ditulis. Test: Task 13.
4. **In-project link yang menghilangkan satu finding**: retry, dan bila tetap gagal tidak ada baris tersimpan untuk kontes itu. Test: Task 15.
5. **Merge yang mengubah identitas atau tanpa catatan `appended_*`**: ditolak dan canonical tidak berubah. Test: Task 16.

---

### Task 1: Scaffolding, test harness, dan plugin entry

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `.opencode/plugins/knowdit/index.ts`
- Create: `.opencode/plugins/knowdit/src/register.ts`
- Create: `.opencode/plugins/knowdit/src/tools/handlers.ts` (stub)
- Create: `.opencode/plugins/knowdit/src/llm/session-transport.ts`
- Test: `test/register.test.ts`, `test/llm/session-transport.test.ts`

**Interfaces:**
- Consumes: tidak ada.
- Produces: `type ToolHandler = (input: unknown, ctx: { progress?: (update: Record<string, unknown>) => Promise<void> }) => Promise<{ content: string }>`; `type ToolEditor = { namespace(n: { name: string; description: string }): void; add(tool: { name: string; description: string; input: unknown; execute: ToolHandler }): void }`; `registerKnowditTools(editor: ToolEditor, handlers: Record<string, ToolHandler>): void`; `type ModelRef = { providerID: string; id: string }`; `type SessionGenerate = (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>`; `createSessionGenerate(ctx: SessionTransportCtx, opts: { scratchDir: string; model: ModelRef }): SessionGenerate`.

  `ctx.progress` milik OpenCode menerima objek metadata (`Record<string, any>`), bukan string. Tool Fase 1 tidak wajib memanggilnya; tipe ini hanya menjaga kompatibilitas.

- [ ] **Step 1: Inisialisasi repo dan harness**

```bash
git init -b main
git checkout -b knowdit-kg-phase1
```

`package.json`: `{ "name": "knowdit-opencode", "private": true, "type": "module", "scripts": { "test": "node --test" }, "dependencies": { "@opencode/plugin": "2.3.0" } }`.
`.gitignore`: `data/`, `node_modules/`, `.superpowers/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`.
`tsconfig.json`: `{ "compilerOptions": { "target": "ES2023", "module": "nodenext", "moduleResolution": "nodenext", "strict": true, "noEmit": true, "allowImportingTsExtensions": true, "verbatimModuleSyntax": true } }`.
Install dependency: `npm install` (memasang `@opencode/plugin@2.3.0`). Paket lama `@opencode-ai/plugin@1.18.34` yang ada di `~/.opencode/node_modules` adalah API V1 dan **tidak** punya `ctx.tool`/`ctx.experimental`; jangan dipakai sebagai acuan tipe.

- [ ] **Step 2: Tulis test yang gagal**

```ts
// test/register.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { registerKnowditTools } from "../.opencode/plugins/knowdit/src/register.ts";

test("registers the knowdit namespace and five tools", () => {
  const namespaces: string[] = [];
  const tools: string[] = [];
  registerKnowditTools(
    { namespace: (n) => namespaces.push(n.name), add: (t) => tools.push(t.name) },
    { dataset_prepare: async () => ({ content: "ok" }) },
  );
  assert.deepEqual(namespaces, ["knowdit"]);
  assert.deepEqual(tools, ["dataset_prepare"]);
});
```

```ts
// test/llm/session-transport.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGenerate } from "../../.opencode/plugins/knowdit/src/llm/session-transport.ts";

type Call = { op: string; input: any };

function fakeCtx(generate?: (input: any) => Promise<any>) {
  const calls: Call[] = [];
  let n = 0;
  const ctx = {
    session: {
      create: async (input: any) => {
        calls.push({ op: "create", input });
        return { id: `s${++n}` };
      },
      generate: async (input: any) => {
        calls.push({ op: "generate", input });
        if (generate) return generate(input);
        return { text: "ok" };
      },
      remove: async (input: any) => {
        calls.push({ op: "remove", input });
      },
    },
  };
  return { ctx, calls };
}

const scratch = () => mkdtempSync(join(tmpdir(), "llm-scratch-"));
const model = { providerID: "opencode", id: "m" };

test("creates a scratch session, generates, and removes it", async () => {
  const { ctx, calls } = fakeCtx();
  const dir = scratch();
  const generate = createSessionGenerate(ctx, { scratchDir: dir, model });
  const r = await generate({ prompt: "P" });
  assert.deepEqual(r, { text: "ok" });
  assert.equal(calls[0].op, "create");
  assert.deepEqual(calls[0].input.location, { directory: dir });
  assert.deepEqual(calls[0].input.model, model);
  assert.deepEqual(calls[1], { op: "generate", input: { sessionID: "s1", prompt: "P" } });
  assert.deepEqual(calls[2], { op: "remove", input: { sessionID: "s1" } });
});

test("removes the session when generation fails", async () => {
  const { ctx, calls } = fakeCtx(async () => {
    throw new Error("boom");
  });
  const generate = createSessionGenerate(ctx, { scratchDir: scratch(), model });
  await assert.rejects(() => generate({ prompt: "P" }), /boom/);
  assert.deepEqual(calls.map((c) => c.op), ["create", "generate", "remove"]);
});

test("per-call model overrides the default", async () => {
  const { ctx, calls } = fakeCtx();
  const generate = createSessionGenerate(ctx, { scratchDir: scratch(), model });
  await generate({ prompt: "P", model: { providerID: "opencode", id: "override" } });
  assert.deepEqual(calls[0].input.model, { providerID: "opencode", id: "override" });
});
```

- [ ] **Step 3: Jalankan test, pastikan gagal**

Run: `node --test test/register.test.ts test/llm/session-transport.test.ts`
Expected: FAIL — modul `register.ts` dan `session-transport.ts` belum ada.

- [ ] **Step 4: Implementasi `registerKnowditTools`, transport, dan entry plugin**

`register.ts` memanggil `editor.namespace({ name: "knowdit", description: "KNOWDIT historical knowledge graph" })`, lalu untuk setiap entri `handlers` memanggil `editor.add({ name, description: TOOL_DESCRIPTIONS[name], input: TOOL_SCHEMAS[name], execute })`. `TOOL_DESCRIPTIONS` dan `TOOL_SCHEMAS` adalah konstanta di file yang sama; lima nama: `dataset_prepare`, `kg_build`, `kg_status`, `kg_query`, `kg_stats`.

`session-transport.ts`:

```ts
import { mkdirSync } from "node:fs";

export type ModelRef = { providerID: string; id: string };
export type SessionTransportCtx = {
  session: {
    create(input: { title: string; location: { directory: string }; model: ModelRef }): Promise<{ id: string }>;
    generate(input: { sessionID: string; prompt: string }): Promise<{ text: string }>;
    remove(input: { sessionID: string }): Promise<void>;
  };
};
export type SessionGenerate = (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>;

export function createSessionGenerate(
  ctx: SessionTransportCtx,
  opts: { scratchDir: string; model: ModelRef },
): SessionGenerate {
  mkdirSync(opts.scratchDir, { recursive: true });
  return async (input) => {
    const model = input.model ?? opts.model;
    const session = await ctx.session.create({
      title: "knowdit-llm",
      location: { directory: opts.scratchDir },
      model,
    });
    try {
      const r = await ctx.session.generate({ sessionID: session.id, prompt: input.prompt });
      return { text: r.text };
    } finally {
      await ctx.session.remove({ sessionID: session.id }).catch(() => {});
    }
  };
}
```

`index.ts`:

```ts
import { Plugin } from "@opencode/plugin";
import { registerKnowditTools } from "./src/register.ts";
import { buildHandlers } from "./src/tools/handlers.ts";
import { createSessionGenerate } from "./src/llm/session-transport.ts";

const DEFAULT_MODEL = { providerID: "opencode", id: "deepseek-v4.1-flash-free" };

export default Plugin.define({
  id: "knowdit",
  async setup(ctx) {
    const model = (ctx.options as any)?.model ?? DEFAULT_MODEL;
    const dataDir = new URL("../data/", import.meta.url).pathname;
    await ctx.tool.transform((editor) => {
      registerKnowditTools(editor, buildHandlers({
        dataDir,
        model,
        generate: createSessionGenerate(ctx, { scratchDir: `${dataDir}llm-scratch/`, model }),
      }));
    });
  },
});
```

`buildHandlers` dibuat sebagai stub di task ini (`src/tools/handlers.ts`) yang mengembalikan `{ dataset_prepare: async () => ({ content: "not implemented" }) }`; task 20 menggantinya.

- [ ] **Step 5: Jalankan test, pastikan lulus**

Run: `node --test test/register.test.ts test/llm/session-transport.test.ts`
Expected: PASS, 4 test.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .opencode test
git commit -m "chore: scaffold knowdit plugin, session transport, and test harness"
```

---

### Task 2: Fixture skema dari binary referensi v1.0.1

**Files:**
- Create: `scripts/reference-schema.sh`
- Create: `.opencode/plugins/knowdit/src/db/schema.sql`
- Create: `test/fixtures/schema-1.0.1.json`
- Test: `test/db/schema-fixture.test.ts`

**Interfaces:**
- Consumes: tidak ada.
- Produces: `.opencode/plugins/knowdit/src/db/schema.sql` (DDL 18 tabel) dan `test/fixtures/schema-1.0.1.json` berbentuk `{ "version": "1.0.1", "tables": { "<name>": [{ "name": string, "type": string, "notnull": number, "pk": number, "dflt_value": string | null }] } }`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/db/schema-fixture.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("test/fixtures/schema-1.0.1.json", "utf8"));

test("fixture is the 18-table v1.0.1 schema", () => {
  assert.equal(fixture.version, "1.0.1");
  assert.deepEqual(Object.keys(fixture.tables).sort(), [
    "audit_finding", "audit_finding_category", "category", "finding_category",
    "finding_link_status", "finding_merge", "merge_status", "operation_history",
    "pending_semantic", "project", "project_category", "project_finding",
    "project_platform", "project_semantic", "semantic_finding_link",
    "semantic_function", "semantic_merge", "semantic_node",
  ]);
  assert.equal(fixture.tables.category.length, 2);
  assert.equal(fixture.tables.finding_category.length, 4);
  assert.deepEqual(
    fixture.tables.semantic_finding_link.map((c: { name: string }) => c.name),
    ["semantic_node_id", "audit_finding_id", "strength", "evidence"],
  );
  assert.equal(fixture.tables.semantic_finding_link.filter((c: { pk: number }) => c.pk > 0).length, 2);
  assert.equal(Object.keys(fixture.tables).length, 18);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/db/schema-fixture.test.ts`
Expected: FAIL — file fixture belum ada.

- [ ] **Step 3: Tulis `scripts/reference-schema.sh`**

Script harus: (a) membaca versi dari `Cargo.toml` workspace dan gagal bila bukan `1.0.1`; (b) `cargo build --release -p knowdit`; (c) menghapus DB scratch di `data/tmp/reference.sqlite`; (d) menjalankan `<repo>/target/release/knowdit learn --database-url "sqlite://<abs>?mode=rwc" init-db`; (e) `sqlite3 <db> .schema > .opencode/plugins/knowdit/src/db/schema.sql`; (f) menulis fixture JSON lewat `sqlite3 -json "select name from sqlite_master where type='table' and name not like 'sqlite_%'"` lalu `PRAGMA table_info` per tabel; (g) memverifikasi `select count(*) from category` = 14 dan `select count(*) from finding_category` = 45, gagal bila tidak.

- [ ] **Step 4: Jalankan script**

Run: `bash scripts/reference-schema.sh`
Expected: `wrote .opencode/plugins/knowdit/src/db/schema.sql (18 tables, 14 categories, 45 subcategories)`.

- [ ] **Step 5: Jalankan test, pastikan lulus**

Run: `node --test test/db/schema-fixture.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/reference-schema.sh .opencode/plugins/knowdit/src/db/schema.sql test/fixtures test/db/schema-fixture.test.ts
git commit -m "feat: capture reference v1.0.1 schema as the compatibility contract"
```

---

### Task 3: Klien SQLite, penerapan skema, dan seed tabel referensi

**Files:**
- Create: `.opencode/plugins/knowdit/src/db/client.ts`
- Create: `.opencode/plugins/knowdit/src/db/seed.ts`
- Create: `.opencode/plugins/knowdit/src/domain/categories.ts`
- Create: `.opencode/plugins/knowdit/src/domain/taxonomy.ts`
- Create: `test/helpers/db.ts`
- Test: `test/db/client.test.ts`

**Interfaces:**
- Consumes: tidak ada; `schema.sql` dibaca dari direktori modul ini (`.opencode/plugins/knowdit/src/db/schema.sql`).
- Produces: `interface KgDb { exec(sql: string): void; all<T>(sql: string, params?: readonly unknown[]): T[]; get<T>(sql: string, params?: readonly unknown[]): T | undefined; run(sql: string, params?: readonly unknown[]): { changes: number; lastInsertRowid: number }; tx<T>(fn: () => T): T; close(): void }`; `openKg(path: string): Promise<KgDb>`; `seedReferenceTables(db: KgDb): void`; `const DEFI_CATEGORIES: readonly string[]` (14); `const VULN_CATEGORIES: readonly string[]` (7); `type TaxonomyEntry = { category: string; subcategory: string; description: string }`; `const FINDING_TAXONOMY: readonly TaxonomyEntry[]` (45). Taksonomi diisi lengkap di task ini; Task 8 hanya menambah validator dan test kekhususannya.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/db/client.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKg, seedReferenceTables } from "../../.opencode/plugins/knowdit/src/db/client.ts";

const fixture = JSON.parse(readFileSync("test/fixtures/schema-1.0.1.json", "utf8"));

test("applies the reference schema and seeds 14/7/45", async () => {
  const db = await openKg(join(mkdtempSync(join(tmpdir(), "kg-")), "kg.sqlite"));
  const tables = db.all<{ name: string }>(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
  ).map((r) => r.name);
  assert.deepEqual(tables, Object.keys(fixture.tables).sort());
  for (const [table, columns] of Object.entries(fixture.tables)) {
    const actual = db.all<{ name: string }>(`pragma table_info("${table}")`).map((c) => c.name);
    assert.deepEqual(actual, (columns as { name: string }[]).map((c) => c.name), table);
  }
  seedReferenceTables(db);
  seedReferenceTables(db);
  assert.equal(db.get<{ n: number }>("select count(*) n from category")!.n, 14);
  assert.equal(db.get<{ n: number }>("select count(*) n from finding_category")!.n, 45);
  assert.equal(db.get<{ n: number }>("select count(distinct category) n from finding_category")!.n, 7);
  assert.throws(() => db.run(
    "insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence) values (999, 999, 'High', 'x')",
  ));
  db.close();
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/db/client.test.ts`
Expected: FAIL — modul `client.ts` belum ada.

- [ ] **Step 3: Implementasi `client.ts`, `seed.ts`, `categories.ts`, `taxonomy.ts`**

`client.ts` memilih driver: coba `await import("bun:sqlite")`, lalu `await import("node:sqlite")`, lalu subprocess `sqlite3`; bila ketiganya gagal, lempar `Error("knowdit: no SQLite driver available (tried bun:sqlite, node:sqlite, sqlite3)")`. `openKg` membuka koneksi, menjalankan `PRAGMA foreign_keys=ON`, `PRAGMA journal_mode=WAL`, lalu `exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"))`. Catatan binding: `node:sqlite` mengembalikan `lastInsertRowid` sebagai `bigint`, jadi adapter harus mengubahnya ke `number`; `tx` memakai `BEGIN`/`COMMIT`/`ROLLBACK` pada satu koneksi dan tidak mendukung nesting.

`seed.ts` mengisi `category.name` dari `DEFI_CATEGORIES` dengan `insert or ignore` (kolomnya `UNIQUE`), lalu `finding_category(category, name, description)` dari `FINDING_TAXONOMY`. `finding_category` **tidak punya** constraint unik, jadi seed subkategori harus idempoten dengan `select 1 where exists` per `(category, name)` atau dengan membandingkan jumlah baris sebelum menyisipkan — `insert or ignore` saja akan menggandakan baris pada pemanggilan kedua.

`taxonomy.ts` memuat 45 entri yang disalin **verbatim** dari `crates/knowdit-kg/src/vulnerability.rs` (`FINDING_TAXONOMY`), beserta `DEFI_CATEGORIES` dan `VULN_CATEGORIES` dari `crates/knowdit-kg-model/src/category.rs` dan `finding_category.rs`.

`test/helpers/db.ts` mengekspor `tempDb(): Promise<{ db: KgDb; path: string; cleanup: () => void }>` — membuat file sementara lewat `mkdtempSync`, memanggil `openKg` + `seedReferenceTables`, dan dipakai ulang oleh semua test pipeline. `schema.sql` hasil `.schema` memakai `CREATE TABLE IF NOT EXISTS`, jadi aman dijalankan pada DB baru maupun yang sudah ada.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/db/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/db .opencode/plugins/knowdit/src/domain test/db/client.test.ts
git commit -m "feat: add sqlite adapter, schema bootstrap, and taxonomy seeds"
```

---

### Task 4: Model dataset, eligibility, dan pemetaan ID

**Files:**
- Create: `.opencode/plugins/knowdit/src/dataset/types.ts`
- Create: `.opencode/plugins/knowdit/src/dataset/select.ts`
- Test: `test/dataset/select.test.ts`

**Interfaces:**
- Consumes: tidak ada.
- Produces: `type ContestRef = { localId: number; c4Id: number | null; slug: string; title: string; repoDir: string; reportPath: string | null }`; `type Selection = { selected: ContestRef[]; excluded: { localId: number; reason: string }[] }`; `readContests(sourceRoot: string): ContestRef[]`; `selectContests(all: ContestRef[], localIds: readonly number[]): Selection`; `const BATCH_LOCAL_IDS: readonly number[]`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/dataset/select.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContests, selectContests, BATCH_LOCAL_IDS } from "../../.opencode/plugins/knowdit/src/dataset/select.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ds-"));
  mkdirSync(join(root, "audits"), { recursive: true });
  writeFileSync(join(root, "audits", "1.json"), JSON.stringify({ contestId: 1, title: "2022-01-insure" }));
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", "1.md"), '---\nslug: "2022-01-insure"\ncontest: 71\n---\n# Overview\nx\n# High Risk Findings (1)\n## [H-01] h\n');
  mkdirSync(join(root, "contracts", "1", "src"), { recursive: true });
  writeFileSync(join(root, "contracts", "1", "src", "A.sol"), "contract A {}\n");
  return root;
}

test("maps local id to the real C4 contest id from report frontmatter", () => {
  const all = readContests(fixture());
  assert.equal(all[0].c4Id, 71);
  assert.equal(selectContests(all, [1]).selected[0].slug, "2022-01-insure");
});

test("excludes a contest without report and explains why", () => {
  const root = fixture();
  writeFileSync(join(root, "audits", "2.json"), JSON.stringify({ contestId: 2, title: "x" }));
  const sel = selectContests(readContests(root), [1, 2]);
  assert.deepEqual(sel.excluded, [{ localId: 2, reason: "no report" }]);
});

test("excludes a contest whose report has no High finding", () => {
  const root = fixture();
  writeFileSync(join(root, "reports", "1.md"), '---\ncontest: 71\nslug: "2022-01-insure"\n---\n# Overview\nx\n# Medium Risk Findings (1)\n## [M-01] y\n');
  assert.deepEqual(selectContests(readContests(root), [1]).excluded, [{ localId: 1, reason: "no high finding" }]);
});

test("batch is the 12 approved contests", () => {
  assert.deepEqual([...BATCH_LOCAL_IDS], [110, 33, 40, 32, 23, 12, 65, 54, 34, 57, 96, 64]);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/dataset/select.test.ts`
Expected: FAIL — modul belum ada.

- [ ] **Step 3: Implementasi `types.ts` dan `select.ts`**

`readContests` membaca `audits/*.json`, `reports/<id>.md`, `contracts/<id>/`; `c4Id` diparse dari frontmatter `contest:` (integer) atau `null`. `selectContests` mengecualikan dengan alasan berurutan: `"no report"`, `"no solidity source"`, `"template contest"` (slug `2022-01-dev-test-repo`), `"no high finding"` (tidak ada heading `[H-nn]`, sesuai G-A). `BATCH_LOCAL_IDS` berisi 12 id di atas. Urutan hasil mengikuti `localIds`, bukan urutan filesystem.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/dataset/select.test.ts`
Expected: PASS, 4 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/dataset test/dataset/select.test.ts
git commit -m "feat: select eligible contests and remap to real C4 ids"
```

---

### Task 5: Pemangkas report

**Files:**
- Create: `.opencode/plugins/knowdit/src/dataset/trim.ts`
- Test: `test/dataset/trim.test.ts`

**Interfaces:**
- Consumes: tidak ada.
- Produces: `type TrimResult = { text: string; keptSections: string[]; droppedSections: string[]; fallback: boolean }`; `trimReport(markdown: string): TrimResult`; `const KEPT_SECTIONS: readonly string[]`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/dataset/trim.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { trimReport } from "../../.opencode/plugins/knowdit/src/dataset/trim.ts";

const doc = `---
slug: "x"
contest: 1
---
# Overview
ov
# Scope
sc
# High Risk Findings (1)
## [H-01] bad
h
# Medium Risk Findings (1)
## [M-01] meh
m
# Low Risk and Non-Critical Issues
## [L-01] low
l
# Gas Optimizations
gas
# Disclosures
disc
`;

test("keeps overview, scope, H/M, and the combined low section", () => {
  const r = trimReport(doc);
  assert.equal(r.fallback, false);
  for (const s of ["# Overview", "# Scope", "# High Risk Findings (1)", "# Medium Risk Findings (1)", "# Low Risk and Non-Critical Issues"]) assert.ok(r.text.includes(s));
  assert.ok(!r.text.includes("# Gas Optimizations"));
  assert.deepEqual(r.droppedSections, ["Gas Optimizations", "Disclosures"]);
  assert.ok(r.text.startsWith("---"));
});

test("keeps split low and non-critical sections", () => {
  const split = doc.replace("# Low Risk and Non-Critical Issues", "# Low Risk Findings (2)").concat("\n# Non-Critical Findings (1)\nnc\n");
  const r = trimReport(split);
  assert.ok(r.text.includes("# Low Risk Findings (2)"));
  assert.ok(r.text.includes("# Non-Critical Findings (1)"));
});

test("falls back to the full report when no High/Medium section exists", () => {
  const r = trimReport("# Overview\nx\n# Gas Optimizations\ny\n");
  assert.equal(r.fallback, true);
  assert.equal(r.text.trim(), "# Overview\nx\n# Gas Optimizations\ny".trim());
});

test("is idempotent", () => {
  const once = trimReport(doc).text;
  assert.equal(trimReport(once).text, once);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/dataset/trim.test.ts`
Expected: FAIL — modul belum ada.

- [ ] **Step 3: Implementasi `trim.ts`**

Pecah pada heading level-1 (`^# `), normalkan nama section dengan membuang akhiran ` (N)`. `KEPT_SECTIONS` = `["Overview", "Scope", "High Risk Findings", "Medium Risk Findings", "Low Risk Findings", "Low Risk and Non-Critical Issues", "Non-Critical Findings"]`. Frontmatter dipertahankan apa adanya. `fallback = true` bila tidak ada section yang dimulai `High Risk Findings` atau `Medium Risk Findings`, dan dalam kasus itu `text` = input asli.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/dataset/trim.test.ts`
Expected: PASS, 4 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/dataset/trim.ts test/dataset/trim.test.ts
git commit -m "feat: trim C4 reports to auditable H/M/L sections"
```

---

### Task 6: Snapshot source dan penulisan manifest

**Files:**
- Create: `.opencode/plugins/knowdit/src/dataset/snapshot.ts`
- Test: `test/dataset/snapshot.test.ts`

**Interfaces:**
- Consumes: `ContestRef` dari Task 4.
- Produces:
  - `const VENDORED_EXCLUDES: readonly string[]` (42 pola); `isExcluded(relativePath: string): boolean`.
  - `type SnapshotFile = { path: string; bytes: number; sha256: string; origin: string }`; `writeSnapshot(contest: ContestRef, outDir: string): Promise<{ files: SnapshotFile[]; coreLoc: number }>`.
  - `type ManifestReport = { path: string; sha256: string; originalChars: number; trimmedChars: number; tokensEst: number; keptSections: string[]; droppedSections: string[]; trimFallback: boolean }`.
  - `type ManifestContest = { localId: number; c4Id: number; slug: string; title: string; coreLoc: number; sourceFiles: string[]; report: ManifestReport | null; expected: { high: number; medium: number } }`.
  - `type Manifest = { schemaVersion: 1; generatedAt: string; sourceRoot: string; contests: ManifestContest[]; excluded: { localId: number; reason: string }[] }`.
  - `writeManifest(path: string, manifest: Manifest): void`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/dataset/snapshot.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDORED_EXCLUDES, isExcluded, writeSnapshot } from "../../.opencode/plugins/knowdit/src/dataset/snapshot.ts";

test("has the 42 vendored exclude patterns", () => {
  assert.equal(VENDORED_EXCLUDES.length, 42);
  assert.equal(isExcluded("lib/forge-std/src/Test.sol"), true);
  assert.equal(isExcluded("node_modules/pkg/A.sol"), true);
  assert.equal(isExcluded("src/vendor/A.sol"), true);
  assert.equal(isExcluded("test/ATest.sol"), true);
  assert.equal(isExcluded("src/A.sol"), false);
});

test("copies only core solidity files and records hashes", async () => {
  const src = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(src, "src"), { recursive: true });
  mkdirSync(join(src, "lib", "dep"), { recursive: true });
  writeFileSync(join(src, "src", "A.sol"), "contract A {}\n");
  writeFileSync(join(src, "lib", "dep", "B.sol"), "contract B {}\n");
  const out = mkdtempSync(join(tmpdir(), "snap-"));
  const r = await writeSnapshot(
    { localId: 7, c4Id: 229, slug: "s", title: "t", repoDir: src, reportPath: null },
    out,
  );
  assert.deepEqual(r.files.map((f) => f.path), ["src/A.sol"]);
  assert.equal(r.coreLoc, 1);
  assert.equal(r.files[0].bytes, 14);
  assert.equal(r.files[0].origin, "src/A.sol");
  assert.equal(readFileSync(join(out, "src", "A.sol"), "utf8"), "contract A {}\n");
  assert.equal(r.files[0].sha256.length, 64);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/dataset/snapshot.test.ts`
Expected: FAIL — modul belum ada.

- [ ] **Step 3: Implementasi `snapshot.ts`**

`VENDORED_EXCLUDES` disalin persis dari `DEFAULT_VENDORED_EXCLUDES` di `crates/knowdit-project/src/data.rs` (42 entri). `isExcluded` mencocokkan setiap segmen path terhadap nama direktori pola (tanpa `**`), plus kasus `src/vendor`. `writeSnapshot` berjalan rekursif, melewati `.git`, menyalin file `.sol` yang lolos filter, menghitung `sha256`, dan menghitung `coreLoc` dengan menghitung baris. Penulisan file memakai `mkdir -p` + `copyFile`.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/dataset/snapshot.test.ts`
Expected: PASS, 2 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/dataset/snapshot.ts test/dataset/snapshot.test.ts
git commit -m "feat: snapshot core solidity sources with the knowdit exclude set"
```

---

### Task 7: Handler `dataset_prepare`

**Files:**
- Create: `.opencode/plugins/knowdit/src/dataset/prepare.ts`
- Modify: `.opencode/plugins/knowdit/src/tools/handlers.ts`
- Test: `test/dataset/prepare.test.ts`

**Interfaces:**
- Consumes: `readContests`, `selectContests` (Task 4), `trimReport` (Task 5), `writeSnapshot`, `writeManifest` (Task 6).
- Produces: `prepareDataset(opts: { sourceRoot: string; dataDir: string; localIds: readonly number[] }): Promise<Manifest>`; handler `dataset_prepare` menerima `{ sourceRoot?: string; localIds?: number[] }`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/dataset/prepare.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDataset } from "../../.opencode/plugins/knowdit/src/dataset/prepare.ts";

test("writes manifest, snapshot, id map, and trimmed report", async () => {
  const src = mkdtempSync(join(tmpdir(), "src-"));
  mkdirSync(join(src, "audits"), { recursive: true });
  mkdirSync(join(src, "reports"), { recursive: true });
  mkdirSync(join(src, "contracts", "1", "src"), { recursive: true });
  writeFileSync(join(src, "audits", "1.json"), JSON.stringify({ contestId: 1, title: "2022-01-insure" }));
  writeFileSync(join(src, "reports", "1.md"), '---\ncontest: 71\nslug: "2022-01-insure"\n---\n# Overview\no\n# High Risk Findings (1)\n## [H-01] x\n# Gas Optimizations\ng\n');
  writeFileSync(join(src, "contracts", "1", "src", "A.sol"), "contract A {}\n");
  const data = mkdtempSync(join(tmpdir(), "data-"));
  const m = await prepareDataset({ sourceRoot: src, dataDir: data, localIds: [1] });
  assert.equal(m.contests.length, 1);
  assert.equal(m.contests[0].c4Id, 71);
  assert.equal(m.contests[0].expected.high, 1);
  assert.equal(m.contests[0].report.trimFallback, false);
  assert.ok(!readFileSync(join(data, "dataset", "reports", "71.md"), "utf8").includes("# Gas Optimizations"));
  assert.ok(readFileSync(join(data, "dataset", "manifest.json"), "utf8").includes('"c4Id": 71'));
  assert.ok(readFileSync(join(data, "dataset", "id_map.json"), "utf8").includes('"71"'));
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/dataset/prepare.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `prepareDataset` dan handler**

Alur: `readContests` → `selectContests` → untuk tiap kontes `writeSnapshot` ke `dataDir/dataset/contracts/<c4Id>` → `trimReport` → tulis `dataDir/dataset/reports/<c4Id>.md` → hitung `expected.high`/`medium` dengan `^#{1,4}\s*\[\[?[HM]-` (unik per marker) → tulis `manifest.json` dan `id_map.json` (kunci `String(c4Id)`). Handler `dataset_prepare` memakai `sourceRoot` default `~/c4-data/out_train` dan `localIds` default `BATCH_LOCAL_IDS`; hasilnya JSON ringkas (jumlah kontes, LOC, token estimasi).

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/dataset/prepare.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/dataset/prepare.ts .opencode/plugins/knowdit/src/tools/handlers.ts test/dataset/prepare.test.ts
git commit -m "feat: prepare reproducible dataset snapshot and manifest"
```

---

### Task 8: Validator domain (taksonomi, severity, kategori)

**Files:**
- Modify: `.opencode/plugins/knowdit/src/domain/taxonomy.ts`
- Create: `.opencode/plugins/knowdit/src/domain/validate.ts`
- Test: `test/domain/validate.test.ts`

**Interfaces:**
- Consumes: `FINDING_TAXONOMY`, `DEFI_CATEGORIES`, `VULN_CATEGORIES` (Task 3).
- Produces: `type Severity = "High" | "Medium" | "Low"`; `validateTaxonomyPair(category: string, subcategory: string): string | null` (null = valid; string = pesan error); `isDefiCategory(value: string): boolean`; `isSeverity(value: string): value is Severity`; `maxSeverity(a: Severity, b: Severity): Severity`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/domain/validate.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { validateTaxonomyPair, isDefiCategory, isSeverity, maxSeverity } from "../../.opencode/plugins/knowdit/src/domain/validate.ts";
import { FINDING_TAXONOMY, DEFI_CATEGORIES, VULN_CATEGORIES } from "../../.opencode/plugins/knowdit/src/domain/taxonomy.ts";

test("taxonomy has 14 / 7 / 45 entries", () => {
  assert.equal(DEFI_CATEGORIES.length, 14);
  assert.equal(VULN_CATEGORIES.length, 7);
  assert.equal(FINDING_TAXONOMY.length, 45);
  assert.equal(new Set(FINDING_TAXONOMY.map((e) => `${e.category}\u0000${e.subcategory}`)).size, 45);
});

test("accepts a known pair and rejects an invented one", () => {
  assert.equal(validateTaxonomyPair("Arithmetic", FINDING_TAXONOMY.find((e) => e.category === "Arithmetic")!.subcategory), null);
  assert.match(validateTaxonomyPair("Arithmetic", "Not A Real Subcategory")!, /unknown subcategory/i);
});

test("severity helpers", () => {
  assert.equal(isSeverity("High"), true);
  assert.equal(isSeverity("Critical"), false);
  assert.equal(maxSeverity("Low", "High"), "High");
  assert.equal(isDefiCategory("Dexes"), true);
  assert.equal(isDefiCategory("Gaming"), false);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/domain/validate.test.ts`
Expected: FAIL — modul `validate.ts` belum ada.

- [ ] **Step 3: Implementasi `validate.ts`**

Cocokkan `subcategory` secara case-sensitive setelah `trim()`; pesan error menyebut kategori dan subkategori. `maxSeverity` memakai peringkat High=3, Medium=2, Low=1 (sama dengan `FindingSeverity::rank`).

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/domain/validate.test.ts`
Expected: PASS, 3 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/domain test/domain/validate.test.ts
git commit -m "feat: port taxonomy and domain validators"
```

---

### Task 9: Port prompt

**Files:**
- Create: `.opencode/plugins/knowdit/src/prompts/index.ts`
- Create: `test/fixtures/prompts/*.golden.txt`
- Test: `test/prompts/prompts.test.ts`

**Interfaces:**
- Consumes: `DEFI_CATEGORIES`, `FINDING_TAXONOMY`.
- Produces: `GENERAL_ROLE_SYSTEM: string`; `buildCategorizePrompt(categories: readonly string[]): string`; `buildExtractSemanticsPrompt(input: { chunk: string; schemaHint: string; categories: readonly string[] }): string`; `buildExtractFindingsPrompt(input: { chunk: string; schemaHint: string; categories: readonly string[] }): string`; `buildInProjectLinkPrompt(input: { categories: readonly string[]; semantics: string; findings: string }): string`; `buildMergePrompt(...)`; `buildGlobalLinkPrompt(...)`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/prompts/prompts.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GENERAL_ROLE_SYSTEM, buildExtractFindingsPrompt } from "../../.opencode/plugins/knowdit/src/prompts/index.ts";

test("role system prompt is the Rust text", () => {
  assert.equal(GENERAL_ROLE_SYSTEM, "You are an expert DeFi knowledge engineer and senior smart contract analyst.\nFollow the user's instructions exactly.\nUse canonical, project-agnostic DeFi terminology.\nWhen the user requests JSON, return strict JSON only.");
});

test("finding prompt carries chunk, schema hint, and JSON-only rule", () => {
  const p = buildExtractFindingsPrompt({ chunk: "REPORT-BODY", schemaHint: "SCHEMA", categories: ["Lending"] });
  assert.ok(p.includes("REPORT-BODY"));
  assert.ok(p.includes("SCHEMA"));
  assert.ok(p.includes("Lending"));
  assert.match(p, /strict JSON/i);
});

test("golden prompt matches", () => {
  const golden = readFileSync("test/fixtures/prompts/findings.golden.txt", "utf8");
  assert.equal(buildExtractFindingsPrompt({ chunk: "CHUNK", schemaHint: "SCHEMA", categories: ["Lending"] }), golden);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/prompts/prompts.test.ts`
Expected: FAIL.

- [ ] **Step 3: Port prompt dari `crates/knowdit-kg/src/prompts.rs`**

Salin teks verbatim: `GENERAL_ROLE_SYSTEM`, definisi 14 kategori, definisi severity, taksonomi (dari `FINDING_TAXONOMY`), aturan ekstraksi semantic/finding, aturan in-project link, aturan merge, dan rubrik `LinkStrength`. Adaptasi yang diizinkan hanya: (a) `GENERAL_ROLE_SYSTEM` digabung di awal prompt, (b) instruksi "return one JSON object matching this schema" + `schemaHint`, (c) tidak ada parameter system terpisah.

- [ ] **Step 4: Buat golden file lalu jalankan test**

Buat `test/fixtures/prompts/findings.golden.txt` dari output fungsi setelah direview manual, lalu:
Run: `node --test test/prompts/prompts.test.ts`
Expected: PASS, 3 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/prompts test/fixtures/prompts test/prompts
git commit -m "feat: port knowdit prompts and pin them with goldens"
```

---

### Task 10: `LlmCaller` — JSON, retry, cache, estimasi biaya

**Files:**
- Create: `.opencode/plugins/knowdit/src/llm/types.ts`
- Create: `.opencode/plugins/knowdit/src/llm/json.ts`
- Create: `.opencode/plugins/knowdit/src/llm/cache.ts`
- Create: `.opencode/plugins/knowdit/src/llm/caller.ts`
- Test: `test/llm/caller.test.ts`

**Interfaces:**
- Consumes: tidak ada.
- Produces: `type ModelRef = { providerID: string; id: string }`; `type GenerateFn = (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>`; `type LlmCache = { get(key: string): string | undefined; set(key: string, value: string): void }`; `fileCache(dir: string): LlmCache`; `cacheKey(input: { prompt: string; model?: ModelRef }): string`; `extractJson(text: string): unknown`; `class JsonTruncatedError extends Error`; `type LlmCaller = { json<T>(input: { prompt: string; validate: (value: unknown) => T; key?: string }): Promise<{ value: T; tokensEst: number; costEst: number }> }`; `createLlmCaller(opts: { generate: GenerateFn; cache: LlmCache; model?: ModelRef; maxAttempts: number; cost?: { input: number; output: number } }): LlmCaller`.

  Implementasi produksi `GenerateFn` adalah `createSessionGenerate` dari Task 1; semua test di task ini memakai generate palsu, jadi tidak ada panggilan model nyata.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/llm/caller.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlmCaller } from "../../.opencode/plugins/knowdit/src/llm/caller.ts";
import { cacheKey, fileCache } from "../../.opencode/plugins/knowdit/src/llm/cache.ts";
import { extractJson, JsonTruncatedError } from "../../.opencode/plugins/knowdit/src/llm/json.ts";

const ok = <T extends object>(expected: T) => (v: unknown): T => {
  if (typeof v !== "object" || v === null) throw new Error("bad shape");
  for (const key of Object.keys(expected)) {
    if (!(key in v)) throw new Error("bad shape");
  }
  return v as T;
};
const reject = (_v: unknown): never => {
  throw new Error("bad shape");
};

test("extracts fenced and bare json", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("reports truncation distinctly", () => {
  assert.throws(() => extractJson('{"a": [1, 2'), JsonTruncatedError);
});

test("retries validation failures and then succeeds", async () => {
  let calls = 0;
  const caller = createLlmCaller({
    generate: async () => ({ text: ++calls === 1 ? '{"bad":true}' : '{"a":1}' }),
    cache: new Map(),
    maxAttempts: 3,
  });
  const r = await caller.json({ key: "k", prompt: "p", validate: ok({ a: 1 }) });
  assert.deepEqual(r.value, { a: 1 });
  assert.equal(calls, 2);
});

test("fails after maxAttempts with the last error", async () => {
  const caller = createLlmCaller({
    generate: async () => ({ text: '{"bad":true}' }),
    cache: new Map(),
    maxAttempts: 3,
  });
  await assert.rejects(() => caller.json({ key: "k", prompt: "p", validate: reject }), /bad shape/);
});

test("cache hit avoids a second model call", async () => {
  let calls = 0;
  const cache = new Map<string, string>();
  const caller = createLlmCaller({
    generate: async () => { calls += 1; return { text: '{"a":1}' }; },
    cache,
    maxAttempts: 3,
  });
  await caller.json({ key: "same", prompt: "p", validate: ok({ a: 1 }) });
  await caller.json({ key: "same", prompt: "p", validate: ok({ a: 1 }) });
  assert.equal(calls, 1);
});

test("a failed response is never cached", async () => {
  let calls = 0;
  const cache = new Map<string, string>();
  const caller = createLlmCaller({
    generate: async () => { calls += 1; return { text: '{"bad":true}' }; },
    cache,
    maxAttempts: 2,
  });
  await assert.rejects(() => caller.json({ key: "k", prompt: "p", validate: reject }));
  await assert.rejects(() => caller.json({ key: "k", prompt: "p", validate: reject }));
  assert.equal(calls, 4);
  assert.equal(cache.size, 0);
});

test("cache key is a stable sha256 over prompt and model", () => {
  assert.equal(cacheKey({ prompt: "p" }).length, 64);
  assert.equal(cacheKey({ prompt: "p" }), cacheKey({ prompt: "p" }));
  assert.notEqual(cacheKey({ prompt: "p" }), cacheKey({ prompt: "p", model: { providerID: "a", id: "b" } }));
});

test("file cache round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-"));
  fileCache(dir).set("k", "v");
  assert.equal(fileCache(dir).get("k"), "v");
});

test("cost is an estimate based on characters", async () => {
  const caller = createLlmCaller({
    generate: async () => ({ text: '{"a":1}' }),
    cache: new Map(),
    maxAttempts: 3,
    cost: { input: 3, output: 15 },
  });
  const r = await caller.json({ key: "k", prompt: "123456789012345", validate: ok({ a: 1 }) });
  assert.equal(r.tokensEst, 4);
  assert.equal(r.costEst, 4 * 3 + 2 * 15);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/llm/caller.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `json.ts`, `cache.ts`, `caller.ts`**

`extractJson`: buang pagar ```json, ambil substring dari `{` pertama ke `}` terakhir; bila brace tidak seimbang → `JsonTruncatedError`. `createLlmCaller`: kunci cache = `input.key ?? cacheKey({ prompt, model })` (sha256 hex). Cek cache dulu, validasi hasil parse; pada kegagalan, sertakan pesan error + instruksi "respond with valid JSON only" pada percobaan berikutnya; setelah `maxAttempts`, lempar error terakhir. **Hanya respons yang lolos validasi yang ditulis ke cache**; kegagalan tidak boleh meracuni cache. Estimasi token = `Math.ceil(chars / 4)`; biaya memakai tarif per token: `tokensEst * cost.input + outputTokensEst * cost.output`, dengan `outputTokensEst` dihitung dari teks respons.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/llm/caller.test.ts`
Expected: PASS, 9 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/llm test/llm
git commit -m "feat: add validated llm caller with cache and cost estimate"
```

---

### Task 11: Journal dan resume

**Files:**
- Create: `.opencode/plugins/knowdit/src/journal.ts`
- Test: `test/journal.test.ts`

**Interfaces:**
- Consumes: `openKg` (Task 3).
- Produces: `type JournalUnit = { stage: string; c4Id: number; unitIndex: number }`; `type JournalStatus = "running" | "done" | "failed" | "skipped"`; `interface Journal { start(u: JournalUnit): void; done(u: JournalUnit, extra?: { tokensEst?: number; costEst?: number; promptHash?: string; responseHash?: string }): void; fail(u: JournalUnit, error: string): void; isDone(u: JournalUnit): boolean; list(c4Id: number): { stage: string; unitIndex: number; status: JournalStatus; error: string | null }[]; skip(c4Id: number, reason: string): void; isSkipped(c4Id: number): boolean; resetContest(c4Id: number): void; resetAll(): void; close(): void }`; `openJournal(path: string): Promise<Journal>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/journal.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../.opencode/plugins/knowdit/src/journal.ts";

test("tracks lifecycle and survives reopen", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "j-")), "runs.sqlite");
  const j = await openJournal(path);
  const unit = { stage: "extract_semantics", c4Id: 110, unitIndex: 0 };
  assert.equal(j.isDone(unit), false);
  j.start(unit);
  j.done(unit, { tokensEst: 10, costEst: 1, promptHash: "p", responseHash: "r" });
  assert.equal(j.isDone(unit), true);
  j.close();
  const j2 = await openJournal(path);
  assert.equal(j2.isDone(unit), true);
  assert.equal(j2.list(110).find((r) => r.unitIndex === 0)?.status, "done");
  j2.fail({ ...unit, unitIndex: 1 }, "boom");
  assert.equal(j2.list(110).find((r) => r.unitIndex === 1)?.status, "failed");
  j2.skip(110, "operator approved skip");
  assert.equal(j2.isSkipped(110), true);
  j2.resetContest(110);
  assert.deepEqual(j2.list(110), []);
  assert.equal(j2.isSkipped(110), false);
  j2.close();
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/journal.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `journal.ts`**

Dua tabel: `unit_status(stage text, c4_id int, unit_index int, status text, attempts int, tokens_est int, cost_est real, prompt_hash text, response_hash text, error text, updated_at text, primary key(stage,c4_id,unit_index))` dan `contest_status(c4_id integer primary key, status text, reason text, updated_at text)`. `start` melakukan upsert ke `running` dan menambah `attempts`. `done` menulis `done` beserta hash/estimasi; `isDone` mengecek status `done`. `skip` menulis baris `contest_status` berstatus `skipped`; `isSkipped` membacanya. `resetContest` menghapus baris `unit_status` dan `contest_status` untuk `c4_id` itu; `resetAll` menghapus semua. Semua operasi memakai satu koneksi yang dibuka saat `openJournal`.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/journal.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/journal.ts test/journal.test.ts
git commit -m "feat: add resumable run journal"
```

---

### Task 12: Tahap 1 — kategorisasi proyek

**Files:**
- Create: `.opencode/plugins/knowdit/src/pipeline/types.ts`
- Create: `.opencode/plugins/knowdit/src/pipeline/categorize.ts`
- Create: `test/helpers/ctx.ts`
- Test: `test/pipeline/categorize.test.ts`

**Interfaces:**
- Consumes: `KgDb`, `LlmCaller`, `Journal`, `ManifestContest`.
- Produces: `type StageContext = { db: KgDb; llm: LlmCaller; journal: Journal; contest: ManifestContest; datasetDir: string }`; `categorizeProject(ctx: StageContext): Promise<{ projectId: number; categories: string[] }>`.
- Test helper (`test/helpers/ctx.ts`): `fakeCtx(script: FakeScript): Promise<{ ctx: StageContext; llm: LlmCaller & { calls: number }; prompts: string[] }>` dengan `type FakeScript = { categories?: string[]; semantics?: SemanticItem[]; findings?: FindingItem[]; links?: { findingIndex: number; semanticIndices: number[] }[]; globalLinks?: { semanticIndex: number; strength: Severity; evidence: string }[] }`. Helper membuat DB lewat `tempDb()`, journal lewat `openJournal`, direktori dataset sementara berisi `reports/229.md` dengan body `REPORT-BODY` dan `contracts/229/src/A.sol` dengan isi `SOURCE-SENTINEL`, serta `ManifestContest` dengan `c4Id: 229`, `sourceFiles: ["src/A.sol"]`. LLM palsu mencatat setiap prompt ke `prompts`, menaikkan `calls`, dan **memanggil `input.validate` pada nilai yang diskrip** sehingga validator produksi benar-benar diuji. Helper diperluas di Task 13–17 saat tipe baru muncul.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/pipeline/categorize.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { categorizeProject } from "../../.opencode/plugins/knowdit/src/pipeline/categorize.ts";

test("writes project, platform, and categories; dedupes input", async () => {
  const { ctx, prompts } = await fakeCtx({ categories: ["Dexes", "Dexes", "Lending"] });
  const r = await categorizeProject(ctx);
  assert.deepEqual(r.categories, ["Dexes", "Lending"]);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project")!.n, 1);
  assert.equal(ctx.db.get<{ status: string }>("select status from project")!.status, "completed");
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project_category")!.n, 2);
  assert.equal(ctx.db.get<{ platform_id: string }>("select platform_id from project_platform")!.platform_id, "c4-229");
  assert.ok(prompts[0].includes("src/A.sol"));
});

test("rejects an out-of-enum category and writes nothing", async () => {
  const { ctx } = await fakeCtx({ categories: ["Gaming"] });
  await assert.rejects(() => categorizeProject(ctx), /unknown DeFi category/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project")!.n, 0);
});
```

`fakeCtx` adalah helper test yang membuat DB via `openKg` + seed, journal via `openJournal`, dan `llm` yang mengembalikan `value` yang diberikan.

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/pipeline/categorize.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `pipeline/types.ts` dan `categorize.ts`**

`categorizeProject` memanggil `ctx.llm.json` dengan `buildCategorizePrompt`, mengirim daftar file (`contest.sourceFiles`, maksimum 50) dan potongan isi tiap file (maksimum 2.000 karakter per file, dari snapshot di `datasetDir/contracts/<c4Id>/`) sesuai spec §6 tahap 1. Validator memastikan array string tak kosong dan setiap nilai ada di `DEFI_CATEGORIES`, lalu dalam satu transaksi menulis `project(name = contest.slug, status = "completed")`, `project_platform(platform_id = "c4-" + c4Id)`, dan `project_category`. Bila kontes sudah ada (platform_id sama), pakai `project_id` yang ada dan ganti kategorinya.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/pipeline/categorize.test.ts`
Expected: PASS, 2 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/pipeline test/pipeline/categorize.test.ts
git commit -m "feat: categorize contests into DeFi categories"
```

---

### Task 13: Tahap 2 — ekstraksi semantic

**Files:**
- Create: `.opencode/plugins/knowdit/src/pipeline/chunk.ts`
- Create: `.opencode/plugins/knowdit/src/pipeline/extract-semantics.ts`
- Test: `test/pipeline/extract-semantics.test.ts`

**Interfaces:**
- Consumes: `StageContext` (Task 12), `validateTaxonomyPair`/`isDefiCategory` (Task 8), `buildExtractSemanticsPrompt` (Task 9).
- Produces: `chunkByBudget(text: string, budgetTokens: number): string[]`; `dedupSemantics(items: SemanticItem[]): SemanticItem[]`; `extractSemantics(ctx: StageContext): Promise<{ rawIds: number[] }>`; `type SemanticItem = { name: string; category: string; definition: string; description: string; functions: { name: string; contract: string; signature?: string }[] }`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/pipeline/extract-semantics.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dedupSemantics, extractSemantics } from "../../.opencode/plugins/knowdit/src/pipeline/extract-semantics.ts";

const sem = (name: string, over: Partial<{ description: string; functions: { name: string; contract: string }[] }> = {}) => ({
  name, category: "Dexes", definition: "d", description: over.description ?? "x",
  functions: over.functions ?? [{ name: "swap", contract: "src/A.sol" }],
});

test("dedup merges functions and keeps the longer description", () => {
  const out = dedupSemantics([
    sem("Swap", { description: "short" }),
    sem(" swap ", { description: "much longer", functions: [{ name: "swapExact", contract: "src/A.sol" }, { name: "swap", contract: "src/A.sol" }] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].description, "much longer");
  assert.equal(out[0].functions.length, 2);
});

test("persists raw node, category, functions, and provenance", async () => {
  const { ctx } = await fakeCtx({ semantics: [sem("Swap")] });
  const r = await extractSemantics(ctx);
  assert.equal(r.rawIds.length, 1);
  assert.equal(ctx.db.get<{ category: string }>("select category from semantic_node")!.category, "Dexes");
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_function")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project_semantic")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from sqlite_master where type='table' and name='semantic_node_category'")!.n, 0);
});

test("rejects a semantic with no functions or a file outside the snapshot", async () => {
  const noFunctions = await fakeCtx({ semantics: [{ ...sem("Swap"), functions: [] }] });
  await assert.rejects(() => extractSemantics(noFunctions.ctx), /at least one function/i);
  assert.equal(noFunctions.ctx.db.get<{ n: number }>("select count(*) n from semantic_node")!.n, 0);

  const badFile = await fakeCtx({ semantics: [sem("Swap", { functions: [{ name: "swap", contract: "src/Missing.sol" }] })] });
  await assert.rejects(() => extractSemantics(badFile.ctx), /not in the snapshot/i);
  assert.equal(badFile.ctx.db.get<{ n: number }>("select count(*) n from semantic_node")!.n, 0);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/pipeline/extract-semantics.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `chunk.ts` dan `extract-semantics.ts`**

`chunkByBudget` memotong pada batas baris sedekat mungkin dengan budget (`ceil(chars/4)`), tidak pernah memotong di tengah baris. `extractSemantics` mengulang chunk, memanggil LLM, memvalidasi tiap item (nama non-kosong, kategori enum, `functions.length >= 1`, `contract` ada di `manifest.sourceFiles`), menjalankan `dedupSemantics` (kunci `name.toLowerCase().trim()`, gabung functions unik, deskripsi terpanjang menang, urutan first-seen), lalu menulis semua baris raw dalam satu transaksi. Tidak ada penulisan `semantic_node_category`.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/pipeline/extract-semantics.test.ts`
Expected: PASS, 3 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/pipeline test/pipeline/extract-semantics.test.ts
git commit -m "feat: extract and dedupe project semantics"
```

---

### Task 14: Tahap 3 — ekstraksi finding

**Files:**
- Create: `.opencode/plugins/knowdit/src/pipeline/extract-findings.ts`
- Test: `test/pipeline/extract-findings.test.ts`

**Interfaces:**
- Consumes: `StageContext`, `validateTaxonomyPair`, `isSeverity`, `maxSeverity`.
- Produces: `type FindingItem = { title: string; severity: Severity; category: string; subcategory: string; root_cause: string; description: string; patterns: string; exploits: string }`; `dedupFindings(items: FindingItem[]): FindingItem[]`; `extractFindings(ctx: StageContext): Promise<{ rawIds: number[] }>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/pipeline/extract-findings.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { dedupFindings, extractFindings } from "../../.opencode/plugins/knowdit/src/pipeline/extract-findings.ts";

const finding = (over: Partial<{ title: string; severity: "High" | "Medium" | "Low"; description: string; root_cause: string }> = {}) => ({
  title: over.title ?? "Bad thing", severity: over.severity ?? "Medium", category: "Arithmetic",
  subcategory: "Integer Overflow", root_cause: over.root_cause ?? "rc",
  description: over.description ?? "d", patterns: "p", exploits: "e",
});

test("dedup keeps the higher severity and the longer text", () => {
  const out = dedupFindings([finding({ severity: "Medium", description: "short" }), finding({ severity: "High", description: "a much longer description", root_cause: "a longer root cause" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "High");
  assert.equal(out[0].description, "a much longer description");
  assert.equal(out[0].root_cause, "a longer root cause");
});

test("persists raw finding, taxonomy, and provenance", async () => {
  const { ctx } = await fakeCtx({ findings: [finding()] });
  await extractFindings(ctx);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding_category")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project_finding")!.n, 1);
});

test("rejects an unknown taxonomy pair and writes nothing", async () => {
  const { ctx } = await fakeCtx({ findings: [{ ...finding(), subcategory: "Nope" }] });
  await assert.rejects(() => extractFindings(ctx), /unknown subcategory/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding")!.n, 0);
});

test("prompt carries the trimmed report and no contract source", async () => {
  const { ctx, prompts } = await fakeCtx({ findings: [finding()] });
  await extractFindings(ctx);
  assert.ok(prompts.every((p) => p.includes("REPORT-BODY")));
  assert.ok(prompts.every((p) => !p.includes("SOURCE-SENTINEL")));
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/pipeline/extract-findings.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `extract-findings.ts`**

Prompt menerima **hanya** report terpangkas (baca `datasetDir/reports/<c4Id>.md`), di-chunk. `dedupFindings` meniru Rust: kunci `title.toLowerCase().trim()`; severity = max; kategori/subcategory/description diambil dari entri dengan `description` terpanjang; `root_cause`, `patterns`, `exploits` masing-masing diganti bila lebih panjang. Trim semua field teks sebelum validasi. Tulis `audit_finding`, `audit_finding_category`, `project_finding` dalam satu transaksi.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/pipeline/extract-findings.test.ts`
Expected: PASS, 4 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/pipeline/extract-findings.ts test/pipeline/extract-findings.test.ts
git commit -m "feat: extract and dedupe audit findings from reports"
```

---

### Task 15: Tahap 4 — in-project link

**Files:**
- Create: `.opencode/plugins/knowdit/src/pipeline/link-in-project.ts`
- Create: `.opencode/plugins/knowdit/src/pipeline/evidence.ts`
- Test: `test/pipeline/link-in-project.test.ts`

**Interfaces:**
- Consumes: `StageContext`, `buildInProjectLinkPrompt`.
- Produces: `const IN_PROJECT_LINK_EVIDENCE_PREFIX: string`; `inProjectEvidence(): string`; `linkInProject(ctx: StageContext): Promise<{ edges: number }>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/pipeline/link-in-project.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { linkInProject, inProjectEvidence, IN_PROJECT_LINK_EVIDENCE_PREFIX } from "../../.opencode/plugins/knowdit/src/pipeline/link-in-project.ts";

test("writes one High edge per pair with the exact synthetic evidence", async () => {
  const { ctx } = await seededCtx({ semantics: 2, findings: 2, links: [[0, [0, 1]], [1, [1]]] });
  const r = await linkInProject(ctx);
  assert.equal(r.edges, 3);
  const rows = ctx.db.all<{ strength: string; evidence: string }>("select strength, evidence from semantic_finding_link");
  assert.ok(rows.every((x) => x.strength === "High"));
  assert.ok(rows.every((x) => x.evidence === inProjectEvidence()));
  assert.ok(inProjectEvidence().startsWith(IN_PROJECT_LINK_EVIDENCE_PREFIX));
});

test("retries when a finding is omitted, and persists nothing on final failure", async () => {
  const { ctx, llm } = await seededCtx({ semantics: 2, findings: 2, links: [[0, [0]]] });
  await assert.rejects(() => linkInProject(ctx), /left finding/i);
  assert.equal(llm.calls, 3);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 0);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/pipeline/link-in-project.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `evidence.ts` dan `link-in-project.ts`**

`IN_PROJECT_LINK_EVIDENCE_PREFIX = "in-project link: finding and semantic co-emitted by the extract pipeline"`; `inProjectEvidence()` mengembalikan prefix + `" against the same project; finding instantiates the semantic in its originating codebase"`. `linkInProject` hanya menerima pasangan indeks; memvalidasi setiap indeks finding muncul ≥1 kali dan semua indeks valid; `strength` selalu `"High"`; evidence dari `inProjectEvidence()`. Tulis setelah validasi lengkap dalam satu transaksi.

Helper lokal `seededCtx({ semantics: number; findings: number; links: [findingIndex, semanticIndices[]][] })` menyiapkan `StageContext` dengan baris `semantic_node`/`audit_finding` mentah (tanpa link), dan LLM palsu yang mengembalikan `{ pairs: [...] }` dari `links` serta menaikkan `llm.calls`.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/pipeline/link-in-project.test.ts`
Expected: PASS, 2 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/pipeline test/pipeline/link-in-project.test.ts
git commit -m "feat: persist in-project links with the reference evidence prefix"
```

---

### Task 16: Tahap 5 — merge lintas proyek

**Files:**
- Create: `.opencode/plugins/knowdit/src/pipeline/merge.ts`
- Test: `test/pipeline/merge.test.ts`

**Interfaces:**
- Consumes: `StageContext`, `buildMergePrompt`, `maxSeverity`.
- Produces: `type SemanticMergeDecision = { action: "new" } | { action: "merge"; targetIds: number[]; updatedDescription?: string; appendedDescription?: string }`; `type FindingMergeDecision = { action: "new" } | { action: "merge"; targetIds: number[]; updatedDescription?: string; updatedPatterns?: string; updatedExploits?: string; appendedDescription?: string; appendedPatterns?: string; appendedExploits?: string }`; `applySemanticMerge(db, rawId, decision): void`; `applyFindingMerge(db, rawId, decision): void`; `mergeContest(ctx): Promise<{ semanticEdges: number; findingEdges: number }>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/pipeline/merge.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { applySemanticMerge, applyFindingMerge } from "../../.opencode/plugins/knowdit/src/pipeline/merge.ts";

test("semantic merge keeps identity frozen and grows canonical provenance", async () => {
  const { db, rawId, canonicalId, projectId } = await seededSemantic();
  applySemanticMerge(db, rawId, { action: "merge", targetIds: [canonicalId], updatedDescription: "new desc", appendedDescription: "note" });
  const c = db.get<{ name: string; definition: string; description: string }>("select name, definition, description from semantic_node where id = ?", [canonicalId])!;
  assert.equal(c.name, "Canonical");
  assert.equal(c.definition, "def");
  assert.equal(c.description, "new desc");
  assert.equal(db.get<{ n: number }>("select count(*) n from semantic_merge")!.n, 1);
  assert.equal(db.get<{ n: number }>("select count(*) n from project_semantic where project_id = ? and semantic_node_id = ?", [projectId, canonicalId])!.n, 1);
});

test("merge without an appended note is rejected", async () => {
  const { db, rawId, canonicalId } = await seededSemantic();
  assert.throws(() => applySemanticMerge(db, rawId, { action: "merge", targetIds: [canonicalId] }), /appended note is required/i);
});

test("finding merge refuses identity fields and accepts multi-target", async () => {
  const { db, rawId, canonicalIds, projectId } = await seededFinding();
  assert.throws(
    () => applyFindingMerge(db, rawId, { action: "merge", targetIds: [canonicalIds[0]], appendedDescription: "n", updatedDescription: "d", updatedPatterns: "p", updatedExploits: "e", title: "changed" } as never),
    /identity/i,
  );
  applyFindingMerge(db, rawId, { action: "merge", targetIds: canonicalIds, appendedDescription: "n" });
  assert.equal(db.get<{ n: number }>("select count(*) n from finding_merge")!.n, 2);
  assert.equal(db.get<{ n: number }>("select count(*) n from project_finding where project_id = ? and audit_finding_id in (?, ?)", [projectId, ...canonicalIds])!.n, 2);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/pipeline/merge.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `merge.ts`**

Aturan yang ditegakkan sebelum menulis: `targetIds` tidak kosong; setiap target ada, canonical (tidak punya outgoing edge di `semantic_merge`/`finding_merge`), dan bukan `rawId`; `appendedDescription` wajib untuk semantic merge dan minimal satu `appended*` wajib untuk finding merge; objek decision yang memuat field identitas (`name`, `definition`, `title`, `severity`, `root_cause`) ditolak. Multi-target menulis satu baris `semantic_merge`/`finding_merge` per target. Update canonical hanya untuk field `updated*` yang non-blank. Seperti Rust, tambahkan edge provenance `project_semantic`/`project_finding` ke setiap target canonical bila belum ada. **Jangan menulis `merge_status`** — tabel itu untuk merge antar-KG, bukan merge node.

Catatan deviasi: Rust menyimpan `appended_*` kosong bila agen tidak memberikannya; validasi "wajib ada catatan" adalah aturan lapisan kita yang lebih ketat sesuai spec §6, bukan perilaku Rust.

Helper lokal: `seededSemantic()` mengembalikan `{ db, rawId, canonicalId, projectId }` dengan satu raw + satu canonical (nama/definisi berbeda) dan edge `project_semantic` hanya untuk raw; `seededFinding()` mengembalikan `{ db, rawId, canonicalIds, projectId }` dengan satu raw + dua canonical dan edge `project_finding` hanya untuk raw.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/pipeline/merge.test.ts`
Expected: PASS, 3 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/pipeline/merge.ts test/pipeline/merge.test.ts
git commit -m "feat: apply guarded cross-project merges"
```

---

### Task 17: Tahap 6 — global link

**Files:**
- Create: `.opencode/plugins/knowdit/src/pipeline/link-global.ts`
- Test: `test/pipeline/link-global.test.ts`

**Interfaces:**
- Consumes: `KgDb`, `LlmCaller`, `Journal`.
- Produces: `countVerbatimWords(findingText: string, evidence: string): number`; `linkGlobal(opts: { db: KgDb; llm: LlmCaller; journal: Journal; c4Ids?: number[] }): Promise<{ linked: number; pendingQueued: number; pendingDrained: number }>`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/pipeline/link-global.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { countVerbatimWords } from "../../.opencode/plugins/knowdit/src/pipeline/link-global.ts";

test("counts the longest run of verbatim words", () => {
  assert.equal(countVerbatimWords("the pool drains because shares are minted twice", "shares are minted twice in a loop"), 4);
  assert.equal(countVerbatimWords("completely different words here", "nothing matches at all"), 0);
});

test("retries a High link with paraphrased evidence and accepts the corrected response", async () => {
  const { ctx, llm } = await seededGlobalCtx(
    [{ semanticIndex: 0, strength: "High", evidence: "paraphrase without the words" }],
    { retryLinks: [{ semanticIndex: 0, strength: "High", evidence: "shares are minted twice in a loop" }] },
  );
  const r = await linkGlobal(ctx);
  assert.equal(r.linked, 1);
  assert.equal(llm.calls, 2);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link where strength = 'High'")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, 1);
});

test("caps links at two per finding", async () => {
  const { ctx } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Medium", evidence: "a" },
    { semanticIndex: 1, strength: "Medium", evidence: "b" },
    { semanticIndex: 2, strength: "Medium", evidence: "c" },
  ]);
  await linkGlobal(ctx);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 2);
});

test("drains pending semantics that the retry pass already covers", async () => {
  const { ctx } = await seededGlobalCtx(
    [{ semanticIndex: 0, strength: "Medium", evidence: "a" }],
    { pending: true },
  );
  const r = await linkGlobal(ctx);
  assert.equal(r.pendingDrained, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from pending_semantic")!.n, 0);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/pipeline/link-global.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `link-global.ts`**

`countVerbatimWords` mencari run kata berurutan terpanjang dari evidence yang muncul verbatim (case-insensitive, abaikan tanda baca) di teks finding (title + root_cause + description + patterns + exploits). Setiap `strength === "High"` wajib ≥6; bila satu saja gagal, **seluruh decision finding itu ditolak** dan finding di-retry (maksimum 3) dengan prompt yang sama ditambah pesan error validasi — meniru handler tool Rust yang mengembalikan pesan error untuk re-emit. Bila percobaan terakhir masih memuat entri tidak valid, finding dilewati dan `finding_link_status` **tidak** ditulis (agar bisa di-retry di run berikutnya). Maksimum 2 link, ambil yang pertama. Tulis link canonical + `finding_link_status` per finding. Di awal run, baris `pending_semantic` yang semantic-nya termasuk kandidat canonical dikuras dan dihitung `pendingDrained` — efek retro-link dicapai karena pass per-finding mengulang semua finding yang belum punya status. Item yang benar-benar muncul setelah finding selesai ditautkan tetap masuk `pending_semantic` dan dikuras pada run berikutnya.

Helper lokal `seededGlobalCtx(links, opts?)` menyiapkan DB dengan satu `audit_finding` yang belum punya `finding_link_status`, satu `semantic_node` canonical per entri `links`, dan (bila `opts.pending`) satu baris `pending_semantic` untuk semantic indeks 0. LLM palsu mengembalikan `{ links }` pada panggilan pertama dan `{ links: opts.retryLinks }` pada panggilan berikutnya, sambil menaikkan `llm.calls`. Teks finding memuat frasa `"shares are minted twice in a loop"` dan `"the pool drains"`.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/pipeline/link-global.test.ts`
Expected: PASS, 4 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/pipeline/link-global.ts test/pipeline/link-global.test.ts
git commit -m "feat: link findings to canonical semantics with mechanical evidence checks"
```

---

### Task 18: Tahap 7 — finalisasi dan pemeriksaan integritas

**Files:**
- Create: `.opencode/plugins/knowdit/src/pipeline/finalize.ts`
- Create: `.opencode/plugins/knowdit/src/integrity.ts`
- Test: `test/integrity.test.ts`

**Interfaces:**
- Consumes: `KgDb`.
- Produces: `type IntegrityCheck = { name: string; passed: boolean; detail?: string }`; `type IntegrityReport = { ok: boolean; checks: IntegrityCheck[] }`; `checkIntegrity(db: KgDb, opts: { requireAllLinked: boolean }): IntegrityReport`; `finalizeBuild(db: KgDb, args: { c4Ids: number[] }): IntegrityReport`.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/integrity.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { checkIntegrity } from "../.opencode/plugins/knowdit/src/integrity.ts";

test("flags a finding with a link but no link status", async () => {
  const { db } = await seededBroken();
  const r = checkIntegrity(db, { requireAllLinked: true });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "links_have_status")!.passed, false);
});

test("flags a canonical with an outgoing merge edge", async () => {
  const { db } = await seededBroken({ canonicalWithOutgoing: true });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(r.checks.find((c) => c.name === "no_canonical_outgoing_merge")!.passed, false);
});

test("flags an unknown enum value", async () => {
  const { db } = await seededBroken({ badSeverity: true });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(r.checks.find((c) => c.name === "enum_values")!.passed, false);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/integrity.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `integrity.ts` dan `finalize.ts`**

`checkIntegrity` menjalankan query untuk: `every_finding_has_project`, `every_semantic_has_project`, `links_have_status` (bila `requireAllLinked`), `no_canonical_outgoing_merge` (memakai `semantic_merge.from_semantic_id` dan `finding_merge.from_finding_id`, **bukan** `merge_status`), `no_merge_cycles`, `enum_values` (severity, strength, kategori DeFi, kategori kerentanan), `high_cross_links_have_verbatim_evidence` (mengecualikan evidence berprefix in-project), dan `no_merge_status_rows` (Fase 1 tidak boleh menulis tabel itu). `finalizeBuild` menulis `operation_history` dengan `operation_type = "c4learn"` (satu-satunya nilai yang masuk akal untuk build dataset C4; enum hanya menerima `c4learn`/`sherlocklearn`/`link`) dan `args = JSON.stringify({ c4Ids })`, idempoten pada pasangan `(operation_type, args)` yang byte-identik, lalu mengembalikan report.

Helper lokal `seededBroken(opts?: { canonicalWithOutgoing?: boolean; badSeverity?: boolean })` membuat DB minimal dengan satu finding + satu semantic + edge link tetapi **tanpa** `finding_link_status` (sehingga `requireAllLinked: true` sengaja gagal); `canonicalWithOutgoing` menambah edge keluar dari canonical; `badSeverity` menulis severity di luar enum.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/integrity.test.ts`
Expected: PASS, 3 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/integrity.ts .opencode/plugins/knowdit/src/pipeline/finalize.ts test/integrity.test.ts
git commit -m "feat: add KG integrity gate and finalize step"
```

---

### Task 19: Orkestrator build, transaksi, dan `force`

**Files:**
- Create: `.opencode/plugins/knowdit/src/pipeline/build.ts`
- Test: `test/pipeline/build.test.ts`

**Interfaces:**
- Consumes: semua tahap (Task 12–18), `Journal`, `KgDb`.
- Produces: `type BuildOptions = { dataDir: string; c4Ids?: number[]; concurrency?: 1; force?: boolean; resetAll?: boolean }`; `type BuildResult = { contests: number; integrity: IntegrityReport; semanticEdges: number; findingEdges: number }`; `buildKg(opts: BuildOptions & { db: KgDb; llm: LlmCaller; journal: Journal }): Promise<BuildResult>`; `resetKg(db: KgDb): void`; `resetContest(db: KgDb, c4Id: number): void`.
- Test helper (`test/helpers/build.ts`): `fakeBuild(opts: { contests: number[]; alreadyDone?: boolean; merged?: boolean; failContest?: number; canned?: boolean; dbPath?: string }): Promise<{ deps: { db: KgDb; llm: LlmCaller; journal: Journal; dataDir: string; c4Ids: number[] }; journal: Journal; order: string[] }>` — membangun manifest sementara untuk `contests`, LLM palsu yang mencatat urutan tahap ke `order`, dan DB di `dbPath` (default file sementara).

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/pipeline/build.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildKg, resetKg, resetContest } from "../../.opencode/plugins/knowdit/src/pipeline/build.ts";

test("runs stages in order for each contest and finalizes once", async () => {
  const { deps, order } = await fakeBuild({ contests: [229, 71] });
  const r = await buildKg({ ...deps });
  assert.deepEqual(order, ["categorize:229", "semantics:229", "findings:229", "link:229", "merge:229", "categorize:71", "semantics:71", "findings:71", "link:71", "merge:71", "global", "finalize"]);
  assert.equal(r.contests, 2);
});

test("does not re-run a contest whose units are done", async () => {
  const { deps, order } = await fakeBuild({ contests: [229], alreadyDone: true });
  await buildKg({ ...deps });
  assert.ok(!order.includes("categorize:229"));
});

test("force after merge requires resetAll", async () => {
  const { deps } = await fakeBuild({ contests: [229], merged: true });
  await assert.rejects(() => buildKg({ ...deps, force: true }), /reset_all/i);
});

test("refuses merge and global link while a failed contest is not skipped", async () => {
  const { deps } = await fakeBuild({ contests: [229, 71], failContest: 229 });
  await assert.rejects(() => buildKg({ ...deps }), /contest 229/i);
});

test("a skipped contest unblocks the rest of the build", async () => {
  const { deps, journal } = await fakeBuild({ contests: [229, 71], failContest: 229 });
  journal.skip(229, "accepted after review");
  const r = await buildKg({ ...deps });
  assert.equal(r.integrity.ok, true);
});

test("resetContest removes only that contest's rows", async () => {
  const { deps } = await fakeBuild({ contests: [229, 71] });
  await buildKg({ ...deps });
  resetContest(deps.db, 229);
  assert.equal(deps.db.get<{ n: number }>("select count(*) n from project")!.n, 1);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/pipeline/build.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `build.ts`**

Urutan per kontes: categorize → semantics → findings → in-project link → merge. Setelah semua kontes: global link → finalize. `dataDir` yang diterima `buildKg` adalah direktori dataset (`<data root>/dataset`, berisi `manifest.json`, `reports/`, `contracts/`); `buildKg` **tidak** menyiapkan dataset dan gagal jelas bila `manifest.json` tidak ada. Setiap tahap melewati unit yang `journal.isDone`. Semua tulisan tahap 1–4 per kontes dalam satu transaksi.

Gerbang kegagalan: sebelum merge/global, periksa journal; bila ada kontes dengan unit `failed` dan kontes itu tidak `journal.isSkipped(c4Id)`, lempar error yang menyebut id kontes tersebut. Merge tidak boleh melihat proyek setengah jadi.

`force` sebelum merge memanggil `resetContest`; setelah merge — didefinisikan sebagai **ada minimal satu baris di `semantic_merge` atau `finding_merge`** — `force` ditolak dengan error yang menyebut `reset_all`, karena raw sudah terlipat ke canonical bersama dan FK `RESTRICT` melarang pemisahan parsial. `resetAll`/`resetKg` menghapus isi 18 tabel (kecuali seed `category`/`finding_category`) dan seluruh journal, lalu mencatat alasan di journal.

Helper `fakeBuild` membangun manifest sementara untuk `contests` dan menyediakan stage palsu yang mencatat ke `order`. Opsi: `alreadyDone` menandai semua unit selesai di journal; `merged` menambah satu baris `finding_merge`; `failContest` membuat unit kontes itu berstatus `failed`; `canned` memakai skrip LLM tetap yang menghasilkan minimal satu semantic, satu finding, dan satu link; `dbPath` membuat parent directory, menghapus file lama (beserta `-wal`/`-shm`), lalu membuka DB di path itu.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/pipeline/build.test.ts`
Expected: PASS, 6 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/pipeline/build.ts test/pipeline/build.test.ts
git commit -m "feat: orchestrate resumable KG build with safe force semantics"
```

---

### Task 20: Statistik, query, dan registrasi lima tool

**Files:**
- Create: `.opencode/plugins/knowdit/src/stats.ts`
- Create: `.opencode/plugins/knowdit/src/query.ts`
- Modify: `.opencode/plugins/knowdit/src/tools/handlers.ts`
- Modify: `.opencode/plugins/knowdit/src/register.ts`
- Test: `test/tools/handlers.test.ts`

**Interfaces:**
- Consumes: `KgDb`, `openKg`, `openJournal`, `prepareDataset`, `buildKg`, `createLlmCaller`.
- Produces: `type KgStatsSubset = { projectsTotal: number; semanticsTotal: number; semanticsCanonical: number; findingsTotal: number; findingsCanonical: number; linksTotal: number; linksInProject: number; linksCross: number; linkProcessedFindings: number; pendingSemantics: number }`; `type HandlerDeps = { dataDir: string; generate: GenerateFn; model?: ModelRef; cost?: { input: number; output: number } }`; `readStats(db: KgDb): KgStatsSubset`; `queryFindings(db, q)`, `querySemantics(db, q)`, `queryLinks(db, q)`; `buildHandlers(deps: HandlerDeps): Record<string, ToolHandler>`; `registerKnowditTools` mendaftarkan kelima tool.

- [ ] **Step 1: Tulis test yang gagal**

```ts
// test/tools/handlers.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { readStats } from "../../.opencode/plugins/knowdit/src/stats.ts";
import { registerKnowditTools } from "../../.opencode/plugins/knowdit/src/register.ts";

test("stats split in-project from cross links by evidence prefix", async () => {
  const { db } = await seededStats();
  const s = readStats(db);
  assert.equal(s.linksTotal, 2);
  assert.equal(s.linksInProject, 1);
  assert.equal(s.linksCross, 1);
  assert.equal(s.semanticsCanonical, 1);
  assert.equal(s.pendingSemantics, 1);
});

test("registers all five tools in the knowdit namespace", () => {
  const tools: string[] = [];
  registerKnowditTools({ namespace: () => {}, add: (t) => tools.push(t.name) }, {
    dataset_prepare: async () => ({ content: "" }),
    kg_build: async () => ({ content: "" }),
    kg_status: async () => ({ content: "" }),
    kg_query: async () => ({ content: "" }),
    kg_stats: async () => ({ content: "" }),
  });
  assert.deepEqual(tools.sort(), ["dataset_prepare", "kg_build", "kg_query", "kg_stats", "kg_status"]);
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/tools/handlers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implementasi `stats.ts`, `query.ts`, `handlers.ts`**

`readStats` menghitung subset **persis seperti Rust `kg_stats`**: `semanticsCanonical = semanticsTotal − count(distinct semantic_merge.from_semantic_id)`, `findingsCanonical = findingsTotal − count(distinct finding_merge.from_finding_id)`, `linksInProject` = evidence `like 'in-project link:%'`, `linksCross` = sisanya, `linkProcessedFindings = count(finding_link_status)`, `pendingSemantics = count(pending_semantic)`. `querySemantics` memfilter `name`/`definition`/`description` dengan `like`, kategori opsional, `canonicalOnly` default true, `limit` default 20. `queryFindings` memfilter title/description, severity, category. `queryLinks` memfilter per finding/semantic/strength. Handler `kg_query` menerima `{ kind: "semantic" | "finding" | "link", ...filters }`; `kg_stats` mengembalikan JSON `readStats`; `kg_status` membaca journal + manifest; `kg_build` membuat `createLlmCaller({ generate: deps.generate, model: deps.model, cache: fileCache(join(deps.dataDir, "cache")), maxAttempts: 3, cost: deps.cost })` lalu memanggil `buildKg` dengan `llm` tersebut. `index.ts` mengisi `deps.generate` dari `createSessionGenerate(ctx, ...)` (Task 1) dan `deps.model` dari `ctx.options.model` (opsional).

Helper lokal `seededStats()` menyiapkan 2 semantic (satu raw + satu canonical yang terhubung lewat `semantic_merge`), 2 link (satu evidence berprefix in-project, satu evidence cross-project), dan 1 baris `pending_semantic`, sehingga `linksTotal = 2`, `linksInProject = 1`, `linksCross = 1`, `semanticsCanonical = 1`, `pendingSemantics = 1`.

- [ ] **Step 4: Jalankan test, pastikan lulus**

Run: `node --test test/tools/handlers.test.ts`
Expected: PASS, 2 test.

- [ ] **Step 5: Commit**

```bash
git add .opencode/plugins/knowdit/src/stats.ts .opencode/plugins/knowdit/src/query.ts .opencode/plugins/knowdit/src/tools .opencode/plugins/knowdit/src/register.ts test/tools
git commit -m "feat: expose stats, query, and build tools"
```

---

### Task 21: Gerbang kompatibilitas eksternal dan E2E dengan LLM palsu

**Files:**
- Create: `scripts/verify-compat.ts`
- Create: `test/helpers/digest.ts`
- Test: `test/e2e/fake-llm.test.ts`

**Interfaces:**
- Consumes: seluruh pipeline, `readStats`.
- Produces: `scripts/verify-compat.ts` yang menerima `--db <path>` dan keluar 0 hanya bila binary v1.0.1 menerima database.

- [ ] **Step 1: Tulis E2E yang gagal**

```ts
// test/e2e/fake-llm.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { buildKg } from "../../.opencode/plugins/knowdit/src/pipeline/build.ts";
import { fakeBuild } from "../helpers/build.ts";
import { tableDigests } from "../helpers/digest.ts";

test("one contest, fake llm, full pipeline, clean integrity", async () => {
  const { deps } = await fakeBuild({ contests: [229], canned: true, dbPath: "data/tmp/e2e.sqlite" });
  const r = await buildKg({ ...deps });
  assert.equal(r.integrity.ok, true);
  assert.ok(deps.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n >= 1);
  assert.equal(deps.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, deps.db.get<{ n: number }>("select count(*) n from audit_finding")!.n);
});

test("rebuild from cache is hash-identical at concurrency 1", async () => {
  const a = await fakeBuild({ contests: [229], canned: true, dbPath: "data/tmp/ge-a.sqlite" });
  await buildKg({ ...a.deps });
  const b = await fakeBuild({ contests: [229], canned: true, dbPath: "data/tmp/ge-b.sqlite" });
  await buildKg({ ...b.deps });
  assert.deepEqual(tableDigests(a.deps.db), tableDigests(b.deps.db));
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `node --test test/e2e/fake-llm.test.ts`
Expected: FAIL — `fakeBuild` belum mendukung `canned` dan `dbPath`.

- [ ] **Step 3: Implementasi `scripts/verify-compat.ts`**

Script: (a) resolve binary `<clone>/target/release/knowdit`, gagal bila tidak ada; (b) jalankan `knowdit learn --database-url "sqlite://<abs-db>?mode=rwc" validate-db`, gagal bila exit ≠ 0; (c) jalankan `knowdit db snapshot --database-url "sqlite://<abs-db>?mode=rwc" --format json --output <tmp>` (argumen `--database-url` ikut `snapshot`), gagal bila exit ≠ 0; (d) parse `KgStats` dari stdout `validate-db` dengan regex ber-anchor, dan **gagal keras bila sebuah baris tidak ditemukan** (jangan diam-diam melewati drift):
  - `/^projects: (\d+) \(/m` → `projectsTotal`
  - `/^semantics: (\d+) raw = (\d+) canonical \+ (\d+) folded/m` → `semanticsTotal`, `semanticsCanonical`
  - `/^findings:  (\d+) raw = (\d+) canonical \+ (\d+) folded/m` → `findingsTotal`, `findingsCanonical`
  - `/^pipeline: link-processed findings (\d+)\/\d+ \| pending semantics (\d+)/m` → `linkProcessedFindings`, `pendingSemantics`
  - `/^links: (\d+) total = (\d+) in-project \+ (\d+) cross-project/m` → `linksTotal`, `linksInProject`, `linksCross`
  
  Bandingkan sepuluh nilai itu dengan `readStats(db)`; cetak `compat OK` bila semua cocok, selisih 0. `validate-db` membuka DB lewat `connect_init` yang menjalankan `init` idempoten (seed di-skip bila tabel sudah terisi); script tidak menambah, mengubah, atau menghapus baris pada database yang divalidasi.

`test/helpers/digest.ts` mengekspor `tableDigests(db: KgDb): Record<string, string>` — untuk setiap tabel non-seed **kecuali `operation_history`** (kolom `datetime` berbeda di setiap run), ambil semua baris dengan urutan kolom PK, `JSON.stringify`, lalu `sha256`; dipakai untuk G-E. `fakeBuild` menghapus file `dbPath` lama (beserta `-wal`/`-shm`) sebelum membuka DB agar test tidak mewarisi state run sebelumnya.

- [ ] **Step 4: Jalankan test E2E dan verifikasi manual**

Run: `node --test test/e2e/fake-llm.test.ts`
Expected: PASS, 2 test. Test pertama meninggalkan `data/tmp/e2e.sqlite` yang dipakai langkah berikut.
Run: `node scripts/verify-compat.ts --db data/tmp/e2e.sqlite`
Expected: `compat OK`.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-compat.ts test/e2e/fake-llm.test.ts
git commit -m "test: add fake-llm e2e and external compatibility gate"
```

---

### Task 22: Jalankan batch 12 kontes yang sebenarnya

**Files:**
- Modify: `docs/superpowers/specs/2026-11-17-knowdit-kg-phase1-design.md` (isi hasil nyata di §13)
- Create: `data/` (gitignored)

**Interfaces:**
- Consumes: tool `dataset_prepare`, `kg_build`, `kg_status`, `kg_stats` di namespace `knowdit` (nama publiknya berprefix namespace, mis. `knowdit_dataset_prepare`).
- Produces: `data/dataset/manifest.json`, `data/kg.sqlite`, `data/runs.sqlite`, laporan singkat hasil verifikasi.

- [ ] **Step 1: Siapkan dataset**

Panggil `dataset_prepare` (namespace `knowdit`) dengan default. Verifikasi manifest: 12 kontes, total LOC 13.877 ±5%, `expected` total 62 High + 99 Medium, dan tidak ada kontes dengan `trimFallback: true`.

- [ ] **Step 2: Build KG**

Panggil `kg_build` dengan `{ "c4Ids": [...12 id C4 asli dari id_map...] }`. Pantau `kg_status` sampai selesai. Hentikan dan laporkan bila ada unit `failed`.

Sebelum build, pastikan opsi plugin `model` memakai `{ "providerID": "opencode", "id": "deepseek-v4.1-flash-free" }` (default baru). Model ini sudah terbukti menghasilkan JSON bersih lewat `session.generate`; jangan memakai `experimental.generate.text` karena menolak model gratis. Catat model final di laporan.

- [ ] **Step 3: Jalankan gerbang**

```bash
node scripts/verify-compat.ts --db data/kg.sqlite
```

Expected: `compat OK`.

- [ ] **Step 4: Review 20 link acak**

Ambil 20 link acak via `kg_query`; catat penilaian masuk akal/tidak. Target ≥16/20. Simpan hasil di laporan.

- [ ] **Step 5: Jawab tiga pertanyaan contoh**

Lewat `kg_query`, jawab dan catat hasilnya di laporan: (a) semantic mana yang paling sering muncul bersama finding High? (b) finding apa yang bertaut ke semantic kategori `Lending`? (c) berapa canonical semantic tanpa finding? Ketiganya harus terjawab tanpa SQL manual.

- [ ] **Step 6: Commit catatan hasil**

```bash
git add docs/superpowers/specs/2026-11-17-knowdit-kg-phase1-design.md
git commit -m "docs: record phase 1 batch results"
```

---

## Catatan eksekusi

- Task 2 membutuhkan `cargo build --release -p knowdit`; ini bisa memakan beberapa menit dan hanya dilakukan sekali.
- Task 22 adalah satu-satunya task yang memanggil model sungguhan dan menghabiskan biaya.
- Bila `bun:sqlite` tidak tersedia di runtime OpenCode, adapter jatuh ke `node:sqlite`; bila keduanya tidak ada, ke `sqlite3` CLI. Test selalu memakai `node:sqlite`.
- Jangan pernah menjalankan binary v1.0.1 dengan subcommand yang menulis (`init-db`, `learn`, `link`) terhadap `data/kg.sqlite`; hanya `validate-db` dan `db snapshot`.
