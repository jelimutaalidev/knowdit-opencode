import type { KgDb } from "./db/client.ts";

export type KgStatsSubset = {
  projectsTotal: number;
  semanticsTotal: number;
  semanticsCanonical: number;
  findingsTotal: number;
  findingsCanonical: number;
  linksTotal: number;
  linksInProject: number;
  linksCross: number;
  linkProcessedFindings: number;
  pendingSemantics: number;
};

function count(db: KgDb, sql: string, params: readonly unknown[] = []): number {
  return db.get<{ n: number }>(sql, params)?.n ?? 0;
}

/**
 * The subset of `knowdit stats` that Phase 1 can compute without merge
 * history from another KG. Canonical counts follow the reference formula:
 * total rows minus the distinct sources folded into a target.
 */
export function readStats(db: KgDb): KgStatsSubset {
  const semanticsTotal = count(db, "select count(*) n from semantic_node");
  const semanticsFolded = count(
    db,
    "select count(distinct from_semantic_id) n from semantic_merge",
  );
  const findingsTotal = count(db, "select count(*) n from audit_finding");
  const findingsFolded = count(
    db,
    "select count(distinct from_finding_id) n from finding_merge",
  );

  const linksTotal = count(db, "select count(*) n from semantic_finding_link");
  const linksInProject = count(
    db,
    "select count(*) n from semantic_finding_link where evidence like 'in-project link:%'",
  );

  return {
    projectsTotal: count(db, "select count(*) n from project"),
    semanticsTotal,
    semanticsCanonical: semanticsTotal - semanticsFolded,
    findingsTotal,
    findingsCanonical: findingsTotal - findingsFolded,
    linksTotal,
    linksInProject,
    linksCross: linksTotal - linksInProject,
    linkProcessedFindings: count(db, "select count(*) n from finding_link_status"),
    pendingSemantics: count(db, "select count(*) n from pending_semantic"),
  };
}
