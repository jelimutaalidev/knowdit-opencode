import type { KgDb } from "./db/client.ts";

export type SemanticQuery = {
  q?: string;
  category?: string;
  canonicalOnly?: boolean;
  unlinkedOnly?: boolean;
  limit?: number;
};

export type FindingQuery = {
  q?: string;
  severity?: string;
  category?: string;
  canonicalOnly?: boolean;
  limit?: number;
};

export type LinkQuery = {
  findingId?: number;
  semanticId?: number;
  strength?: string;
  findingSeverity?: string;
  limit?: number;
};

export type SemanticRow = {
  id: number;
  name: string;
  category: string;
  definition: string;
  description: string;
};

export type FindingRow = {
  id: number;
  title: string;
  severity: string;
  category: string;
  subcategory: string;
  root_cause: string;
  description: string;
  patterns: string;
  exploits: string;
};

export type LinkRow = {
  findingId: number;
  semanticId: number;
  strength: string;
  evidence: string;
  findingTitle: string;
  findingSeverity: string;
  semanticName: string;
  semanticCategory: string;
};

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(500, Math.max(1, Math.trunc(value)));
}

function like(value: string): string {
  return `%${value}%`;
}

export function querySemantics(db: KgDb, q: SemanticQuery = {}): SemanticRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.q) {
    clauses.push("(sn.name like ? or sn.definition like ? or sn.description like ?)");
    params.push(like(q.q), like(q.q), like(q.q));
  }
  if (q.category) {
    clauses.push("sn.category = ?");
    params.push(q.category);
  }
  if (q.canonicalOnly ?? true) {
    clauses.push(
      "not exists (select 1 from semantic_merge sm where sm.from_semantic_id = sn.id)",
    );
  }
  if (q.unlinkedOnly) {
    clauses.push(
      "not exists (select 1 from semantic_finding_link sfl where sfl.semantic_node_id = sn.id)",
    );
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  params.push(clampLimit(q.limit, 20));

  return db.all<SemanticRow>(
    `select sn.id, sn.name, sn.category, sn.definition, sn.description
       from semantic_node sn
       ${where}
      order by sn.id
      limit ?`,
    params,
  );
}

export function queryFindings(db: KgDb, q: FindingQuery = {}): FindingRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.q) {
    clauses.push("(af.title like ? or af.description like ?)");
    params.push(like(q.q), like(q.q));
  }
  if (q.severity) {
    clauses.push("af.severity = ?");
    params.push(q.severity);
  }
  if (q.category) {
    clauses.push("fc.category = ?");
    params.push(q.category);
  }
  if (q.canonicalOnly ?? true) {
    clauses.push(
      "not exists (select 1 from finding_merge fm where fm.from_finding_id = af.id)",
    );
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  params.push(clampLimit(q.limit, 20));

  return db.all<FindingRow>(
    `select af.id, af.title, af.severity, fc.category as category,
            fc.name as subcategory, af.root_cause, af.description,
            af.patterns, af.exploits
       from audit_finding af
       join audit_finding_category afc on afc.audit_finding_id = af.id
       join finding_category fc on fc.id = afc.finding_category_id
       ${where}
      order by af.id
      limit ?`,
    params,
  );
}

export function queryLinks(db: KgDb, q: LinkQuery = {}): LinkRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (q.findingId !== undefined) {
    clauses.push("sfl.audit_finding_id = ?");
    params.push(q.findingId);
  }
  if (q.semanticId !== undefined) {
    clauses.push("sfl.semantic_node_id = ?");
    params.push(q.semanticId);
  }
  if (q.strength) {
    clauses.push("sfl.strength = ?");
    params.push(q.strength);
  }
  if (q.findingSeverity) {
    clauses.push("af.severity = ?");
    params.push(q.findingSeverity);
  }

  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  params.push(clampLimit(q.limit, 100));

  return db.all<LinkRow>(
    `select sfl.audit_finding_id as findingId, sfl.semantic_node_id as semanticId,
            sfl.strength, sfl.evidence,
            af.title as findingTitle, af.severity as findingSeverity,
            sn.name as semanticName, sn.category as semanticCategory
       from semantic_finding_link sfl
       join audit_finding af on af.id = sfl.audit_finding_id
       join semantic_node sn on sn.id = sfl.semantic_node_id
       ${where}
      order by sfl.semantic_node_id, sfl.audit_finding_id
      limit ?`,
    params,
  );
}
