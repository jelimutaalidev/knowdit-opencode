import { DEFI_CATEGORIES, VULN_CATEGORIES } from "./domain/categories.ts";
import type { KgDb } from "./db/client.ts";
import {
  emptyFindingNotes,
  hasGroundedVerbatimQuote,
  loadFindingCategories,
  loadFindingNotes,
  renderFinding,
  type FindingLinkRow,
} from "./pipeline/link-global.ts";
import { IN_PROJECT_LINK_EVIDENCE_PREFIX } from "./pipeline/evidence.ts";

export type IntegrityCheck = { name: string; passed: boolean; detail?: string };

export type IntegrityReport = { ok: boolean; checks: IntegrityCheck[] };

function count(db: KgDb, sql: string, params: readonly unknown[] = []): number {
  return db.get<{ n: number }>(sql, params)?.n ?? 0;
}

function check(name: string, failures: number, detail?: string): IntegrityCheck {
  return failures === 0
    ? { name, passed: true }
    : { name, passed: false, detail: detail ?? `${failures} offending row(s)` };
}

function quoteList(values: readonly string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ");
}

function mergeCycleCount(db: KgDb, edgeTable: string, from: string, to: string): number {
  const sql = `
    with recursive walk(origin, node) as (
      select ${from}, ${to} from ${edgeTable}
      union
      select walk.origin, edge.${to}
        from walk
        join ${edgeTable} edge on edge.${from} = walk.node
    )
    select count(*) n from walk where origin = node`;
  return count(db, sql);
}

type LinkFindingRow = FindingLinkRow & {
  evidence: string;
};

function loadFindingRows(
  db: KgDb,
  ids: readonly number[],
): Map<number, FindingLinkRow> {
  const out = new Map<number, FindingLinkRow>();
  if (ids.length === 0) return out;
  const rows = db.all<FindingLinkRow>(
    `select af.id, af.title, af.severity, af.root_cause, af.description, af.patterns,
            af.exploits, fc.category, fc.name as subcategory
       from audit_finding af
       join audit_finding_category afc on afc.audit_finding_id = af.id
       join finding_category fc on fc.id = afc.finding_category_id
      where af.id in (${ids.map(() => "?").join(", ")})
      order by af.id`,
    ids,
  );
  for (const row of rows) {
    if (!out.has(row.id)) out.set(row.id, row);
  }
  return out;
}

function descendantsOf(
  childrenOf: ReadonlyMap<number, readonly number[]>,
  root: number,
): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const stack = [...(childrenOf.get(root) ?? [])];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    stack.push(...(childrenOf.get(id) ?? []));
  }
  return out;
}

function highLinksWithoutVerbatimEvidence(db: KgDb): number {
  const rows = db.all<LinkFindingRow>(
    `select af.id, af.title, af.severity, af.root_cause, af.description, af.patterns,
            af.exploits, fc.category, fc.name as subcategory, sfl.evidence
       from semantic_finding_link sfl
       join audit_finding af on af.id = sfl.audit_finding_id
       join audit_finding_category afc on afc.audit_finding_id = af.id
       join finding_category fc on fc.id = afc.finding_category_id
      where sfl.strength = 'High'
        and sfl.evidence not like ?`,
    [`${IN_PROJECT_LINK_EVIDENCE_PREFIX}%`],
  );
  if (rows.length === 0) return 0;

  // Links are persisted on the resolved merge target, but the High quote was
  // copied from the raw finding's own prompt entry. Render the target and
  // every folded descendant as its own finding so a raw that fell outside the
  // 8-variant or 400-char rendering cap still grounds its quote.
  const byId = new Map<number, FindingLinkRow>();
  for (const row of rows) byId.set(row.id, row);

  const childrenOf = new Map<number, number[]>();
  for (const edge of db.all<{ from_id: number; to_id: number }>(
    "select from_finding_id as from_id, to_finding_id as to_id from finding_merge",
  )) {
    const children = childrenOf.get(edge.to_id) ?? [];
    children.push(edge.from_id);
    childrenOf.set(edge.to_id, children);
  }

  const descendants = new Map<number, number[]>();
  const needed = new Set<number>();
  for (const id of byId.keys()) {
    const ids = descendantsOf(childrenOf, id);
    descendants.set(id, ids);
    for (const descendant of ids) needed.add(descendant);
  }
  for (const [id, row] of loadFindingRows(db, [...needed])) {
    if (!byId.has(id)) byId.set(id, row);
  }

  const notes = loadFindingNotes(db, [...byId.keys()]);
  const categoryCache = new Map<number, string[]>();
  const categoriesFor = (findingId: number): string[] => {
    if (!categoryCache.has(findingId)) {
      categoryCache.set(findingId, loadFindingCategories(db, findingId));
    }
    return categoryCache.get(findingId)!;
  };
  const bodyFor = (row: FindingLinkRow): string =>
    renderFinding(
      row,
      categoriesFor(row.id),
      notes.get(row.id) ?? emptyFindingNotes(),
    ).entry;

  return rows.filter((row) => {
    const bodies = [bodyFor(row)];
    for (const id of descendants.get(row.id) ?? []) {
      const child = byId.get(id);
      if (child) bodies.push(bodyFor(child));
    }
    return !bodies.some((body) => hasGroundedVerbatimQuote(body, row.evidence));
  }).length;
}

