# KNOWDIT Phase 1 — Historical Knowledge Graph

An OpenCode plugin that turns historical Code4rena audit data into a structured
SQLite knowledge graph of smart-contract vulnerabilities.

Phase 1 builds a reusable **auditing knowledge graph**: findings extracted from
12 Code4rena contests are normalized, merged across projects, and linked to
canonical vulnerability semantics. The resulting database is schema-compatible
with the Rust `knowdit` reference implementation (v1.0.1) and is validated by
that binary before it is considered complete.

## What this repository contains

- An OpenCode plugin (`knowdit`) exposing dataset preparation, build, status,
  query, and statistics tools.
- A deterministic dataset layer: contest selection, source snapshots, report
  trimming, and a manifest with expected finding counts.
- A seven-stage LLM pipeline with validation, bounded repair, response caching,
  and resumable journaling.
- Integrity and compatibility gates: an internal SQL gate plus the reference
  binary's `validate-db`, `db snapshot`, and `KgStats` output.

## Status

Phase 1 is implemented and tested; the knowledge graph is currently reset and
ready for a clean rebuild.

| Item | State |
| --- | --- |
| Pipeline version | `2026-11-19.p0p1.4` |
| Test suite | 178/178 passing |
| Dataset | 12 contests prepared |
| KG / journal | Empty, no build fingerprint |
| Rebuild | Pending explicit approval |
| Reference conformance | Pending the clean rebuild |

See [`AGENTS.md`](AGENTS.md) for the full operating manual, current-state
checkpoint, and continuation instructions.

## How it works

The build runs per contest, followed by a global linking pass:

1. **Categorize** — assign DeFi categories to the project.
2. **Semantics** — extract reusable vulnerability semantics.
3. **Findings** — extract findings with per-item validation and bounded repair.
4. **In-project link** — connect findings to the project's own semantics.
5. **Merge** — fold duplicate semantics and findings across projects.
6. **Global link** — link every finding to canonical semantics.
7. **Finalize** — run the integrity gate.

Each stage is journaled. Interrupted builds resume from the last committed unit,
and model responses are cached by prompt hash. Data-changing pipeline revisions
also change the cache key and journal fingerprint, so incompatible runs cannot
be mixed.

## Requirements

- Node.js 24+
- npm
- OpenCode with this repository's plugin loaded
- A Code4rena dataset root (default `~/c4-data/out_train`)
- Optional, for conformance checks: the Rust `knowdit` v1.0.1 reference clone
  and release binary

## Quick start

```bash
npm ci
npm test
```

The plugin registers these tools under the `knowdit` namespace:

| Tool | Purpose |
| --- | --- |
| `knowdit_dataset_prepare` | Snapshot contests and write the manifest |
| `knowdit_kg_build` | Build or resume the knowledge graph |
| `knowdit_kg_status` | Show dataset and journal status |
| `knowdit_kg_query` | Query semantics, findings, or links |
| `knowdit_kg_stats` | Print reference-format statistics |

A typical first run:

```text
knowdit_dataset_prepare
knowdit_kg_build
knowdit_kg_status
```

If a journal already exists and must be discarded, pass an explicit reason:

```json
{ "resetAll": true, "resetReason": "clean rebuild after pipeline changes" }
```

## Verification

```bash
npm test
node scripts/verify-compat.ts --db data/kg.sqlite
```

`verify-compat.ts` requires the reference binary. Set `KNOWDIT_BINARY` or pass
`--binary` if it is not at the default location.

## Checkpointing and moving machines

The build is long and quota-bound, so build state is portable:

```bash
npm run state:snapshot                        # default location under ~/knowdit-state
npm run state:snapshot -- --out ~/checkpoint  # explicit location
npm run state:restore  -- --from ~/checkpoint --force
```

A bundle is self-contained: `kg.sqlite`, `runs.sqlite`, `dataset/`, `cache/`,
and `identity.json` (commit, pipeline version, dataset and artifact hashes,
journal fingerprint and unit counts). Snapshot refuses a dirty worktree, a
running unit, or any directory that is not a previous bundle. Restore verifies
every hash plus the commit and pipeline version before touching the target;
replaced state is moved to `data/.restore-backup-*`, not deleted.

Transfer the bundle with `rsync` or `rclone`; never commit build state. Do not
run `dataset_prepare` when resuming. See the
[cross-machine resume guide](docs/operations/cross-machine-resume.md) for flags,
sequencing, and recovery.

The compatibility gate checks that the reference binary:

- accepts the database with `validate-db`;
- can write a JSON snapshot;
- reports the same `KgStats` subset as this implementation.

## Repository layout

```text
.opencode/plugins/knowdit/   Plugin entry, tools, pipeline, prompts, DB layer
scripts/                     Compatibility gate, schema generation, state transfer
test/                        Node test runner suites and fixtures
docs/superpowers/            Phase 1 design spec and implementation plan
notes/                       Quality-gate checklist
data/                        Runtime artifacts (gitignored)
```

## Documentation

- [`AGENTS.md`](AGENTS.md) — operating manual, rules, runbook, handoff guide
- [`docs/operations/cross-machine-resume.md`](docs/operations/cross-machine-resume.md)
  — snapshot, transfer, and resume an interrupted build on another machine
- [`docs/superpowers/specs/2026-11-17-knowdit-kg-phase1-design.md`](docs/superpowers/specs/2026-11-17-knowdit-kg-phase1-design.md)
  — Phase 1 design and acceptance criteria
- [`docs/superpowers/plans/2026-11-17-knowdit-kg-phase1.md`](docs/superpowers/plans/2026-11-17-knowdit-kg-phase1.md)
  — implementation plan
- [`notes/p0-p1-checklist.md`](notes/p0-p1-checklist.md) — quality-gate status
- [`KNOWDIT-agentic-smart-contract-vulnerability.md`](KNOWDIT-agentic-smart-contract-vulnerability.md)
  — KNOWDIT paper

## Operational notes

- `data/` is generated and gitignored. It contains the dataset snapshot, SQLite
  databases, response cache, and progress logs; never commit it.
- To resume a build on another machine, snapshot the state, transfer the bundle,
  and restore it; do not run `dataset_prepare` first. See the
  [cross-machine resume guide](docs/operations/cross-machine-resume.md).
- A full reset destroys cross-contest provenance. Do not reset or rebuild
  without an explicit decision.
- Model usage-limit errors stop the run by design. Rerun the same build to
  resume; completed units and cached responses are reused.
- The installed `~/.cargo/bin/knowdit` may be a different major version. Use the
  v1.0.1 source clone or set `KNOWDIT_BINARY` explicitly.
