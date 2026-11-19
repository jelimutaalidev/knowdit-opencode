# AGENTS.md — KNOWDIT Phase 1 (OpenCode)

Operating manual for any coding agent (or human) continuing work in this
repository. Read this before changing code, running the build, or resetting
state.

## 1. What this repository is

`knowdit-opencode` is an OpenCode plugin that builds the **Phase 1 historical
knowledge graph** described in `KNOWDIT-agentic-smart-contract-vulnerability.md`.

- Input: 12 Code4rena contests (audit reports + Solidity sources).
- Output: one SQLite database, `data/kg.sqlite`, that the **Rust `knowdit`
  reference binary v1.0.1** can validate, snapshot, and report statistics on.
- The pipeline is LLM-driven; the DB is the artifact that matters.
- The Rust implementation is the referee. When this document, the paper, or the
  design spec disagrees with observed Rust behavior, **Rust wins**.

Phase 1 scope is fixed: 12 contests, High/Medium/Low report sections only, no
Gas/Optimization extraction, no Phase 2 consumer features.

## 2. Current state (2026-11-19)

Treat this as a starting checkpoint, then verify against the repository.

| Item | State |
| --- | --- |
| Branch | `knowdit-kg-phase1` |
| `PIPELINE_VERSION` | `2026-11-19.p0p1.4` |
| Test suite | 178/178 passing (`npm test`) |
| Dataset | Prepared, 12 contests, `data/dataset/manifest.json` exists |
| `data/kg.sqlite` | **Empty** (full reset executed) |
| `data/runs.sqlite` | **Empty journal**, no build fingerprint, reset reason recorded |
| `data/cache`, `data/llm-scratch`, `data/tmp`, `data/progress.log` | Cleared |
| Rebuild | **Not started** — requires explicit user approval |
| `scripts/verify-compat.ts` | Blocked until a clean rebuild produces a valid KG |
| Git remote | `origin` → `github.com/jelimutaalidev/knowdit-opencode` |
| Working tree | Clean at the Phase 1 baseline commit; branch pushed |

Recorded reset reason:

```
operator-approved full reset before clean 12-contest rebuild (2026-11-19)
```

Do not reset again, and do not start `knowdit_kg_build`, unless the user asks.

Completed quality work is tracked in `notes/p0-p1-checklist.md` (P0, P1, P2 all
checked). The design spec is
`docs/superpowers/specs/2026-11-17-knowdit-kg-phase1-design.md`; the original
implementation plan is `docs/superpowers/plans/2026-11-17-knowdit-kg-phase1.md`.

## 3. Hard rules

1. **No implicit reset or rebuild.** A reset destroys provenance across all 12
   contests. Ask first. `reset_all` must always carry a specific `resetReason`.
2. **Do not replace an interrupted subagent with a new one.** Continue its
   existing session (`subagent` with `sessionID`). The same applies to a run
   interrupted by a model usage limit.
3. **Use relevant skills.** Process skills come first: `brainstorming` before
   new behavior, `systematic-debugging` before a bug fix, `test-driven-development`
   / `tdd` before production code. Use `verification-before-completion` before
   claiming success.
4. **TDD, one behavior per cycle.** Write a failing test, run it to confirm RED,
   implement the smallest fix, confirm GREEN, then refactor. Do not batch
   unrelated behaviors into one test.
5. **Rust parity over prose.** Check the reference code before "fixing" a
   behavior. Cite `file:line` in the change description.
6. **Fail fast on model limits.** Never swallow a usage/limit error, never
   downgrade the model, and never restart completed units. Resume the same build.
7. **Never commit generated data or secrets.** `data/` is gitignored, including
   SQLite files and the dataset snapshot. No API keys, tokens, cookies, or
   `.env` files belong in the repository or in prompts.
8. **Bump `PIPELINE_VERSION`** for any change that can alter persisted KG
   content, prompt text, validation, render rules, or model-response shape. It
   feeds both the response-cache key and the journal fingerprint.
9. **All DB access goes through `src/db/client.ts`.** Use `db.tx(...)` for a
   multi-statement write; do not open SQLite directly in pipeline code.
10. **Do not hand-edit `src/db/schema.sql`.** It is vendored from the reference
    binary. Regenerate it with `scripts/reference-schema.sh` when intentionally
    re-vendoring the schema.

## 4. Prerequisites

- Node.js **24+**. The code uses native TypeScript type stripping and
  `node:sqlite`; there is no build step and no `tsc` dependency.
- npm (for `npm ci` / `npm install`).
- OpenCode with this repository's plugin loaded. Plugin edits only take effect
  after OpenCode is restarted.
