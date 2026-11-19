import { buildMergePrompt, GENERAL_ROLE_SYSTEM } from "../prompts/index.ts";
import { estimateTokens, partitionByBudget } from "./budget.ts";
import { resolveChunkTokens } from "./chunk.ts";
import { findProject } from "./project.ts";
import type { StageContext } from "./types.ts";

export type SemanticMergeDecision =
  | { action: "new" }
  | {
      action: "merge";
      targetIds: number[];
      updatedDescription?: string;
      appendedDescription?: string;
    };

export type FindingMergeDecision =
  | { action: "new" }
  | {
      action: "merge";
      targetIds: number[];
      updatedDescription?: string;
      updatedPatterns?: string;
      updatedExploits?: string;
      appendedDescription?: string;
      appendedPatterns?: string;
      appendedExploits?: string;
    };

/** Hard cap on one mutable canonical field (reference CLI default). */
export const MERGE_MAX_FIELD_CHARS = 2_000;
/** Below this current length a field is too thin to protect from rewriting. */
export const MERGE_CONCRETE_FLOOR = 160;
/** A replacement shorter than this fraction of a substantial current value is an abstraction. */
export const MERGE_MIN_SHRINK_RATIO = 0.6;
/** Cap on a merge edge's required `appended_*` note. */
export const MERGE_APPENDED_MAX_CHARS = 600;
/** Share of the usable merge window reserved for the new-items block. */
export const NEW_ITEM_TOKEN_RATIO = 0.85;
/** Count cap on new items per merge agent (reference CLI default). */
export const NEW_ITEM_BATCH_SIZE = 40;
/** Minimum tokens handed to either merge block. */
export const MIN_MERGE_BLOCK_TOKENS = 2_048;

export type MergeGuard = {
  maxChars: number;
  concreteFloor: number;
  minShrinkRatio: number;
  appendedMaxChars: number;
};

export const DEFAULT_MERGE_GUARD: MergeGuard = {
  maxChars: MERGE_MAX_FIELD_CHARS,
  concreteFloor: MERGE_CONCRETE_FLOOR,
  minShrinkRatio: MERGE_MIN_SHRINK_RATIO,
  appendedMaxChars: MERGE_APPENDED_MAX_CHARS,
};

/**
 * Split an already-computed usable budget between the candidate block and the
 * new-items block. The new-items budget is taken first and candidates get the
 * remainder, so the two sum to `usable` whenever neither floor bites. Mirrors
 * the reference `MergeWindowSplit::from_usable`.
 */
export function splitMergeWindow(
  usableTokens: number,
  newItemTokenRatio: number,
): { newItemBudget: number; candidateBudget: number } {
  const ratio = Math.min(0.95, Math.max(0.05, newItemTokenRatio));
  const newItemBudget = Math.max(
    Math.floor(usableTokens * ratio),
    MIN_MERGE_BLOCK_TOKENS,
  );
  const candidateBudget = Math.max(
    usableTokens - newItemBudget,
    MIN_MERGE_BLOCK_TOKENS,
  );
  return { newItemBudget, candidateBudget };
}

const IDENTITY_FIELDS = ["name", "definition", "title", "severity", "root_cause"] as const;

function rejectIdentityFields(decision: object): void {
  for (const field of IDENTITY_FIELDS) {
    if (field in decision) {
      throw new Error(`merge decision must not carry the identity field '${field}'`);
    }
  }
}

