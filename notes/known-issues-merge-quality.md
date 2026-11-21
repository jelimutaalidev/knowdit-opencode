# Known issue — merge quality (deferred 2026-11-21)

Status: **known, deliberately not fixed.** The owner chose to keep testing the
current KG first and decide later. This note exists so a future session can pick
the work up without re-deriving it.

The current KG (`data/kg.sqlite`, build `2026-11-19.p0p1.4`) is structurally
valid: `validate-db` passes, the integrity gate is 10/10, and the snapshot
bundle matches `identity.json`. Nothing here is data corruption. These are
content-quality defects produced by LLM judgement plus one weak deterministic
dedup key.

## Summary of the three defects

| # | Defect | Measured impact | Cause |
| --- | --- | --- | --- |
| 1 | One finding extracted twice | Medium total 100 vs 99 expected; C4-367 Medium 10 vs 9 | `dedupFindings` uses the exact lowercased title as its only key |
| 2 | Cross-project finding merges are too broad | 8 of 10 merge edges fold same-class (not same-bug) findings from different protocols into one canonical | Merge decision is LLM-only; there is no deterministic evidence gate |
| 3 | Low/Non-Critical coverage is partial | Some report Low/NC items have no KG row | Report headings mix `[L-xx]`, `[NN]`, `[N-xx]`; extraction does not require full coverage |

Non-issues, for the record:

- 8 of 106 canonical semantics have no finding link. Semantics are DeFi
  *mechanism* semantics by design (`src/prompts/texts/extract_semantics_suffix.txt`),
  so a mechanism with no submitted finding is legitimate.
- `contest_status` is empty because no contest was skipped; the snapshot identity
  reports `contests: 0`. Cosmetic.

## Defect 1 — duplicate finding (C4-367, M-05)

Evidence:

- Finding **472** `No incentive to liquidate small positions could result in
  protocol going underwater` (no `[M-05]` prefix in the title) matches the
  report heading title for `M-05` verbatim.
- Finding **473** `[M-05] Liquidating small positions is unprofitable and
  leaves the protocol with bad debt` carries the explicit `[M-05]` tag.
- Both carry the same two semantic links at `High`, and their root causes
  describe the same missing liquidation incentive.
- Their categories differ (`Denial of Services / Contract Could Lock Ether` vs
  `Access Control / Missing Input Validation`), so taxonomy cannot be used to
  dedup them.

One-to-one report mapping: 160 of 161 `[H-xx]`/`[M-xx]` headings across all 12
reports map to exactly one KG finding. Finding 473 is the only extra.

Cause: `src/pipeline/extract-findings.ts:32` (`dedupFindings`) keys on
`finding.title.toLowerCase().trim()` only. It never sees the report heading or
the optional `[M-xx]` prefix.

Reproduce:

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/kg.sqlite", { readOnly: true });
for (const r of db.prepare(`
  select af.id, af.severity, af.title
    from audit_finding af
    join project_finding pf on pf.audit_finding_id = af.id
    join project_platform pp on pp.project_id = pf.project_id
   where pp.platform_id = "c4-367" and af.severity = "Medium"
   order by af.id`).all()) console.log(r.id, r.title);
'
```

Expect 10 rows; the report has `M-01`…`M-09`.

## Defect 2 — over-broad cross-project merges

The 10 `finding_merge` edges (all cross-contest):

```
392 -> 282   Neobase  -> Canto      "Improper parallel time system" -> "[H-01] update_market() market weight incorrect"
396 -> 288   Neobase  -> Canto      "claim ... revert if market removed" -> "[L-03] Loss of rewards ... market blacklisted"
301 -> 289   Asymmetry-> Kelp       arbitrage from price discrepancy -> arbitrage from Chainlink price discrepancy
311 -> 293   Asymmetry-> Kelp       "Missing deadline check for AfEth actions" -> "[M-02] Lack of slippage control ..."
408 -> 293   Decent   -> Kelp       "Lack of deadline protection for swap" -> same
453 -> 293   Superpos.-> Kelp       "[L-09] Lack of a deadline parameter ..." -> same
479 -> 303   Dyad     -> Asymmetry  "CR ... unsafe dependence on vault.getUsdValue()" -> invalid Chainlink response
486 -> 317   Dyad     -> Asymmetry  single-step owner transfer -> "Use Ownable2Step"
334 -> 320   Gondi    -> Asymmetry  division before multiplication -> precision loss
409 -> 329   Decent   -> Asymmetry  "Lack of address existence check" -> "Low level calls ... no code will not fail"
```

Measured signals for every edge:

- shared code identifiers (backticks, camelCase, snake_case): **0 of 10**
- `root_cause` token Jaccard: **0.09 – 0.26**
- title token Jaccard: **0.00 – 0.50**
- identical `(category, subcategory)`: **10 of 10** (not discriminating)

Consequence: a similarity threshold low enough to keep these would accept false
merges, which is worse than duplicates. All edges into 293 (`[M-02]` Kelp) fold
distinct findings from Asymmetry, Decent, and Superposition into one canonical.

What is *not* lost: every source finding row, its `project_finding` rows, and the
merge edge (with `appended_*` deltas) remain. The only lossy part is the
canonical grouping and title.

Cause: `src/pipeline/merge.ts:784` (`planFindingMerges`) and
`src/pipeline/merge.ts:888` (`mergeContest`) trust the model's
`merge_target_ids`. `src/prompts/texts/merge_findings.txt` states the right
criterion ("same concrete state-variable drift", "when in doubt prefer NEW") but
nothing enforces it deterministically.

Reproduce:

```bash
node -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/kg.sqlite", { readOnly: true });
for (const r of db.prepare(`
  select fm.from_finding_id f, fm.to_finding_id t,
         (select group_concat(pp.platform_id) from project_finding pf
            join project_platform pp on pp.project_id = pf.project_id
           where pf.audit_finding_id = fm.from_finding_id) src,
         (select group_concat(pp.platform_id) from project_finding pf
            join project_platform pp on pp.project_id = pf.project_id
           where pf.audit_finding_id = fm.to_finding_id) dst,
         (select title from audit_finding where id = fm.from_finding_id) st,
         (select title from audit_finding where id = fm.to_finding_id) tt
    from finding_merge fm order by fm.to_finding_id, fm.from_finding_id`).all())
  console.log(r.f, "->", r.t, "|", r.src, "->", r.dst, "\n   ", r.st, "\n   ", r.tt);
