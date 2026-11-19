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

## Verification gate

- [x] `npm test` green (165/165)
- [ ] `scripts/verify-compat.ts` green — blocked on a clean rebuild; the
      existing `data/kg.sqlite` predates the fixes and fails Rust `validate-db`
      with partial-link-state rows (126 issues)
- [x] Focused re-audit complete — 3 findings fixed (candidate order, repair echoes,
      taxonomy gate); 165/165 green after the final version bump
- [ ] Explicit user approval before rebuild/reset
