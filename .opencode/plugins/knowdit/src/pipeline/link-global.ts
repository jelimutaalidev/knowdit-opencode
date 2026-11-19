import type { KgDb } from "../db/client.ts";
import type { Journal } from "../journal.ts";
import { isModelLimitError } from "../llm/caller.ts";
import type { LlmCaller } from "../llm/types.ts";
import { buildFindingLinkEntry, buildGlobalLinkPrompt } from "../prompts/index.ts";
import { estimateTokens, partitionByBudget } from "./budget.ts";
import { resolveChunkTokens } from "./chunk.ts";
import { labelVariant, renderWithVariants } from "./render.ts";

/** Minimum byte length of a High/Medium entry's `why_finding_can_fire`. */
export const MIN_HIGH_MEDIUM_BYTES = 40;
/** Minimum byte length of a Low entry's `why_finding_can_fire`. */
export const MIN_LOW_BYTES = 15;
/** Minimum byte length of the verbatim quote a High entry must carry. */
export const HIGH_QUOTE_MIN_CHARS = 25;
export const MAX_LINK_ATTEMPTS = 3;

/** Fraction of a link prompt reserved for the findings block (reference CLI default). */
export const FINDING_TOKEN_RATIO = 0.35;
/** Hard cap on findings per request (reference CLI default). */
export const MAX_FINDINGS_PER_BATCH = 135;
/** Merged variants rendered per candidate/finding (reference CLI default). */
export const LINK_VARIANT_RENDER_CAP = 8;
/** Per-variant character cap for raw-children rendering (reference CLI default). */
export const LINK_RAW_CHILD_CHAR_CAP = 400;

type Strength = "High" | "Medium" | "Low";

const STRENGTH_RANK: Record<Strength, number> = { Low: 1, Medium: 2, High: 3 };

export type FindingLinkRow = {
  id: number;
  title: string;
  severity: string;
  root_cause: string;
  description: string;
  patterns: string;
  exploits: string;
  category: string;
  subcategory: string;
};

type FindingRow = FindingLinkRow & {
  platform_id: string | null;
};

type CandidateRow = {
  id: number;
  name: string;
  category: string;
  definition: string;
  description: string;
};

type ChildRow = {
  canonical_id: number;
  name: string;
  definition: string;
  description: string;
};

type FindingChildRow = {
  canonical_id: number;
  title: string;
  root_cause: string;
  description: string;
  patterns: string;
  exploits: string;
};

type ResolvedLink = {
  semanticId: number;
  strength: Strength;
  evidence: string;
};

type RenderedCandidate = CandidateRow & { body: string; tokens: number };
type RenderedFinding = {
  row: FindingRow;
  findingId: string;
  targetId: number;
  entry: string;
  tokens: number;
  projectCategories: string[];
};

/** Follow the `finding_merge` chain from a raw finding to its canonical. */
function resolveMergeTarget(id: number, mergeMap: ReadonlyMap<number, number>): number {
  let current = id;
  const seen = new Set<number>();
  while (mergeMap.has(current) && !seen.has(current)) {
    seen.add(current);
    current = mergeMap.get(current)!;
  }
  return current;
}

/**
 * Lowercase, straighten curly quotes, and collapse whitespace so verbatim-
 * quote membership survives line wrapping and case drift between the prompt
 * rendering and the model's copy of it. Mirrors the reference
 * `normalize_for_quote_match`.
 */
export function normalizeForQuoteMatch(text: string): string {
  let out = "";
  let lastSpace = false;
  for (const char of text) {
    const straight =
      char === "\u201C" || char === "\u201D"
        ? '"'
        : char === "\u2018" || char === "\u2019"
          ? "'"
          : char;
    if (/\s/u.test(straight)) {
      if (!lastSpace) {
        out += " ";
        lastSpace = true;
      }
    } else {
      out += straight.toLowerCase();
      lastSpace = false;
    }
  }
  return out;
}

const QUOTED_SPAN_RE = /"([^"]+)"/g;

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Quoted spans that are long enough to count as a High-tier verbatim quote. */
function quotedSpans(normalizedEvidence: string): string[] {
  const spans: string[] = [];
  for (const match of normalizedEvidence.matchAll(QUOTED_SPAN_RE)) {
    const span = (match[1] ?? "").trim();
    if (byteLength(span) >= HIGH_QUOTE_MIN_CHARS) spans.push(span);
  }
  return spans;
}