'
```

## Defect 3 — partial Low/Non-Critical coverage

Low sections use several heading shapes; extraction kept a subset. Example:
C4-453 has 13 Low/NC headings but 7 Low rows; C4-286 has 22 headings, 17 rows.
High/Medium remain one-to-one with report headings (except Defect 1).

This is a scope/coverage decision, not a reference break. Fix it only together
with an explicit extraction requirement (and expect a larger, noisier Low set).

## Fix options (decide before the next rebuild)

Any of these changes persisted KG content, so each needs a
`PIPELINE_VERSION` bump, `reset_all` with a reason, and a full rebuild. Do **not**
hand-edit rows in the current KG.

### Dedup (independent of the option chosen)

Build a report-ID map at extraction time and use it as the dedup key:

1. Parse the contest report headings into `{ normalizedTitle -> reportId }`.
   `src/dataset/prepare.ts:14` already has the H/M marker regex; extend it to
   cover `[L-xx]`, `[N-xx]`, and `[NN]` inside the Low/NC section.
2. For each extracted finding, derive `reportId` from an explicit `[…-xx]`
   prefix, or by matching its normalized title against the heading map.
3. Group findings by `reportId` (and keep the existing exact-title key as a
   fallback). Merge duplicates with the same field-widening logic already in
   `dedupFindings`.

This catches 472/473 deterministically without any model change. Tests: fixture
with both real titles + a heading map; assert one finding survives with the
strongest severity and the longer fields.

### Option A — findings are project-local (recommended)

Do not merge findings across projects. Cross-project reuse stays in the semantic
layer.

- Implementation: in `planFindingMerges`, reject a target whose project set does
  not intersect the raw's project; log/ignore the decision.
- Result: `finding_merge` empty, findings raw = canonical (259 = 259), per-contest
  High/Medium match the report headings exactly.
- Cost: loses the same-codebase Canto/Neobase fold (two edges). That is
  acceptable; those are still two contests.
- Tests: cross-project decision → NEW; same-project decision → merge; stats
  formula test updated (canonical == total).

### Option B — evidence-gated cross-project merges

Keep the capability, require proof.

- Add `shared_evidence` to `emit_finding_merge_decision` for cross-project
  targets: a quoted span copied from both findings.
- Validate with the existing rule: `hasGroundedVerbatimQuote`
  (`src/pipeline/link-global.ts:148`, `HIGH_QUOTE_MIN_CHARS = 25` at line 15)
  against **both** rendered bodies; otherwise reject the decision as NEW.
- Cost: prompt + schema + validation + retries; still LLM-dependent. The exact
  title incident shows validation retries can slow a build.

### Option C — dedup only

Fix Defect 1, leave merges as they are. Cheapest, but the class-level folds
remain and will grow with more contests.

## Post-rebuild acceptance gates

1. `npm test` green with the new fixtures.
2. `node scripts/verify-compat.ts --db data/kg.sqlite` → `compat OK`.
3. For every contest, KG High/Medium counts equal the report `[H-xx]`/`[M-xx]`
   heading counts; no extras.
4. `finding_merge` contains only edges accepted by the chosen policy; print each
   edge's source/target projects and titles for manual review.
5. `knowdit_kg_stats` and the snapshot identity agree with the new canonical
   counts.
6. `npm run state:snapshot -- --out ~/knowdit-state/<new-bundle>` and confirm the
   bundle hashes match `identity.json`.

## Relevant code

- `src/pipeline/extract-findings.ts:32` — `dedupFindings`, exact-title key.
- `src/pipeline/merge.ts:784` — `planFindingMerges` (LLM decisions, no guard).
- `src/pipeline/merge.ts:888` — `mergeContest` (selects `rawFindings`, applies plan).
- `src/prompts/texts/merge_findings.txt` — merge criteria (correct, unenforced).
- `src/dataset/prepare.ts:14` — report heading regex used by `countExpected`.
- `src/pipeline/link-global.ts:15,148` — 25-char verbatim quote rule to reuse.
- `src/db/schema.sql` — vendored; do not edit.
