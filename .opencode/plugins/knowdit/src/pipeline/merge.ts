import { buildMergePrompt } from "../prompts/index.ts";
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

function renderSemanticCandidates(rows: readonly SemanticRow[]): string {
  return rows
    .map(
      (row) =>
        `ID: ${row.id}\nCategory: ${row.category}\nName: ${row.name}\n` +
        `Definition: ${row.definition}\nDescription: ${row.description}\n\n`,
    )
    .join("");
}

function renderSemanticIncoming(rows: readonly SemanticRow[]): string {
  return rows
    .map(
      (row) =>
        `Category: ${row.category}\nName: ${row.name}\nDefinition: ${row.definition}\n` +
        `Description: ${row.description}\n\n`,
    )
    .join("");
}

function renderFindingCandidates(rows: readonly FindingRow[]): string {
  return rows
    .map(
      (row) =>
        `ID: ${row.id}\nSeverity: ${row.severity}\nCategory: ${row.category}\n` +
        `Subcategory: ${row.subcategory}\nTitle: ${row.title}\nRoot Cause: ${row.root_cause}\n` +
        `Description: ${row.description}\nPatterns: ${row.patterns}\nExploits: ${row.exploits}\n\n`,
    )
    .join("");
}

function renderFindingIncoming(rows: readonly FindingRow[]): string {
  return rows
    .map(
      (row) =>
        `Severity: ${row.severity}\nCategory: ${row.category}\nSubcategory: ${row.subcategory}\n` +
        `Title: ${row.title}\nRoot Cause: ${row.root_cause}\nDescription: ${row.description}\n` +
        `Patterns: ${row.patterns}\nExploits: ${row.exploits}\n\n`,
    )
    .join("");
}

type RawSemanticDecision = {
  key: string;
  targetIds: number[];
  updatedDescription?: string;
  appendedDescription?: string;
};

function validateSemanticDecisions(
  incomingKeys: Set<string>,
): (value: unknown) => RawSemanticDecision[] {
  return (value: unknown): RawSemanticDecision[] => {
    const decisions = (value as { decisions?: unknown } | null)?.decisions;
    if (!Array.isArray(decisions)) throw new Error("expected a decisions array");

    const out: RawSemanticDecision[] = [];
    const seen = new Set<string>();

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
      if (seen.has(key)) throw new Error(`duplicate semantic merge decision for '${key}'`);
      seen.add(key);

      const targets = decision?.merge_target_ids;
      if (!Array.isArray(targets)) {
        throw new Error(`semantic merge decision for '${key}' is missing merge_target_ids`);
      }
      for (const target of targets) {
        if (typeof target !== "number" || !Number.isInteger(target)) {
          throw new Error(`semantic merge decision for '${key}' has a non-integer target`);
        }
      }

      out.push({
        key,
        targetIds: targets as number[],
        updatedDescription:
          typeof decision?.updated_description === "string"
            ? decision.updated_description
            : undefined,
        appendedDescription:
          typeof decision?.appended_description === "string"
            ? decision.appended_description
            : undefined,
      });
    }

    for (const key of incomingKeys) {
      if (!seen.has(key)) throw new Error(`no merge decision for semantic '${key}'`);
    }
    return out;
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

function validateFindingDecisions(
  incomingKeys: Set<string>,
): (value: unknown) => RawFindingDecision[] {
  return (value: unknown): RawFindingDecision[] => {
    const decisions = (value as { decisions?: unknown } | null)?.decisions;
    if (!Array.isArray(decisions)) throw new Error("expected a decisions array");

    const out: RawFindingDecision[] = [];
    const seen = new Set<string>();

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
      if (seen.has(key)) throw new Error(`duplicate finding merge decision for '${key}'`);
      seen.add(key);

      const targets = decision?.merge_target_ids;
      if (!Array.isArray(targets)) {
        throw new Error(`finding merge decision for '${key}' is missing merge_target_ids`);
      }
      for (const target of targets) {
        if (typeof target !== "number" || !Number.isInteger(target)) {
          throw new Error(`finding merge decision for '${key}' has a non-integer target`);
        }
      }

      const text = (field: string) =>
        typeof decision?.[field] === "string" ? (decision[field] as string) : undefined;

      out.push({
        key,
        targetIds: targets as number[],
        updatedDescription: text("updated_description"),
        updatedPatterns: text("updated_patterns"),
        updatedExploits: text("updated_exploits"),
        appendedDescription: text("appended_description"),
        appendedPatterns: text("appended_patterns"),
        appendedExploits: text("appended_exploits"),
      });
    }

    for (const key of incomingKeys) {
      if (!seen.has(key)) throw new Error(`no merge decision for finding '${key}'`);
    }
    return out;
  };
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
  const rawIds = new Set(rawSemantics.map((row) => row.id));
  const semanticCandidates = ctx.db
    .all<SemanticRow>(
      `select id, category, name, definition, description
         from semantic_node
        where not exists (select 1 from semantic_merge sm where sm.from_semantic_id = semantic_node.id)`,
    )
    .filter((row) => !rawIds.has(row.id));

  let semanticEdges = 0;
  if (rawSemantics.length > 0 && semanticCandidates.length > 0) {
    const incomingKeys = new Set(rawSemantics.map((row) => row.name.trim().toLowerCase()));
    const { value: decisions } = await ctx.llm.json({
      prompt: buildMergePrompt({
        kind: "semantic",
        existing: renderSemanticCandidates(semanticCandidates),
        incoming: renderSemanticIncoming(rawSemantics),
      }),
      validate: validateSemanticDecisions(incomingKeys),
    });

    const byName = new Map(rawSemantics.map((row) => [row.name.trim().toLowerCase(), row]));
    ctx.db.tx(() => {
      for (const decision of decisions) {
        const raw = byName.get(decision.key)!;
        if (decision.targetIds.length === 0) continue;
        applySemanticMerge(ctx.db, raw.id, {
          action: "merge",
          targetIds: decision.targetIds,
          updatedDescription: decision.updatedDescription,
          appendedDescription: decision.appendedDescription,
        });
        semanticEdges += decision.targetIds.length;
      }
    });
  }

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
  const rawFindingIds = new Set(rawFindings.map((row) => row.id));
  const findingCandidates = ctx.db
    .all<FindingRow>(
      `select af.id, af.severity, af.title, af.root_cause, af.description, af.patterns,
              af.exploits, fc.category, fc.name as subcategory
         from audit_finding af
         join audit_finding_category afc on afc.audit_finding_id = af.id
         join finding_category fc on fc.id = afc.finding_category_id
        where not exists (select 1 from finding_merge fm where fm.from_finding_id = af.id)`,
    )
    .filter((row) => !rawFindingIds.has(row.id));

  let findingEdges = 0;
  if (rawFindings.length > 0 && findingCandidates.length > 0) {
    const incomingKeys = new Set(rawFindings.map((row) => row.title.trim().toLowerCase()));
    const { value: decisions } = await ctx.llm.json({
      prompt: buildMergePrompt({
        kind: "finding",
        existing: renderFindingCandidates(findingCandidates),
        incoming: renderFindingIncoming(rawFindings),
      }),
      validate: validateFindingDecisions(incomingKeys),
    });

    const byTitle = new Map(rawFindings.map((row) => [row.title.trim().toLowerCase(), row]));
    ctx.db.tx(() => {
      for (const decision of decisions) {
        const raw = byTitle.get(decision.key)!;
        if (decision.targetIds.length === 0) continue;
        applyFindingMerge(ctx.db, raw.id, {
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