/**
 * True when `evidence` carries a quoted span of at least
 * {@link HIGH_QUOTE_MIN_CHARS} bytes that appears verbatim in the finding's
 * own rendered body — the reference's High-tier grounding rule.
 */
export function hasGroundedVerbatimQuote(findingBody: string, evidence: string): boolean {
  const spans = quotedSpans(normalizeForQuoteMatch(evidence));
  if (spans.length === 0) return false;
  const body = normalizeForQuoteMatch(findingBody);
  return spans.some((span) => body.includes(span));
}

function parseStrength(value: unknown): Strength {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "high") return "High";
  if (normalized === "medium") return "Medium";
  if (normalized === "low") return "Low";
  throw new Error(`unknown link strength '${String(value)}'`);
}

/**
 * Validate one batch response. Every emitted decision must reference a
 * finding id and candidate id shown in this prompt; silent omission of a
 * finding means "no link", matching the reference's final best-effort pass.
 */
function validateBatchDecisions(
  findings: readonly RenderedFinding[],
  candidateIds: ReadonlySet<number>,
): (value: unknown) => Map<string, ResolvedLink[]> {
  const byId = new Map(findings.map((finding) => [finding.findingId, finding]));
  return (value: unknown): Map<string, ResolvedLink[]> => {
    const links = (value as { links?: unknown } | null)?.links;
    if (!Array.isArray(links)) throw new Error("expected a links array");

    const out = new Map<string, ResolvedLink[]>();

    for (const raw of links) {
      const decision = raw as {
        finding_id?: unknown;
        semantic_evidence?: unknown;
      } | null;
      const findingId = String(decision?.finding_id ?? "").trim();
      const finding = byId.get(findingId);
      if (!finding) {
        throw new Error(
          `finding_id '${findingId}' is not in this prompt's "Findings To Link" section. ` +
            "Re-emit using one of the ids shown there exactly.",
        );
      }
      if (!Array.isArray(decision?.semantic_evidence)) {
        throw new Error(`finding '${findingId}' is missing semantic_evidence`);
      }

      const resolved = new Map<number, ResolvedLink>();
      for (const rawEvidence of decision.semantic_evidence) {
        const evidence = rawEvidence as {
          semantic_id?: unknown;
          strength?: unknown;
          why_finding_can_fire?: unknown;
        } | null;

        const semanticId = Number(evidence?.semantic_id);
        if (!Number.isInteger(semanticId) || !candidateIds.has(semanticId)) {
          throw new Error(
            `evidence references semantic_id '${String(evidence?.semantic_id)}' which is not ` +
              "in this prompt's Candidate Semantics list",
          );
        }

        const strength = parseStrength(evidence?.strength);
        const why = String(evidence?.why_finding_can_fire ?? "").trim();
        if (!why) {
          throw new Error(
            `evidence for semantic '${semanticId}' is empty; even Low strength needs a ` +
              `brief reason (>= ${MIN_LOW_BYTES} chars) explaining why the link is tangential`,
          );
        }

        const floor = strength === "Low" ? MIN_LOW_BYTES : MIN_HIGH_MEDIUM_BYTES;
        if (byteLength(why) < floor) {
          throw new Error(
            `evidence for semantic '${semanticId}' (strength=${strength}) is only ` +
              `${byteLength(why)} chars; the ${strength} tier requires at least ${floor} chars. ` +
              "Cite a specific behaviour from the semantic's description that matches the " +
              "finding's bug prerequisites.",
          );
        }

        if (strength === "High") {
          const spans = quotedSpans(normalizeForQuoteMatch(why));
          if (spans.length === 0) {
            throw new Error(
              `High evidence for semantic '${semanticId}' must include a VERBATIM fragment ` +
                `(>= ${HIGH_QUOTE_MIN_CHARS} chars, wrapped in double quotes) copied from that ` +
                "finding's own root_cause/description text. Re-emit with a real quote, or demote " +
                "the entry.",
            );
          }
          const normalizedBody = normalizeForQuoteMatch(finding.entry);
          if (!spans.some((span) => normalizedBody.includes(span))) {
            throw new Error(
              `none of the quoted fragments in your High evidence for semantic '${semanticId}' ` +
                "appear in that finding's own text. You may have MIXED UP finding ids — this " +
                "evidence may describe a different finding in the prompt. Re-check which finding " +
                "this evidence is really about and re-emit it under that finding_id (or " +
                "demote/drop this entry).",
            );
          }
        }

        const existing = resolved.get(semanticId);
        if (!existing || STRENGTH_RANK[strength] > STRENGTH_RANK[existing.strength]) {
          resolved.set(semanticId, { semanticId, strength, evidence: why });
        }
      }

      out.set(findingId, [...resolved.values()]);
    }

    return out;
  };
}

