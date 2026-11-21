# KNOWDIT Phase 1 — P0/P1 pre-rebuild checklist

Status: in progress. TDD for every production change. No rebuild/reset without explicit approval.

## P0 — blocking quality

- [x] P0-1 Global link batching/chunking
  - [x] 20% input budget, 35% findings / remainder semantics
  - [x] Candidate chunks + finding batches (cap 135)
  - [x] Persist partial links, status only after every candidate chunk
  - [x] Strongest-wins upsert
  - [x] Reject unknown finding_id / unknown semantic_id per chunk
  - [x] Render merged children (variants) in candidates and findings
  - [x] Resolve folded raw findings onto their canonical link target
- [x] P0-2 Cache versioning + validation-miss handling
  - [x] Key includes model variant and pipeline/cache version
  - [x] Invalid cached response is regenerated, never rethrown
- [x] P0-3 Journal fingerprint fail-fast
  - [x] Fingerprint = manifest.generatedAt + pipeline version + window + model
  - [x] Legacy/unversioned done units fail with reset guidance
  - [x] Same-fingerprint resume still skips done units
- [x] P0-4 In-project link repair
  - [x] Done `link` unit reruns when a project finding has no in-project link

## P1 — content quality

- [x] P1-5 Merge candidates filtered to incoming categories
- [x] P1-6 Merge candidate chunking + incoming batching (40) + aggregation
- [x] P1-7 Merge guards
  - [x] updated_*: <=2000 chars, no <60% shrink of >=160-char current
  - [x] appended_*: required, <=600 chars; finding merge requires all three
  - [x] targets restricted to the prompt's candidate chunk
- [x] P1-8 Merged children rendered in merge and link prompts
- [x] P1-9 Per-item extraction diagnostics
  - [x] One invalid finding does not fail the whole chunk (bounded repair, then drop)
  - [x] Repair prompt carries per-item reasons and accepted findings with root causes
  - [x] Duplicate-title rejections tracked per occurrence, not per title set
  - [x] Repair echoes of accepted findings do not resolve a same-title rejection
  - [x] Duplicate repair output cannot inflate the rejection queue
  - [x] Missing merge decision means New (not an error)
- [x] P1-10 Global-link omission and strongest-wins
  - [x] Silent omission = no link (Rust parity)
  - [x] Existing weaker edge upgraded; in-project High never downgraded
- [x] P1-11 Integrity High-quote grounding
  - [x] Quote may come from the canonical or any folded descendant rendered as its own finding
  - [x] Covers descendants beyond the 8-variant and 400-char child caps