- Optional, for compatibility verification:
  - a clone of the Rust reference repository (default `~/Dev/knowdit`, override
    with `KNOWDIT_REF_REPO`);
  - its release binary (default `~/Dev/knowdit/target/release/knowdit`,
    override with `KNOWDIT_BINARY`).
- The external Code4rena dataset root (default `~/c4-data/out_train`). It is not
  part of this repository.

```bash
npm ci
npm test
```

## 5. Repository map

```
.opencode/plugins/knowdit/
  index.ts                 Plugin entry: model, context window, data dir
  tui.tsx                  Live TUI progress line
  src/
    register.ts            Tool namespace/schemas and registration
    tools/handlers.ts      Tool handlers, paths, progress log, resume messaging
    version.ts             PIPELINE_VERSION (cache + journal fingerprint)
    journal.ts             runs.sqlite: unit status, fingerprint, reset reason
    integrity.ts           Final gate (project/status/taxonomy/enum/link checks)
    stats.ts               KgStats subset used by compatibility verification
    query.ts               kg_query implementation
    progress-events.ts     Progress event marking/formatting
    db/client.ts           SQLite driver, schema application, transactions
    db/schema.sql          Schema vendored from Rust v1.0.1 (18 tables)
    db/seed.ts             Reference-table seeding
    dataset/               Contest selection, snapshots, report trimming, manifest
    domain/                Categories, taxonomy, response validation
    llm/                   JSON caller, retry, cache, OpenCode session transport
    pipeline/              build orchestration + seven stages
    prompts/               Prompt builders and prompt text templates

scripts/
  reference-schema.sh      Rebuild schema.sql + schema fixture from Rust reference
  verify-compat.ts         Rust validate-db / snapshot / stats conformance gate
  state.ts                 Snapshot/restore library: hashes, identity, rollback
  state-snapshot.ts        CLI: capture a self-contained build-state bundle
  state-restore.ts         CLI: verify and restore a bundle on another machine

test/                      Node test runner suites, fixtures, fake LLM/DB helpers
test/scripts/state.test.ts Snapshot/restore and CLI round-trip tests
notes/p0-p1-checklist.md   Authoritative quality-gate status
data/                      Runtime artifacts (gitignored, never commit)
```

Test helpers live in `test/helpers/`; the fake LLM and fake context make the
pipeline testable without network calls. Golden prompt output is in
`test/fixtures/prompts/findings.golden.txt`.

## 6. Pipeline

`kg_build` runs per contest, then one global pass:

| Order | Journal stage | What it does |
| --- | --- | --- |
| 1 | `categorize` | Assigns DeFi categories to the project |
| 2 | `semantics` | Extracts reusable vulnerability semantics (chunked) |
| 3 | `findings` | Extracts findings, validates each item, bounded repair |
| 4 | `link` | Links findings to semantics from the same project |
| 5 | `merge` | Merges duplicate semantics/findings across projects |
| 6 | `global` | Links every finding to canonical semantics globally |
| 7 | `finalize` | Runs the integrity gate; fails the build if any check fails |

Journal units are keyed by `(stage, c4_id, unit_index)`. The global and finalize
units use `c4_id = 0`.

Resume behavior:

- A `done` unit is skipped. A `running`/`failed` unit is retried.
- A done `link` unit is re-run if a project finding still lacks an in-project
  link.
- A done `global` unit is re-run if findings still lack a `finding_link_status`
  row.
- `finalize` is re-run whenever any unit actually ran in the current invocation.
- `force` resets selected contests **only before merge rows exist**. After a
  merge, `force` is rejected; use `reset_all`.

Fingerprint = `manifest.generatedAt` + `PIPELINE_VERSION` + model input window +
model identity (provider/id/variant). A resume under a different fingerprint is
refused before any mutation. Changing the model, effort variant, context window,
or dataset requires `reset_all` with a reason.

Journal API includes `skip(c4Id, reason)` and `isSkipped`, and the build filters
skipped contests. No tool flag currently exposes skipping; do not invent one
without tests and a design decision.

## 7. LLM transport and model policy

Default model (`index.ts`):

```ts
{ providerID: "opencode", id: "deepseek-v4.1-flash-free", variant: "high" }
```

- Keep reasoning effort at `high` or above for extraction quality. The variant
  is part of the fingerprint.
- Calls go through the OpenCode session transport; there is no provider API key
  in this repository.
- Responses are cached in `data/cache/<prompt_hash>.json`. The cache key includes
  the model variant and pipeline/cache version.