function renderCandidate(row: CandidateRow & { notes: readonly string[] }): string {
  const description = renderWithVariants(
    row.description,
    row.notes,
    LINK_VARIANT_RENDER_CAP,
    LINK_RAW_CHILD_CHAR_CAP,
  );
  return (
    `Candidate ID: ${row.id}\nCategory: ${row.category}\nName: ${row.name}\n` +
    `Definition: ${row.definition}\nDescription: ${description}\n\n`
  );
}

export type FindingNotes = {
  root_cause: string[];
  description: string[];
  patterns: string[];
  exploits: string[];
};

export function emptyFindingNotes(): FindingNotes {
  return { root_cause: [], description: [], patterns: [], exploits: [] };
}

/**
 * Load merged-raw notes for a set of canonical findings. Each note is a
 * labelled variant line, identical to the text the global linker renders.
 */
export function loadFindingNotes(
  db: StageContext["db"],
  findingIds: readonly number[],
): Map<number, FindingNotes> {
  const out = new Map<number, FindingNotes>();
  if (findingIds.length === 0) return out;
  const children = db.all<FindingChildRow>(
    `select fm.to_finding_id as canonical_id, af.title, af.root_cause, af.description,
            af.patterns, af.exploits
       from finding_merge fm
       join audit_finding af on af.id = fm.from_finding_id
      where fm.to_finding_id in (${findingIds.map(() => "?").join(", ")})
      order by fm.to_finding_id, af.id`,
    findingIds,
  );
  for (const child of children) {
    const notes = out.get(child.canonical_id) ?? emptyFindingNotes();
    notes.root_cause.push(labelVariant(child.title, child.root_cause));
    notes.description.push(labelVariant(child.title, child.description));
    notes.patterns.push(labelVariant(child.title, child.patterns));
    notes.exploits.push(labelVariant(child.title, child.exploits));
    out.set(child.canonical_id, notes);
  }
  return out;
}

/**
 * DeFi categories of every project that owns a finding, unioned and sorted by
 * category name, exactly as the reference builds the linking context for a
 * canonical finding after raw siblings fold into it.
 */
export function loadFindingCategories(
  db: StageContext["db"],
  findingId: number,
): string[] {
  const names = db
    .all<{ name: string }>(
      `select c.name
         from project_finding pf
         join project_category pc on pc.project_id = pf.project_id
         join category c on c.id = pc.category_id
        where pf.audit_finding_id = ?`,
      [findingId],
    )
    .map((row) => row.name);
  names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return names.filter((name, index) => index === 0 || name !== names[index - 1]);
}

export function renderFinding(
  row: FindingLinkRow,
  projectCategories: readonly string[],
  notes: FindingNotes,
): { findingId: string; entry: string } {
  const findingId = `F-${row.id}`;
  const entry = buildFindingLinkEntry({
    findingId,
    projectCategories,
    title: row.title,
    severity: row.severity,
    category: row.category,
    subcategory: row.subcategory,
    rootCause: renderWithVariants(
      row.root_cause,
      notes.root_cause,
      LINK_VARIANT_RENDER_CAP,
      LINK_RAW_CHILD_CHAR_CAP,
    ),
    description: renderWithVariants(
      row.description,
      notes.description,
      LINK_VARIANT_RENDER_CAP,
      LINK_RAW_CHILD_CHAR_CAP,
    ),
    patterns: renderWithVariants(
      row.patterns,
      notes.patterns,
      LINK_VARIANT_RENDER_CAP,
      LINK_RAW_CHILD_CHAR_CAP,
    ),
    exploits: renderWithVariants(
      row.exploits,
      notes.exploits,
      LINK_VARIANT_RENDER_CAP,
      LINK_RAW_CHILD_CHAR_CAP,
    ),
  });
  return { findingId, entry };
}