function trimmed(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function nonEmpty(value: string | undefined): string | undefined {
  const text = trimmed(value);
  return text ? text : undefined;
}

function charCount(text: string): number {
  return [...text].length;
}

function assertCanonicalTarget(
  db: StageContext["db"],
  opts: {
    table: "semantic_node" | "audit_finding";
    edgeTable: "semantic_merge" | "finding_merge";
    fromColumn: "from_semantic_id" | "from_finding_id";
    rawId: number;
    targetId: number;
  },
): void {
  if (opts.targetId === opts.rawId) {
    throw new Error(`merge target ${opts.targetId} is the raw row itself`);
  }
  const target = db.get<{ id: number }>(`select id from ${opts.table} where id = ?`, [
    opts.targetId,
  ]);
  if (!target) throw new Error(`merge target ${opts.targetId} does not exist`);
  const outgoing = db.get<{ n: number }>(
    `select 1 as n from ${opts.edgeTable} where ${opts.fromColumn} = ? limit 1`,
    [opts.targetId],
  );
  if (outgoing) throw new Error(`merge target ${opts.targetId} is not canonical`);
}

function copySemanticProvenance(
  db: StageContext["db"],
  rawId: number,
  targetId: number,
): void {
  db.run(
    `insert or ignore into project_semantic (project_id, semantic_node_id)
     select project_id, ? from project_semantic where semantic_node_id = ?`,
    [targetId, rawId],
  );
}

function copyFindingProvenance(
  db: StageContext["db"],
  rawId: number,
  targetId: number,
): void {
  db.run(
    `insert or ignore into project_finding (project_id, audit_finding_id)
     select project_id, ? from project_finding where audit_finding_id = ?`,
    [targetId, rawId],
  );
}

export function applySemanticMerge(
  db: StageContext["db"],
  rawId: number,
  decision: SemanticMergeDecision,
): void {
  if (decision.action === "new") return;
  rejectIdentityFields(decision as object);

  const appended = trimmed(decision.appendedDescription);
  if (!appended) throw new Error("an appended note is required for a semantic merge");
  if (decision.targetIds.length === 0) throw new Error("a merge requires at least one target");

  for (const targetId of decision.targetIds) {
    assertCanonicalTarget(db, {
      table: "semantic_node",
      edgeTable: "semantic_merge",
      fromColumn: "from_semantic_id",
      rawId,
      targetId,
    });
  }

  for (const targetId of decision.targetIds) {
    db.run(
      `insert or replace into semantic_merge
         (from_semantic_id, to_semantic_id, appended_description)
       values (?, ?, ?)`,
      [rawId, targetId, appended],
    );

    const updated = trimmed(decision.updatedDescription);
    if (updated) {
      db.run("update semantic_node set description = ? where id = ?", [updated, targetId]);
    }

    copySemanticProvenance(db, rawId, targetId);
  }
}

export function applyFindingMerge(
  db: StageContext["db"],
  rawId: number,
  decision: FindingMergeDecision,
): void {
  if (decision.action === "new") return;
  rejectIdentityFields(decision as object);

  const appendedDescription = trimmed(decision.appendedDescription);
  const appendedPatterns = trimmed(decision.appendedPatterns);
  const appendedExploits = trimmed(decision.appendedExploits);
  if (!appendedDescription && !appendedPatterns && !appendedExploits) {
    throw new Error("an appended note is required for a finding merge");
  }
  if (decision.targetIds.length === 0) throw new Error("a merge requires at least one target");

  for (const targetId of decision.targetIds) {
    assertCanonicalTarget(db, {
      table: "audit_finding",
      edgeTable: "finding_merge",
      fromColumn: "from_finding_id",
      rawId,
      targetId,
    });
  }

  for (const targetId of decision.targetIds) {
    db.run(
      `insert or replace into finding_merge
         (from_finding_id, to_finding_id, appended_description, appended_patterns, appended_exploits)
       values (?, ?, ?, ?, ?)`,
      [rawId, targetId, appendedDescription, appendedPatterns, appendedExploits],
    );

    const updatedDescription = trimmed(decision.updatedDescription);
    const updatedPatterns = trimmed(decision.updatedPatterns);
    const updatedExploits = trimmed(decision.updatedExploits);
    if (updatedDescription) {
      db.run("update audit_finding set description = ? where id = ?", [
        updatedDescription,
        targetId,
      ]);
    }
    if (updatedPatterns) {
      db.run("update audit_finding set patterns = ? where id = ?", [updatedPatterns, targetId]);
    }
    if (updatedExploits) {
      db.run("update audit_finding set exploits = ? where id = ?", [updatedExploits, targetId]);
    }

    copyFindingProvenance(db, rawId, targetId);
  }
}

// ── mergeContest ────────────────────────────────────────────────────────────

type SemanticRow = {
  id: number;
  category: string;
  name: string;
  definition: string;
  description: string;
};

type FindingRow = {
  id: number;
  severity: string;
  category: string;
  subcategory: string;
  title: string;
  root_cause: string;
  description: string;
  patterns: string;
  exploits: string;
};

type SemanticWork = SemanticRow & { text: string; tokens: number };
type SemanticCandidateWork = SemanticWork & { children: SemanticRow[] };
type FindingWork = FindingRow & { text: string; tokens: number };
type FindingCandidateWork = FindingWork & { children: FindingRow[] };

function renderSemanticCandidate(
  row: SemanticRow,
  children: readonly SemanticRow[],
): string {
  let out =
    `ID: ${row.id}\nCategory: ${row.category}\nName: ${row.name}\n` +
    `Definition: ${row.definition}\nDescription: ${row.description}\n`;
  if (children.length > 0) {
    out +=
      "Merged from (historical raws — for context, not selectable as merge_target_ids):\n";
    for (const child of children) {
      out += `  - Name: ${child.name}\n    Definition: ${child.definition}\n`;
      out += `    Description: ${child.description}\n`;
    }
  }
  return `${out}\n`;
}

function renderSemanticIncoming(row: SemanticRow): string {
  return (
    `Category: ${row.category}\nName: ${row.name}\nDefinition: ${row.definition}\n` +
    `Description: ${row.description}\n\n`
  );
}

function renderFindingCandidate(
  row: FindingRow,
  children: readonly FindingRow[],
): string {
  let out =
    `ID: ${row.id}\nSeverity: ${row.severity}\nCategory: ${row.category}\n` +
    `Subcategory: ${row.subcategory}\nTitle: ${row.title}\nRoot Cause: ${row.root_cause}\n` +
    `Description: ${row.description}\nPatterns: ${row.patterns}\nExploits: ${row.exploits}\n`;
  if (children.length > 0) {
    out +=
      "Merged from (historical raws — for context, not selectable as merge_target_ids):\n";
    for (const child of children) {
      out += `  - Title: ${child.title}\n    Severity: ${child.severity}\n`;
      out += `    Root Cause: ${child.root_cause}\n    Description: ${child.description}\n`;
      out += `    Patterns: ${child.patterns}\n    Exploits: ${child.exploits}\n`;
    }
  }
  return `${out}\n`;
}

function renderFindingIncoming(row: FindingRow): string {
  return (
    `Severity: ${row.severity}\nCategory: ${row.category}\nSubcategory: ${row.subcategory}\n` +
    `Title: ${row.title}\nRoot Cause: ${row.root_cause}\nDescription: ${row.description}\n` +
    `Patterns: ${row.patterns}\nExploits: ${row.exploits}\n\n`
  );
}

/**
 * Reject an `updated_*` replacement that is over-long or markedly shortens an
 * already-substantial current value. Shrinking a concrete write-up toward a
 * generic label is the signature of over-generalization at merge time.
 */
function checkFieldUpdate(opts: {
  field: string;
  label: string;
  candidate: string;
  targetIds: readonly number[];
  currentOf: (id: number) => string | undefined;
  guard: MergeGuard;
}): void {
  const candidateLength = charCount(opts.candidate);
  if (candidateLength > opts.guard.maxChars) {
    throw new Error(
      `the \`${opts.field}\` for '${opts.label}' is ${candidateLength} chars — too long. ` +
        `Keep it a concise, self-contained concrete representative (≤ ${opts.guard.maxChars} chars).`,
    );
  }
  for (const id of opts.targetIds) {
    const current = opts.currentOf(id);
    if (current === undefined) continue;
    const currentLength = charCount(current.trim());
    if (
      currentLength >= opts.guard.concreteFloor &&
      candidateLength < currentLength * opts.guard.minShrinkRatio
    ) {
      throw new Error(
        `the \`${opts.field}\` proposed for canonical #${id} (${candidateLength} chars) is far ` +
          `shorter than its current value (${currentLength} chars) — that reads as a ` +
          "generalization. Re-emit at least as concrete and complete as the current value, " +
          `or omit \`${opts.field}\` to keep it.`,
      );
    }
  }
}

/** Require a bounded one-or-two-sentence per-edge delta on every merge. */
function checkAppendedNote(
  field: string,
  label: string,
  note: string | undefined,
  guard: MergeGuard,
): void {
  const text = trimmed(note);
  if (!text) {
    throw new Error(
      `\`${field}\` is required when merging '${label}' — say in one or two sentences how ` +
        "this raw extends the canonical (its concrete delta).",
    );
  }
  const length = charCount(text);
  if (length > guard.appendedMaxChars) {
    throw new Error(
      `\`${field}\` for '${label}' is ${length} chars — too long. Keep the per-edge delta to ` +
        `one or two sentences (≤ ${guard.appendedMaxChars} chars).`,
    );
  }
}

type RawSemanticDecision = {
  key: string;
  targetIds: number[];
  updatedDescription?: string;
  appendedDescription?: string;
};

function validateSemanticDecisions(input: {
  incoming: readonly SemanticWork[];
  candidates: readonly SemanticCandidateWork[];
  guard: MergeGuard;
}): (value: unknown) => RawSemanticDecision[] {
  const incomingKeys = new Set(input.incoming.map((row) => row.name.trim().toLowerCase()));
  const targetsById = new Map(input.candidates.map((row) => [row.id, row]));

  return (value: unknown): RawSemanticDecision[] => {
    const decisions = (value as { decisions?: unknown } | null)?.decisions;
    if (!Array.isArray(decisions)) throw new Error("expected a decisions array");

    const folded = new Map<string, RawSemanticDecision>();

    for (const raw of decisions) {
      const decision = raw as {
        new_semantic_name?: unknown;
        merge_target_ids?: unknown;
        updated_description?: unknown;
        appended_description?: unknown;
      } | null;
      const key =
        typeof decision?.new_semantic_name === "string"
          ? decision.new_semantic_name.trim().toLowerCase()
          : "";
      if (!key) throw new Error("semantic merge decision is missing new_semantic_name");
      if (!incomingKeys.has(key)) {
        throw new Error(`semantic merge decision references unknown new_semantic_name '${key}'`);
      }

      const targets = decision?.merge_target_ids;
      if (!Array.isArray(targets)) {
        throw new Error(`semantic merge decision for '${key}' is missing merge_target_ids`);
      }
      const targetIds: number[] = [];
      for (const target of targets) {
        if (typeof target !== "number" || !Number.isInteger(target)) {
          throw new Error(`semantic merge decision for '${key}' has a non-integer target`);
        }
        if (!targetsById.has(target)) {
          throw new Error(
            `semantic merge decision for '${key}' targets ${target}, which is not in this ` +
              "chunk's candidate list. Use only IDs shown in the prompt above; if there is " +
              "no match in this chunk, emit `merge_target_ids: []` (NEW).",
          );
        }
        if (!targetIds.includes(target)) targetIds.push(target);
      }

      const updated = nonEmpty(
        typeof decision?.updated_description === "string"
          ? decision.updated_description
          : undefined,
      );
      const appended = nonEmpty(
        typeof decision?.appended_description === "string"
          ? decision.appended_description
          : undefined,
      );

      if (updated && targetIds.length === 0) {
        throw new Error(
          `the \`updated_description\` for '${key}' only applies when merging; ` +
            "`merge_target_ids` is empty. Omit it for NEW, or set the canonical targets.",
        );
      }
      if (updated) {
        checkFieldUpdate({
          field: "updated_description",
          label: key,
          candidate: updated,
          targetIds,
          currentOf: (id) => targetsById.get(id)?.description,
          guard: input.guard,
        });
      }
      if (targetIds.length > 0) {
        checkAppendedNote("appended_description", key, appended, input.guard);
      }

      const existing = folded.get(key);
      if (!existing) {
        folded.set(key, {
          key,
          targetIds,
          updatedDescription: updated,
          appendedDescription: appended,
        });
        continue;
      }
      for (const id of targetIds) {
        if (!existing.targetIds.includes(id)) existing.targetIds.push(id);
      }
      if (!existing.updatedDescription && updated) existing.updatedDescription = updated;
      if (!existing.appendedDescription && appended) existing.appendedDescription = appended;
    }

    return [...folded.values()];
  };
}

type RawFindingDecision = {
  key: string;
  targetIds: number[];
  updatedDescription?: string;
  updatedPatterns?: string;
  updatedExploits?: string;
  appendedDescription?: string;
  appendedPatterns?: string;
  appendedExploits?: string;
};

function validateFindingDecisions(input: {
  incoming: readonly FindingWork[];
  candidates: readonly FindingCandidateWork[];
  guard: MergeGuard;
}): (value: unknown) => RawFindingDecision[] {
  const incomingKeys = new Set(input.incoming.map((row) => row.title.trim().toLowerCase()));
  const targetsById = new Map(input.candidates.map((row) => [row.id, row]));

  return (value: unknown): RawFindingDecision[] => {
    const decisions = (value as { decisions?: unknown } | null)?.decisions;
    if (!Array.isArray(decisions)) throw new Error("expected a decisions array");

    const folded = new Map<string, RawFindingDecision>();

    for (const raw of decisions) {
      const decision = raw as Record<string, unknown> | null;
      const key =
        typeof decision?.new_finding_title === "string"
          ? decision.new_finding_title.trim().toLowerCase()
          : "";
      if (!key) throw new Error("finding merge decision is missing new_finding_title");
      if (!incomingKeys.has(key)) {
        throw new Error(`finding merge decision references unknown new_finding_title '${key}'`);
      }

      const targets = decision?.merge_target_ids;
      if (!Array.isArray(targets)) {
        throw new Error(`finding merge decision for '${key}' is missing merge_target_ids`);
      }
      const targetIds: number[] = [];
      for (const target of targets) {
        if (typeof target !== "number" || !Number.isInteger(target)) {
          throw new Error(`finding merge decision for '${key}' has a non-integer target`);
        }
        if (!targetsById.has(target)) {
          throw new Error(
            `finding merge decision for '${key}' targets ${target}, which is not in this ` +
              "chunk's candidate list. Use only IDs shown in the prompt above; if there is " +
              "no match in this chunk, emit `merge_target_ids: []` (NEW).",
          );
        }
        if (!targetIds.includes(target)) targetIds.push(target);
      }

      const text = (field: string) =>
        nonEmpty(
          typeof decision?.[field] === "string" ? (decision[field] as string) : undefined,
        );
      const updatedDescription = text("updated_description");
      const updatedPatterns = text("updated_patterns");
      const updatedExploits = text("updated_exploits");
      const appendedDescription = text("appended_description");
      const appendedPatterns = text("appended_patterns");
      const appendedExploits = text("appended_exploits");

      if (
        (updatedDescription || updatedPatterns || updatedExploits) &&
        targetIds.length === 0
      ) {
        throw new Error(
          `the \`updated_*\` fields for '${key}' only apply when merging; ` +
            "`merge_target_ids` is empty. Omit them for NEW, or set the canonical targets.",
        );
      }
      for (const [field, candidate, currentKey] of [
        ["updated_description", updatedDescription, "description"],
        ["updated_patterns", updatedPatterns, "patterns"],
        ["updated_exploits", updatedExploits, "exploits"],
      ] as const) {
        if (!candidate) continue;
        checkFieldUpdate({
          field,
          label: key,
          candidate,
          targetIds,
          currentOf: (id) => targetsById.get(id)?.[currentKey],
          guard: input.guard,
        });
      }
      if (targetIds.length > 0) {
        checkAppendedNote("appended_description", key, appendedDescription, input.guard);
        checkAppendedNote("appended_patterns", key, appendedPatterns, input.guard);
        checkAppendedNote("appended_exploits", key, appendedExploits, input.guard);
      }

      const existing = folded.get(key);
      if (!existing) {
        folded.set(key, {
          key,
          targetIds,
          updatedDescription,
          updatedPatterns,
          updatedExploits,
          appendedDescription,
          appendedPatterns,
          appendedExploits,
        });
        continue;
      }
      for (const id of targetIds) {
        if (!existing.targetIds.includes(id)) existing.targetIds.push(id);
      }
      if (!existing.updatedDescription && updatedDescription) {
        existing.updatedDescription = updatedDescription;
      }
      if (!existing.updatedPatterns && updatedPatterns) {
        existing.updatedPatterns = updatedPatterns;
      }
      if (!existing.updatedExploits && updatedExploits) {
        existing.updatedExploits = updatedExploits;
      }
      if (!existing.appendedDescription && appendedDescription) {
        existing.appendedDescription = appendedDescription;
      }
      if (!existing.appendedPatterns && appendedPatterns) {
        existing.appendedPatterns = appendedPatterns;
      }
      if (!existing.appendedExploits && appendedExploits) {
        existing.appendedExploits = appendedExploits;
      }
    }

    return [...folded.values()];
  };
}

function windowBudgets(ctx: StageContext): {
  newItemBudget: number;
  candidateBudget: number;
} {
  const usable = resolveChunkTokens({
    contextWindow: ctx.contextWindow,
    overheadTokens: estimateTokens(GENERAL_ROLE_SYSTEM),
  });
  return splitMergeWindow(usable, NEW_ITEM_TOKEN_RATIO);
}

function semanticChildren(
  db: StageContext["db"],
  canonicalIds: readonly number[],
): Map<number, SemanticRow[]> {
  const out = new Map<number, SemanticRow[]>();
  if (canonicalIds.length === 0) return out;
  const rows = db.all<SemanticRow & { canonical_id: number }>(
    `select sm.to_semantic_id as canonical_id, sn.id, sn.category, sn.name,
            sn.definition, sn.description
       from semantic_merge sm
       join semantic_node sn on sn.id = sm.from_semantic_id
      where sm.to_semantic_id in (${canonicalIds.map(() => "?").join(", ")})
      order by sm.to_semantic_id, sn.id`,
    canonicalIds,
  );
  for (const row of rows) {
    const children = out.get(row.canonical_id) ?? [];
    children.push(row);
    out.set(row.canonical_id, children);
  }
  return out;
}

function findingChildren(
  db: StageContext["db"],
  canonicalIds: readonly number[],
): Map<number, FindingRow[]> {
  const out = new Map<number, FindingRow[]>();
  if (canonicalIds.length === 0) return out;
  const rows = db.all<FindingRow & { canonical_id: number }>(
    `select fm.to_finding_id as canonical_id, af.id, af.severity, af.title, af.root_cause,
            af.description, af.patterns, af.exploits
       from finding_merge fm
       join audit_finding af on af.id = fm.from_finding_id
      where fm.to_finding_id in (${canonicalIds.map(() => "?").join(", ")})
      order by fm.to_finding_id, af.id`,
    canonicalIds,
  );
  for (const row of rows) {
    const children = out.get(row.canonical_id) ?? [];
    children.push(row);
    out.set(row.canonical_id, children);
  }
  return out;
}

type SemanticMergePlan = { rawId: number; decision: RawSemanticDecision };
type FindingMergePlan = { rawId: number; decision: RawFindingDecision };

async function planSemanticMerges(
  ctx: StageContext,
  raws: readonly SemanticRow[],
): Promise<SemanticMergePlan[]> {
  if (raws.length === 0) return [];
  const categories = [...new Set(raws.map((row) => row.category))].sort();
  const candidates = ctx.db
    .all<SemanticRow>(
      `select id, category, name, definition, description
         from semantic_node
        where category in (${categories.map(() => "?").join(", ")})
          and not exists (
            select 1 from semantic_merge sm where sm.from_semantic_id = semantic_node.id
          )
        order by id`,
      categories,
    )
    .filter((row) => !raws.some((raw) => raw.id === row.id));
  if (candidates.length === 0) return [];

  const children = semanticChildren(
    ctx.db,
    candidates.map((row) => row.id),
  );
  const candidateWork: SemanticCandidateWork[] = candidates.map((row) => {
    const rawChildren = children.get(row.id) ?? [];
    const text = renderSemanticCandidate(row, rawChildren);
    return { ...row, children: rawChildren, text, tokens: estimateTokens(text) };
  });
  const incomingWork: SemanticWork[] = raws.map((row) => {
    const text = renderSemanticIncoming(row);
    return { ...row, text, tokens: estimateTokens(text) };
  });

  const split = windowBudgets(ctx);
  const chunks = partitionByBudget(
    candidateWork,
    split.candidateBudget,
    Number.POSITIVE_INFINITY,
    (candidate) => candidate.tokens,
  );
  const batches = partitionByBudget(
    incomingWork,
    split.newItemBudget,
    NEW_ITEM_BATCH_SIZE,
    (incoming) => incoming.tokens,
  );

  const aggregated = new Map<string, RawSemanticDecision>();
  for (const batch of batches) {
    const incomingText = batch.map((row) => row.text).join("");
    for (const chunk of chunks) {
      const { value: decisions } = await ctx.llm.json({
        prompt: buildMergePrompt({
          kind: "semantic",
          existing: chunk.map((row) => row.text).join(""),
          incoming: incomingText,
        }),
        validate: validateSemanticDecisions({
          incoming: batch,
          candidates: chunk,
          guard: DEFAULT_MERGE_GUARD,
        }),
      });
      for (const decision of decisions) {
        const existing = aggregated.get(decision.key);
        if (!existing) {
          aggregated.set(decision.key, { ...decision, targetIds: [...decision.targetIds] });
          continue;
        }
        for (const id of decision.targetIds) {
          if (!existing.targetIds.includes(id)) existing.targetIds.push(id);
        }
        if (!existing.updatedDescription && decision.updatedDescription) {
          existing.updatedDescription = decision.updatedDescription;
        }
        if (!existing.appendedDescription && decision.appendedDescription) {
          existing.appendedDescription = decision.appendedDescription;
        }
      }
    }
  }

  // Materialize the plan in raw extraction order, matching the reference's
  // `new_semantics` iteration order rather than the model's decision order.
  const plan: SemanticMergePlan[] = [];
  for (const raw of raws) {
    const decision = aggregated.get(raw.name.trim().toLowerCase());
    if (!decision || decision.targetIds.length === 0) continue;
    plan.push({ rawId: raw.id, decision });
  }
  return plan;
}

async function planFindingMerges(
  ctx: StageContext,
  raws: readonly FindingRow[],
): Promise<FindingMergePlan[]> {
  if (raws.length === 0) return [];
  const categories = [...new Set(raws.map((row) => row.category))].sort();
  const rows = ctx.db.all<FindingRow>(
    `select af.id, af.severity, af.title, af.root_cause, af.description, af.patterns,
            af.exploits, fc.category, fc.name as subcategory
       from audit_finding af
       join audit_finding_category afc on afc.audit_finding_id = af.id
       join finding_category fc on fc.id = afc.finding_category_id
      where fc.category in (${categories.map(() => "?").join(", ")})
        and not exists (
          select 1 from finding_merge fm where fm.from_finding_id = af.id
        )
      order by af.id`,
    categories,
  );
  const byId = new Map<number, FindingRow>();
  for (const row of rows) {
    if (!byId.has(row.id) && !raws.some((raw) => raw.id === row.id)) {
      byId.set(row.id, row);
    }
  }
  const candidates = [...byId.values()];
  if (candidates.length === 0) return [];

  const children = findingChildren(
    ctx.db,
    candidates.map((row) => row.id),
  );
  const candidateWork: FindingCandidateWork[] = candidates.map((row) => {
    const rawChildren = children.get(row.id) ?? [];
    const text = renderFindingCandidate(row, rawChildren);
    return { ...row, children: rawChildren, text, tokens: estimateTokens(text) };
  });
  const incomingWork: FindingWork[] = raws.map((row) => {
    const text = renderFindingIncoming(row);
    return { ...row, text, tokens: estimateTokens(text) };
  });

  const split = windowBudgets(ctx);
  const chunks = partitionByBudget(
    candidateWork,
    split.candidateBudget,
    Number.POSITIVE_INFINITY,
    (candidate) => candidate.tokens,
  );
  const batches = partitionByBudget(
    incomingWork,
    split.newItemBudget,
    NEW_ITEM_BATCH_SIZE,
    (incoming) => incoming.tokens,
  );

  const aggregated = new Map<string, RawFindingDecision>();
  for (const batch of batches) {
    const incomingText = batch.map((row) => row.text).join("");
    for (const chunk of chunks) {
      const { value: decisions } = await ctx.llm.json({
        prompt: buildMergePrompt({
          kind: "finding",
          existing: chunk.map((row) => row.text).join(""),
          incoming: incomingText,
        }),
        validate: validateFindingDecisions({
          incoming: batch,
          candidates: chunk,
          guard: DEFAULT_MERGE_GUARD,
        }),
      });
      for (const decision of decisions) {
        const existing = aggregated.get(decision.key);
        if (!existing) {
          aggregated.set(decision.key, { ...decision, targetIds: [...decision.targetIds] });
          continue;
        }
        for (const id of decision.targetIds) {
          if (!existing.targetIds.includes(id)) existing.targetIds.push(id);
        }
        for (const field of [
          "updatedDescription",
          "updatedPatterns",
          "updatedExploits",
          "appendedDescription",
          "appendedPatterns",
          "appendedExploits",
        ] as const) {
          if (!existing[field] && decision[field]) existing[field] = decision[field];
        }
      }
    }
  }

  const plan: FindingMergePlan[] = [];
  for (const raw of raws) {
    const decision = aggregated.get(raw.title.trim().toLowerCase());
    if (!decision || decision.targetIds.length === 0) continue;
    plan.push({ rawId: raw.id, decision });
  }
  return plan;
}

export async function mergeContest(
  ctx: StageContext,
): Promise<{ semanticEdges: number; findingEdges: number }> {
  const projectId = findProject(ctx);
  if (projectId === null) return { semanticEdges: 0, findingEdges: 0 };

  const rawSemantics = ctx.db.all<SemanticRow>(
    `select sn.id, sn.category, sn.name, sn.definition, sn.description
       from semantic_node sn
       join project_semantic ps on ps.semantic_node_id = sn.id
      where ps.project_id = ?
        and not exists (select 1 from semantic_merge sm where sm.from_semantic_id = sn.id)
        and not exists (select 1 from semantic_merge sm where sm.to_semantic_id = sn.id)
      order by sn.id`,
    [projectId],
  );
  const rawFindings = ctx.db.all<FindingRow>(
    `select af.id, af.severity, af.title, af.root_cause, af.description, af.patterns,
            af.exploits, fc.category, fc.name as subcategory
       from audit_finding af
       join project_finding pf on pf.audit_finding_id = af.id
       join audit_finding_category afc on afc.audit_finding_id = af.id
       join finding_category fc on fc.id = afc.finding_category_id
      where pf.project_id = ?
        and not exists (select 1 from finding_merge fm where fm.from_finding_id = af.id)
        and not exists (select 1 from finding_merge fm where fm.to_finding_id = af.id)
      order by af.id`,
    [projectId],
  );

  const semanticPlan = await planSemanticMerges(ctx, rawSemantics);
  const findingPlan = await planFindingMerges(ctx, rawFindings);

  let semanticEdges = 0;
  let findingEdges = 0;
  if (semanticPlan.length > 0 || findingPlan.length > 0) {
    // One transaction per contest covers both merge kinds, and each plan is
    // applied in raw extraction order.
    ctx.db.tx(() => {
      for (const { rawId, decision } of semanticPlan) {
        applySemanticMerge(ctx.db, rawId, {
          action: "merge",
          targetIds: decision.targetIds,
          updatedDescription: decision.updatedDescription,
          appendedDescription: decision.appendedDescription,
        });
        semanticEdges += decision.targetIds.length;
      }
      for (const { rawId, decision } of findingPlan) {
        applyFindingMerge(ctx.db, rawId, {
          action: "merge",
          targetIds: decision.targetIds,
          updatedDescription: decision.updatedDescription,
          updatedPatterns: decision.updatedPatterns,
          updatedExploits: decision.updatedExploits,
          appendedDescription: decision.appendedDescription,
          appendedPatterns: decision.appendedPatterns,
          appendedExploits: decision.appendedExploits,
        });
        findingEdges += decision.targetIds.length;
      }
    });
  }
  return { semanticEdges, findingEdges };
}