- An invalid cached response is regenerated, not rethrown.
- Model usage/limit errors are **fatal for the run** and must propagate
  unchanged. Rerunning the same `kg_build` resumes from the journal and reuses
  the cache.
- `concurrency` is fixed at `1` in Phase 1 so row order and hashes are stable.

## 8. Rust parity contract

These constants and behaviors are deliberate; do not "simplify" them without
checking the reference.

- Global-link input budget: **20%** of the model context window.
- Split of that budget: **35%** for findings, remainder for candidates.
- Finding batch cap: **135** per LLM call.
- Rendering: at most **8** variants per semantic and **400** characters per raw
  child, except where integrity grounding must consider every descendant.
- Merge decision token ratio: **0.85** (`NEW_ITEM_TOKEN_RATIO`).
- Global-link omissions: retry missing findings up to **3** attempts, then treat
  them as no-link (silent omission = no link).
- Candidate order before chunking: `(category, name, id)` — matches
  `group_finding_link_candidate_entries` in Rust `link.rs`.
- Link strength is strongest-wins. An in-project `High` link is never downgraded.
- Cross-project `High` links need a **quoted span of at least 25 characters
  (~6 words)** that appears verbatim in the finding's own rendered body;
  in-project links are excluded because their evidence is synthetic and
  prefixed with `in-project link:`.
- Finding DeFi categories are the union across every owning project, sorted and
  deduped.
- Stats follow the reference formula: canonical = total rows − distinct folded
  sources.