/**
 * Strongest-strength wins per (semantic, finding). Equal-rank collisions keep
 * the existing row, so an in-project synthetic High is never replaced by a
 * global High. The `evidence` sticks with the strength that wins.
 */
function upsertLink(
  db: KgDb,
  findingId: number,
  link: ResolvedLink,
): void {
  const existing = db.get<{ strength: Strength }>(
    `select strength from semantic_finding_link
      where semantic_node_id = ? and audit_finding_id = ?`,
    [link.semanticId, findingId],
  );
  if (!existing) {
    db.run(
      `insert into semantic_finding_link
         (semantic_node_id, audit_finding_id, strength, evidence)
       values (?, ?, ?, ?)`,
      [link.semanticId, findingId, link.strength, link.evidence],
    );
    return;
  }
  if (STRENGTH_RANK[link.strength] > STRENGTH_RANK[existing.strength]) {
    db.run(
      `update semantic_finding_link set strength = ?, evidence = ?
        where semantic_node_id = ? and audit_finding_id = ?`,
      [link.strength, link.evidence, link.semanticId, findingId],
    );
  }
}

export async function linkGlobal(opts: {
  db: KgDb;
  llm: LlmCaller;
  journal: Journal;
  c4Ids?: number[];
  contextWindow?: number;
  onProgress?: (update: Record<string, unknown>) => void | Promise<void>;
}): Promise<{ linked: number; pendingQueued: number; pendingDrained: number }> {
  const { db, llm, journal } = opts;
  const emit = async (update: Record<string, unknown>) => {
    if (opts.onProgress) await opts.onProgress(update);
  };

  const candidateRows = db.all<CandidateRow>(
    `select id, name, category, definition, description
       from semantic_node
      where not exists (select 1 from semantic_merge sm where sm.from_semantic_id = semantic_node.id)
      order by id`,
  );
  // The reference groups candidates then orders groups by
  // (category.as_str, name, canonical_id) before chunking.
  candidateRows.sort((left, right) =>
    left.category < right.category
      ? -1
      : left.category > right.category
        ? 1
        : left.name < right.name
          ? -1
          : left.name > right.name
            ? 1
            : left.id - right.id,
  );

  const pendingDrained = db.run(
    `delete from pending_semantic
      where semantic_node_id in (
        select id from semantic_node
         where not exists (select 1 from semantic_merge sm where sm.from_semantic_id = semantic_node.id)
      )`,
  ).changes;

  const filters: string[] = [
    "not exists (select 1 from finding_link_status fls where fls.audit_finding_id = af.id)",
  ];
  const params: unknown[] = [];
  if (opts.c4Ids && opts.c4Ids.length > 0) {
    filters.push(
      `exists (
         select 1 from project_finding pf
           join project_platform pp on pp.project_id = pf.project_id
          where pf.audit_finding_id = af.id
            and pp.platform_id in (${opts.c4Ids.map(() => "?").join(", ")})
       )`,
    );
    params.push(...opts.c4Ids.map((id) => `c4-${id}`));
  }

  const findings = db.all<FindingRow>(
    `select af.id, af.title, af.severity, af.root_cause, af.description, af.patterns,
            af.exploits, fc.category, fc.name as subcategory,
            (select pp.platform_id
               from project_finding pf
               join project_platform pp on pp.project_id = pf.project_id
              where pf.audit_finding_id = af.id
              limit 1) as platform_id
       from audit_finding af
       join audit_finding_category afc on afc.audit_finding_id = af.id
       join finding_category fc on fc.id = afc.finding_category_id
      where ${filters.join(" and ")}
      order by af.id`,
    params,
  );

  const unitFor = (finding: FindingRow) => {
    const c4Id = finding.platform_id?.startsWith("c4-")
      ? Number(finding.platform_id.slice(3))
      : 0;
    return { stage: "link_global", c4Id, unitIndex: finding.id };
  };

  const projectCategories = (findingId: number): string[] =>
    loadFindingCategories(db, findingId);

  const finishFinding = async (finding: FindingRow, position: number): Promise<void> => {
    db.tx(() => {
      db.run(
        "insert or replace into finding_link_status (audit_finding_id) values (?)",
        [finding.id],
      );
    });
    journal.done(unitFor(finding));
    await emit({
      event: "global_finding",
      index: position,
      total: findings.length,
      c4Id: unitFor(finding).c4Id,
      findingId: finding.id,
      status: "done",
    });
  };

  // No candidates: the reference still marks every finding processed with no
  // links. This also prevents an endless "repair missing status" loop.
  if (candidateRows.length === 0) {
    for (let index = 0; index < findings.length; index++) {
      await finishFinding(findings[index], index + 1);
    }
    await emit({
      event: "global_done",
      linked: findings.length,
      failed: 0,
      pendingDrained,
      stoppedEarly: false,
    });
    return { linked: findings.length, pendingQueued: 0, pendingDrained };
  }

  const candidateNotes = new Map<number, string[]>();
  const candidateIds = candidateRows.map((row) => row.id);
  if (candidateIds.length > 0) {
    const children = db.all<ChildRow>(
      `select sm.to_semantic_id as canonical_id, sn.name, sn.definition, sn.description
         from semantic_merge sm
         join semantic_node sn on sn.id = sm.from_semantic_id
        where sm.to_semantic_id in (${candidateIds.map(() => "?").join(", ")})
        order by sm.to_semantic_id, sn.id`,
      candidateIds,
    );
    for (const child of children) {
      const notes = candidateNotes.get(child.canonical_id) ?? [];
      notes.push(labelVariant(child.name, child.description));
      candidateNotes.set(child.canonical_id, notes);
    }
  }

  const renderedCandidates: RenderedCandidate[] = candidateRows.map((row) => {
    const body = renderCandidate({ ...row, notes: candidateNotes.get(row.id) ?? [] });
    return { ...row, body, tokens: estimateTokens(body) };
  });

  const findingNotes = loadFindingNotes(
    db,
    findings.map((row) => row.id),
  );
  const mergeMap = new Map(
    db
      .all<{ from_finding_id: number; to_finding_id: number }>(
        "select from_finding_id, to_finding_id from finding_merge",
      )
      .map((edge) => [edge.from_finding_id, edge.to_finding_id]),
  );

  const renderedFindings: RenderedFinding[] = findings.map((row) => {
    const categories = projectCategories(row.id);
    const { findingId, entry } = renderFinding(
      row,
      categories,
      findingNotes.get(row.id) ?? emptyFindingNotes(),
    );
    return {
      row,
      findingId,
      targetId: resolveMergeTarget(row.id, mergeMap),
      entry,
      tokens: estimateTokens(entry),
      projectCategories: categories,
    };
  });

  const inputBudget = resolveChunkTokens({ contextWindow: opts.contextWindow });
  const prefixTokens = estimateTokens(
    buildGlobalLinkPrompt({ candidateSemantics: "", findings: "" }),
  );
  const availableAfterPrefix = Math.max(1, inputBudget - prefixTokens);
  const findingBudget = Math.min(
    Math.max(1, Math.floor(inputBudget * FINDING_TOKEN_RATIO)),
    availableAfterPrefix,
  );
  const semanticBudget = Math.max(1, inputBudget - prefixTokens - findingBudget);

  const candidateChunks = partitionByBudget(
    renderedCandidates,
    semanticBudget,
    Number.POSITIVE_INFINITY,
    (candidate) => candidate.tokens,
  );
  const findingBatches = partitionByBudget(
    renderedFindings,
    findingBudget,
    MAX_FINDINGS_PER_BATCH,
    (finding) => finding.tokens,
  );

  let linked = 0;
  const failures = new Map<number, string>();
  const completedChunks = new Map<number, number>();
  const started = new Set<number>();
  let stoppedEarly = false;

  await emit({
    event: "global_start",
    candidates: candidateRows.length,
    findings: findings.length,
    candidateChunks: candidateChunks.length,
    findingBatches: findingBatches.length,
  });

  for (let chunkIndex = 0; chunkIndex < candidateChunks.length && !stoppedEarly; chunkIndex++) {
    const chunk = candidateChunks[chunkIndex];
    const candidateBlock = chunk.map((candidate) => candidate.body).join("");
    const chunkIds = new Set(chunk.map((candidate) => candidate.id));

    for (const batch of findingBatches) {
      if (stoppedEarly) break;
      const active = batch.filter((finding) => !failures.has(finding.row.id));
      if (active.length === 0) continue;

      for (const finding of active) {
        if (started.has(finding.row.id)) continue;
        started.add(finding.row.id);
        journal.start(unitFor(finding.row));
        await emit({
          event: "global_finding",
          index: renderedFindings.indexOf(finding) + 1,
          total: findings.length,
          c4Id: unitFor(finding.row).c4Id,
          findingId: finding.row.id,
          status: "start",
        });
      }

      // Findings already decided in this candidate chunk carry over between
      // coverage attempts; each retry re-asks only the still-missing ones
      // (reference `max_response_attempts` semantics). After the cap, a
      // finding with no decision is treated as an explicit no-link result.
      const collected = new Map<string, ResolvedLink[]>();
      const missing = (): RenderedFinding[] =>
        active.filter((finding) => !collected.has(finding.findingId));

      let batchError: string | null = null;
      for (let attempt = 0; attempt < MAX_LINK_ATTEMPTS; attempt++) {
        const pending = missing();
        if (pending.length === 0) break;

        const basePrompt = buildGlobalLinkPrompt({
          candidateSemantics: candidateBlock,
          findings: pending.map((finding) => finding.entry).join(""),
        });

        let decisions: Map<string, ResolvedLink[]> | null = null;
        let lastError: unknown = new Error("global linking made no attempts");

        for (let callAttempt = 0; callAttempt < MAX_LINK_ATTEMPTS; callAttempt++) {
          try {
            const { value } = await llm.json({
              prompt:
                callAttempt === 0
                  ? basePrompt
                  : `${basePrompt}\n\nYour previous response was rejected: ${
                      lastError instanceof Error ? lastError.message : String(lastError)
                    }\nRe-emit valid JSON for the findings in this prompt only.`,
              validate: validateBatchDecisions(pending, chunkIds),
            });
            decisions = value;
            break;
          } catch (error) {
            lastError = error;
            if (isModelLimitError(error)) break;
          }
        }

        if (decisions === null) {
          batchError = lastError instanceof Error ? lastError.message : String(lastError);
          if (isModelLimitError(lastError)) stoppedEarly = true;
          break;
        }

        for (const [findingId, links] of decisions) collected.set(findingId, links);
      }

      const expected = candidateChunks.length;
      if (batchError !== null) {
        for (const finding of active) failures.set(finding.row.id, batchError);
        continue;
      }

      db.tx(() => {
        for (const finding of active) {
          for (const link of collected.get(finding.findingId) ?? []) {
            upsertLink(db, finding.targetId, link);
          }
        }
      });
      for (const finding of active) {
        const done = (completedChunks.get(finding.row.id) ?? 0) + 1;
        completedChunks.set(finding.row.id, done);
        if (done >= expected) await finishFinding(finding.row, renderedFindings.indexOf(finding) + 1);
      }
    }
  }

  const failureList: { findingId: number; error: string }[] = [];
  for (const finding of renderedFindings) {
    if (completedChunks.get(finding.row.id) === candidateChunks.length) {
      linked += 1;
      continue;
    }

    const message =
      failures.get(finding.row.id) ??
      `only ${completedChunks.get(finding.row.id) ?? 0}/${candidateChunks.length} ` +
        "candidate chunk(s) completed";
    journal.fail(unitFor(finding.row), message);
    failureList.push({ findingId: finding.row.id, error: message });
    await emit({
      event: "global_finding",
      index: renderedFindings.indexOf(finding) + 1,
      total: findings.length,
      c4Id: unitFor(finding.row).c4Id,
      findingId: finding.row.id,
      status: "failed",
      error: message,
    });
  }

  await emit({
    event: "global_done",
    linked,
    failed: failureList.length,
    pendingDrained,
    stoppedEarly,
  });

  if (failureList.length > 0) {
    const suffix = stoppedEarly
      ? " Stopped early on a model limit; remaining findings are unprocessed."
      : " Rerun kg_build to retry only findings without a link status.";
    throw new Error(
      `global link failed for ${failureList.length} finding(s); first error: ` +
        `${failureList[0].error}.${suffix}`,
    );
  }

  return { linked, pendingQueued: 0, pendingDrained };
}
