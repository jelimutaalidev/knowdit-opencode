import { DEFI_CATEGORIES, VULN_CATEGORIES } from "./domain/categories.ts";
import type { KgDb } from "./db/client.ts";
import { countVerbatimWords, HIGH_EVIDENCE_MIN_WORDS } from "./pipeline/link-global.ts";
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

function highLinksWithoutVerbatimEvidence(db: KgDb): number {
  const rows = db.all<{
    title: string;
    root_cause: string;
    description: string;
    patterns: string;
    exploits: string;
    evidence: string;
  }>(
    `select af.title, af.root_cause, af.description, af.patterns, af.exploits, sfl.evidence
       from semantic_finding_link sfl
       join audit_finding af on af.id = sfl.audit_finding_id
      where sfl.strength = 'High'
        and sfl.evidence not like ?`,
    [`${IN_PROJECT_LINK_EVIDENCE_PREFIX}%`],
  );

  return rows.filter((row) => {
    const text = [row.title, row.root_cause, row.description, row.patterns, row.exploits].join(
      "\n",
    );
    return countVerbatimWords(text, row.evidence) < HIGH_EVIDENCE_MIN_WORDS;
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
  checks.push(
    check("enum_values", badSeverity + badStrength + badDefiCategory + badVulnerabilityCategory),
  );

  checks.push(
    check("high_cross_links_have_verbatim_evidence", highLinksWithoutVerbatimEvidence(db)),
  );

  checks.push(check("no_merge_status_rows", count(db, "select count(*) n from merge_status")));

  return { ok: checks.every((entry) => entry.passed), checks };
}