- Prompt substitution is **single-pass**. `$&`, `$'`, `` $` ``, and
  `{placeholder}`-like text in user/model content must stay literal.

Known conformance gap (P2, not a rebuild blocker): platform IDs in this builder
use the C4 contest id (`c4-453`), while the Rust dataset folder uses the local
id (`c4-110`). Fix only with an explicit decision and parity evidence.

The Rust clone may report tag `v2.0.0` while `Cargo.toml` says `1.0.1`. Trust the
source and `Cargo.toml`; do not switch to the installed `~/.cargo/bin/knowdit`
(v2.x has a different schema and taxonomy).

## 9. Data and reproducibility

Runtime layout (all under `data/`, all gitignored):

```
data/dataset/          Snapshot: contracts/, reports/, id_map.json, manifest.json
data/kg.sqlite         The knowledge graph (build output)
data/runs.sqlite       Journal: unit_status, contest_status, journal_meta
data/cache/            LLM response cache (prompt-hash keyed)
data/llm-scratch/      Temporary model I/O transcripts
data/tmp/              Compatibility scratch DBs
data/progress.log      JSONL progress mirror (best-effort)
```

- `data/dataset` is reproducible from the external dataset root with
  `knowdit_dataset_prepare`. The manifest stores its `sourceRoot` and
  `generatedAt`; regenerate it after moving machines.
- The default batch is the 12 approved contests in
  `src/dataset/select.ts`:
  local IDs `110, 33, 40, 32, 23, 12, 65, 54, 34, 57, 96, 64`
  → C4 IDs `453, 316, 331, 326, 305, 286, 361, 355, 322, 332, 428, 367`.
- Report trimming keeps Overview, Scope, High/Medium/Low findings, and
  Non-Critical sections; it drops Gas/Optimization, Disclosures, and other
  boilerplate.
- Never delete `data/dataset` to "fix" a problem; regenerate it deliberately and
  expect the fingerprint to change.

## 10. Commands and tools

### Tests

```bash
npm test                                   # full suite (178 tests)
node --test test/pipeline/merge.test.ts    # one file
node --test test/pipeline/*.test.ts        # one area
node --test test/scripts/state.test.ts     # state snapshot/restore
```

There is no separate typecheck or lint script. A syntax/type regression is
caught by the test run (Node strips types without checking them); keep types
accurate by review.

### OpenCode tools (namespace `knowdit`)

| Tool | Purpose |
| --- | --- |
| `knowdit_dataset_prepare` | Snapshot contests and write the manifest (`sourceRoot`, `localIds`) |
| `knowdit_kg_build` | Build or resume (`c4Ids`, `force`, `resetAll`, `resetReason`) |
| `knowdit_kg_status` | Dataset readiness, journal units, failures, skipped contests, build-lock state |
| `knowdit_kg_query` | Query semantics, findings, or links |
| `knowdit_kg_stats` | Reference-format statistics |

Typical build arguments:

```json
{ "resetAll": true, "resetReason": "clean 12-contest rebuild after P0/P1 fixes" }
```

On a **fresh machine with no journal**, omit `resetAll`; there is nothing to
clear. Use it only when an existing journal or KG must be discarded.

`kg_build` holds `data/.build.lock` for the whole run and refuses to start while
another writer owns it (pid, host, and run id are recorded). A lock left by a
dead process on the same host is recovered automatically; a lock owned by
another host must be cleared only after that machine is confirmed stopped.
Never run two builds against the same `data/`, even in different OpenCode
sessions.

### Build-state transfer

```bash
npm run state:snapshot -- --out ~/knowdit-state/checkpoint-01
npm run state:restore  -- --from ~/knowdit-state/import [--force]
```

`state:snapshot` refuses a dirty worktree, a running unit, or an existing
bundle unless `--allow-dirty`, `--allow-running`, or `--force` is given.
`--force` replaces only a directory that contains `identity.json`, and the
output may not overlap `data/`. It writes `identity.json` with the commit,
`PIPELINE_VERSION`, dataset hashes, journal fingerprint/unit counts, and
artifact hashes. `state:restore` verifies
every hash and the commit/pipeline identity before touching the target; with
`--force` the previous state moves to `data/.restore-backup-*` instead of being
deleted, and a failed copy rolls back. See
[`docs/operations/cross-machine-resume.md`](docs/operations/cross-machine-resume.md).

### Compatibility gate

```bash
node scripts/verify-compat.ts --db data/kg.sqlite
# or: KNOWDIT_BINARY=/path/to/knowdit node scripts/verify-compat.ts --db data/kg.sqlite
```

It runs the reference `learn ... validate-db` (must exit 0), `db snapshot`
(must write valid JSON), and compares the `KgStats` subset against `readStats`.
This is the strongest acceptance test. It cannot pass on an empty or partial KG.

### Schema re-vendoring

```bash
KNOWDIT_REF_REPO=/path/to/knowdit scripts/reference-schema.sh
```

This rebuilds the Rust binary and **overwrites** `src/db/schema.sql` and
`test/fixtures/schema-1.0.1.json`, plus creates scratch DBs. Run it only when
intentionally re-vendoring, then review the diff and rerun the suite.

## 11. Development workflow

1. Load the relevant skill; for a bug, reproduce it first.
2. Add a failing test under `test/` that states the behavior.
3. Run it and confirm it fails for the right reason (RED).
4. Implement the minimal change in `.opencode/plugins/knowdit/src/`.
5. Run the focused test (GREEN), then the full suite.
6. Bump `PIPELINE_VERSION` if persisted content, prompts, validation, rendering,
   or fingerprints change.
7. Update `notes/p0-p1-checklist.md` when a tracked quality item changes.
8. If the codebase graph exists, run `graphify update .` after code changes.

Code conventions:

- ESM only, explicit `.ts` extension in imports, `verbatimModuleSyntax`-friendly
  type imports.
- Keep user/model text out of replacement-string semantics; use the shared
  single-pass `fill`.
- Keep prompts in `src/prompts/texts/*.txt`; builders assemble them. Prompt text
  changes are pipeline changes.
- Multi-write operations belong in one `db.tx`; per-contest merge plans are
  applied in raw extraction order.
- Preserve provenance rows (`project_semantic`, `project_finding`) and merge
  direction; never delete canonicals to force a rebuild.

## 12. Rebuild runbook (only after explicit approval)

1. Confirm `notes/p0-p1-checklist.md` has no open P0/P1 item.
2. Restart OpenCode so the current plugin code is loaded.
3. Verify the dataset (12 contests; expected totals are 62 High, 99 Medium,
   and roughly 13.9k core LOC): `knowdit_kg_status`. `build.locked` must be
   false; if it is true, wait for that build or resolve the stale lock first.
4. If the journal is not empty or the fingerprint is stale, run
   `knowdit_kg_build` with `resetAll: true` and a specific `resetReason`.
   Otherwise omit `resetAll`.
5. Run `knowdit_kg_build` with no `c4Ids` to build the whole manifest, or in
   batches of two or three contests. Run `npm run state:snapshot` after every
   batch (§13) so an exhausted quota never costs the batch.
6. On interruption, rerun the same call. Do not reset and do not change the
   model. Completed units are skipped; cached responses are reused.
7. Check `knowdit_kg_status` for failures and unresolved units.
8. Run `node scripts/verify-compat.ts --db data/kg.sqlite`.
9. Run `knowdit_kg_stats` and compare with the reference output.
10. Review a sample of cross-project links before declaring success.

Definition of done for Phase 1 is in design spec §13: 12 contests built, integrity
gate clean, reference `validate-db` clean, snapshot/stats conform, and the build
reproducible from cache at `concurrency = 1`.

## 13. Moving to another computer

Two branches; do not mix them.

**Resuming an interrupted build** (a journal already exists): check out the
same commit, restore the bundle, and never run `dataset_prepare`.

```bash
git fetch --all --tags
git checkout <build-tag-or-commit>   # the commit recorded in identity.json
npm ci
npm run state:restore -- --from ~/knowdit-state/import   # --force if state exists
```

The bundle already contains `dataset/`, so nothing else has to be copied. Take
it on the source machine with `npm run state:snapshot`. The short rule: same
commit, same `manifest.json` bytes, same model/variant/window, one consistent
`kg.sqlite` + `runs.sqlite`, and one writer at a time. Tag the exact commit when
you start the build; restore refuses a commit or pipeline mismatch, verifies
every hash, and backs up replaced state. Full rules, flags, and failure modes:
[`docs/operations/cross-machine-resume.md`](docs/operations/cross-machine-resume.md).

**Starting fresh** (no journal): clone the repository, run `npm ci`, and prepare
the dataset. A new `manifest.generatedAt` means a new fingerprint, which is
expected when there is no history to preserve.

Path overrides (no machine-specific paths are required):

- `KNOWDIT_REF_REPO` — Rust reference clone for `reference-schema.sh`.
- `KNOWDIT_BINARY` — reference binary for `verify-compat.ts`.
- `sourceRoot` / `localIds` — dataset preparation.
- `dataDir` is derived from the plugin location; do not hardcode it.

## 14. GitHub handoff

Before committing:

```bash
git status --short
git diff --stat
git diff --cached --stat
```

- Commit source, tests, prompt text, docs, `AGENTS.md`, and
  `notes/p0-p1-checklist.md`.
- Never commit `data/`, `*.sqlite*`, `node_modules/`, `.superpowers/`, caches,
  transcripts, or secrets. `.gitignore` already covers the generated paths;
  verify anyway.
- Do not rewrite the graph file if a `graphify-out/graph.json` is present; a
  whole-file diff is expected after a rebuild.
- Use clear, conventional commit subjects (the history uses `feat:`, `fix:`,
  `test:`, `docs:`).
- `origin` points to `github.com/jelimutaalidev/knowdit-opencode`. The repository
  is public and the default branch is `knowdit-kg-phase1`; the owner may switch
  the default to `main` as phases accumulate.
- Push only verified commits. Do not force-push or rewrite published history.
- `README.md` is the public entry point; keep it and this file consistent.

## 15. Troubleshooting

| Symptom | Cause / action |
| --- | --- |
| `no SQLite driver available` | Use Node 24+ (`node:sqlite`) or install the `sqlite3` CLI. |
| Fingerprint/resume refusal | Dataset, model, window, or pipeline version changed. Review, then `reset_all` with a reason. |
| Model usage limit | The run stops. Rerun the same `kg_build`; do not reset or switch models. |
| `force after merge is unsafe` | Merge rows exist. Use `reset_all`, not `force`. |
| `validate-db` reports partial link/status rows | The KG is from an older/partial build. Rebuild clean; do not patch rows by hand. |
| `bundle was created at commit …` | Check out the tag/commit named in the error; do not edit `identity.json`. |
| `target already contains build state` | Re-run restore with `--force`; the old state is backed up to `data/.restore-backup-*`. |
| `bundle … hash does not match identity.json` | The transfer is incomplete or corrupted; re-copy the bundle. |
| Build lock refused (`another knowdit build is already running`) | A writer is alive. Wait for it; do not start a second build or delete the lock while that pid lives. |
| Build lock held by another host | Confirm that machine is stopped, then remove `data/.build.lock`. Never let two hosts write the same state. |
| Build lock exists but is unreadable | Inspect `data/.build.lock`. If no build is running, remove it and retry. |
| `journal has N running unit(s)` | The build is alive or crashed. Stop it; use `--allow-running` only for crash recovery. |
| Plugin changes have no effect | Restart OpenCode. |
| Integrity gate fails | Read the failing check name and detail from the thrown error; fix the pipeline that produced the row, not the check. |
| Build resumes but repeats a stage | Check whether the repair path fired (missing in-project link or missing global status). That is intentional. |

## 16. Open items

- [ ] User approval to start the clean 12-contest rebuild.
- [ ] `scripts/verify-compat.ts` green on the rebuilt KG.
- [ ] Optional P2: align platform IDs with the reference dataset folder.
- [ ] Optional: expose contest skipping in the tool schema with tests.
- [ ] Git remote/commit/push decisions (owner).

When in doubt: verify against the Rust source, write the failing test first, and
do not destroy state that took an LLM build to produce.