- [x] P1-12 Prompt substitution safety
  - [x] Single-pass `{placeholder}` fill; `$&`/`$'`/`` $` `` stay literal
  - [x] Placeholder-like text in finding/user content is never re-expanded

## P2 — conformance cleanup

- [x] Finding DeFi categories unioned across every owning project, sorted and deduped
- [x] Link candidates ordered by `(category, name, id)` like the reference before chunking
- [x] Unconditional `status_rows_have_finding` integrity check
- [x] Unconditional `every_finding_has_category` integrity check
- [x] `semantic_node.category` included in the enum gate
- [x] `reset_all` records its reason in `journal_meta` (survives fingerprint rebinding)

## Operations

- [x] Self-contained build-state bundle (`scripts/state.ts` + snapshot/restore CLIs)
  - [x] `VACUUM INTO` copies of both databases; no WAL/SHM in the bundle
  - [x] `identity.json` records commit, `PIPELINE_VERSION`, dataset manifest/tree
        hashes, journal fingerprint and unit counts, and artifact hashes
  - [x] Snapshot refuses a dirty worktree, a running unit, or an existing bundle
        unless the matching flag is passed
  - [x] Restore verifies every hash and the commit/pipeline identity before
        touching the target
  - [x] Replaced state moves to `data/.restore-backup-*`; a failed copy rolls back
  - [x] CLI snapshot/restore round-trip covered by tests
- [x] Cross-machine resume guide and `AGENTS.md` §13 use the scripts
- [x] Snapshot/restore are safe against a live writer
  - [x] Both refuse a live local pid, a lock owned by another host, and an
        unreadable lock; `--force` does not bypass any of them
  - [x] A stale dead-pid lock on the same host is ignored
- [x] `kg_status` reports the newest bundle without a pointer file
  - [x] Bounded scan (depth 4, 200 candidates) under `~/knowdit-state` or
        `KNOWDIT_STATE_ROOT`
  - [x] Skips hidden directories and symlinks; flags `truncated` when it stops
  - [x] Falls back to file mtime for an invalid `createdAt`
  - [x] Reports the journal fingerprint and `snapshot.matchesJournal`
- [x] Single-writer build lock (`data/.build.lock`)
  - [x] A second build is refused before any journal/KG mutation (pid/host/runId)
  - [x] A lock left by a dead process on the same host is recovered
  - [x] A lock owned by another host is refused; unreadable locks fail closed
  - [x] A resumed unit reuses rows written before the crash instead of duplicating
  - [x] `kg_status` reports `build.locked` and the current holder
- [x] Global-link progress counts only finished findings
  - [x] Batch `start` events no longer report `position - 1`
  - [x] `done`/`failed` each advance the bar exactly once
  - [x] Covered by `test/pipeline/build.test.ts` (3 findings: starts 0/0/0,
        finishes 1/2/3)

## Verification gate

- [x] `npm test` green (205/205)
- [x] `scripts/verify-compat.ts` green on the full 12-contest rebuild
  - [x] Pilot 331: `compat OK` (8 semantics, 10 findings, 0 duplicates)
  - [x] Full 12 contests: `compat OK` (111 semantics / 106 canonical, 259
        findings / 249 canonical, 641 links: 552 in-project + 89 cross, all 259
        findings have a link status)
  - [x] Validator runs against a temporary copy, so the input database keeps its
        bytes (a previous run rewrote the snapshot bundle's header/WAL state and
        invalidated `identity.json` until the bundle was re-captured)
- [x] Integrity gate 10/10 on the full KG; journal 321/321 units done
- [x] Final snapshot captured: `~/knowdit-state/phase1-full-12`
- [x] Focused re-audit complete — 3 findings fixed (candidate order, repair echoes,
      taxonomy gate); 165/165 green after the final version bump, 178/178 with
      the state-transfer tests added
- [x] No reset used for the 12-contest build; every stage resumed from the journal

## Post-build audit (2026-11-21)

Read-only layered audit of `data/kg.sqlite` and the snapshot bundle. Every check
below was run against the live KG and the bundle.

Structural checks (all pass):

- `pragma integrity_check` and `foreign_key_check` clean on both SQLite files.
- Journal: 321/321 units `done`, 0 failed, 0 running; `60 + 259 + 2` unit
  reconciliation; fingerprint equals manifest + pipeline + window + model.
- 12 projects; every project has categories, semantics, and findings; platform
  IDs match the manifest.
- No orphan rows, no self-merge, no merge chains; folded findings carry only
  in-project links (22 rows, 0 cross-project).
- Canonical accounting: 111 − 5 = 106 semantics, 259 − 10 = 249 findings.
- Links: 641 = 552 in-project + 89 cross; every link has evidence; every finding
  has an in-project link; all 10 High cross-project links have ≥25-char evidence.
- Content: no empty/thin rows, every semantic has a function, no duplicate
  canonical titles or semantic names.
- Snapshot bundle hashes match `identity.json` for KG, journal, cache, and the
  dataset tree; bundle content is logically identical to the live KG; the
  recorded commit is the checked-out commit.

Report reconciliation:

- High: 62/62 exactly. Per contest, High matches for all 12 contests once
  cross-project merge provenance is accounted for.
- Medium: 100 vs 99 expected. Cause: finding 473 is a second extraction of
  C4-367 `[M-05]` (finding 472 carries the same root cause and links); the merge
  stage kept both. 160/161 report `[H-xx]`/`[M-xx]` headings map one-to-one to a
  KG finding; 473 is the only extra.
- Low: 97 rows. Low/Non-Critical sections are not one-to-one in scope: reports
  include `[L-xx]`, `[NN]`, and `[N-xx]` items, and extraction kept a subset.
  This is a coverage choice, not a reference break (compat gate passes).

Known quality warnings (not integrity failures, no reset needed):

- 8 of 106 canonical semantics have no finding link. Semantics are DeFi
  mechanism semantics by design, so a mechanism with no submitted finding is
  legitimate.
- 10 cross-project finding merge edges. Two are same-codebase duplicates
  (Canto/Neobase LendingLedger). The other eight merge same-class findings from
  different protocols (e.g. three "missing deadline/slippage" findings folded
  into the Kelp `[M-02]` canonical). Provenance rows are retained in
  `project_finding` and `finding_merge`, so no data is lost, but canonical
  titles become broader than the source finding. A future prompt/dedup pass
  should tighten the merge decision; it would need a `PIPELINE_VERSION` bump and
  a rebuild.
- `contest_status` is empty because no contest was skipped; the snapshot
  identity therefore reports `contests: 0`. Cosmetic only.

## Incidents

- 2026-11-21 — `verify-compat.ts` used to open and validate the caller's
  database in place. The reference validator opens it read-write (WAL mode +
  header change counter) and `openKg` applies the schema, so a successful run
  changed the file bytes without changing any row. Running it against the
  finished snapshot bundle invalidated the KG hash in `identity.json`. The
  script now validates a `VACUUM INTO` copy in a temp directory and removes it
  on exit; a regression test asserts the input bytes are unchanged and that the
  reference binary never sees the original path. The bundle was re-captured from
  the live KG and reproduces the original hash `6e6ce5eb…` exactly.
- 2026-11-21 — Merge validation compares `new_finding_title` /
  `new_semantic_name` exactly (lowercase + trim), matching the Rust tool
  contract. The model occasionally paraphrases a title instead of copying it
  (`kerosine` → `kerosene`, or dropping an article), which rejects the whole
  merge chunk. Successful chunks are cached, so rerunning regenerates only the
  failing chunk and eventually lands an exact copy. If this recurs often, fix it
  with a deliberate prompt/validation change and a `PIPELINE_VERSION` bump — not
  by hand-editing rows mid-build.
- 2026-11-21 — Resuming batch 4 with only `[367]` could not repair the 47
  findings already built in 332/428: global repair is scoped to the requested
  contests while `finalize` checks the whole KG. Running the whole manifest
  (no `c4Ids`) repaired them and passed `links_have_status` without a reset.
- 2026-11-19 — Pilot contest 331 was built twice concurrently: the client-side
  tool abort did not stop the server-side build, and a resume started 81 s
  later. Both writers extracted before either inserted, so the KG holds 16
  semantics / 20 findings instead of the expected set. The single-writer lock
  now prevents this; the pilot must be reset (`force` on 331) and rebuilt.