export function checkIntegrity(
  db: KgDb,
  opts: { requireAllLinked: boolean },
): IntegrityReport {
  const checks: IntegrityCheck[] = [];

  checks.push(
    check(
      "every_finding_has_project",
      count(
        db,
        `select count(*) n from audit_finding af
          where not exists (select 1 from project_finding pf where pf.audit_finding_id = af.id)`,
      ),
    ),
  );

  checks.push(
    check(
      "every_semantic_has_project",
      count(
        db,
        `select count(*) n from semantic_node sn
          where not exists (select 1 from project_semantic ps where ps.semantic_node_id = sn.id)`,
      ),
    ),
  );

  checks.push(
    check(
      "every_finding_has_category",
      count(
        db,
        `select count(*) n from audit_finding af
          where not exists (
            select 1 from audit_finding_category afc
             where afc.audit_finding_id = af.id
          )`,
      ),
    ),
  );

  checks.push(
    check(
      "status_rows_have_finding",
      count(
        db,
        `select count(*) n from finding_link_status fls
          where not exists (select 1 from audit_finding af where af.id = fls.audit_finding_id)`,
      ),
    ),
  );

  if (opts.requireAllLinked) {
    checks.push(
      check(
        "links_have_status",
        count(
          db,
          `select count(*) n from audit_finding af
            where exists (select 1 from semantic_finding_link sfl where sfl.audit_finding_id = af.id)
              and not exists (select 1 from finding_link_status fls where fls.audit_finding_id = af.id)`,
        ),
      ),
    );
  }

  const canonicalOutgoing =
    count(
      db,
      `select count(*) n from semantic_merge sm
        where exists (select 1 from semantic_merge x where x.to_semantic_id = sm.from_semantic_id)`,
    ) +
    count(
      db,
      `select count(*) n from finding_merge fm
        where exists (select 1 from finding_merge x where x.to_finding_id = fm.from_finding_id)`,
    );
  checks.push(check("no_canonical_outgoing_merge", canonicalOutgoing));

  const cycles =
    mergeCycleCount(db, "semantic_merge", "from_semantic_id", "to_semantic_id") +
    mergeCycleCount(db, "finding_merge", "from_finding_id", "to_finding_id");
  checks.push(check("no_merge_cycles", cycles));

  const badSeverity = count(
    db,
    "select count(*) n from audit_finding where severity not in ('High', 'Medium', 'Low')",
  );
  const badStrength = count(
    db,
    "select count(*) n from semantic_finding_link where strength not in ('High', 'Medium', 'Low')",
  );
  const badDefiCategory = count(
    db,
    `select count(*) n from category where name not in (${quoteList(DEFI_CATEGORIES)})`,
  );
  const badVulnerabilityCategory = count(
    db,
    `select count(*) n from finding_category where category not in (${quoteList(VULN_CATEGORIES)})`,
  );
  const badSemanticCategory = count(
    db,
    `select count(*) n from semantic_node
      where category not in (${quoteList(DEFI_CATEGORIES)})`,
  );
  checks.push(
    check(
      "enum_values",
      badSeverity +
        badStrength +
        badDefiCategory +
        badVulnerabilityCategory +
        badSemanticCategory,
    ),
  );

  checks.push(
    check("high_cross_links_have_verbatim_evidence", highLinksWithoutVerbatimEvidence(db)),
  );

  checks.push(check("no_merge_status_rows", count(db, "select count(*) n from merge_status")));

  return { ok: checks.every((entry) => entry.passed), checks };
}
