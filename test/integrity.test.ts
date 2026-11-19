import test from "node:test";
import assert from "node:assert/strict";
import { checkIntegrity } from "../.opencode/plugins/knowdit/src/integrity.ts";
import { inProjectEvidence } from "../.opencode/plugins/knowdit/src/pipeline/evidence.ts";
import { tempDb } from "./helpers/db.ts";
import type { KgDb } from "../.opencode/plugins/knowdit/src/db/client.ts";

async function seededBroken(opts: {
  canonicalWithOutgoing?: boolean;
  badSeverity?: boolean;
  rootCause?: string;
  highEvidence?: string;
  childDescription?: string;
  childDescriptions?: string[];
  skipTaxonomy?: boolean;
} = {}): Promise<{ db: KgDb }> {
  const { db } = await tempDb();
  const projectId = db.run(
    "insert into project (name, status) values ('p', 'running')",
  ).lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, 'c4-229')", [
    projectId,
  ]);

  const semanticId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Semantic', 'def', 'desc', 'Dexes')",
  ).lastInsertRowid;
  db.run("insert into project_semantic (project_id, semantic_node_id) values (?, ?)", [
    projectId,
    semanticId,
  ]);

  const taxonomy = db.get<{ id: number }>(
    "select id from finding_category where category = 'Arithmetic' and name = 'Integer Overflow'",
  )!;
  const findingId = db.run(
    `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
     values ('Finding', ?, ?, 'desc', 'p', 'e')`,
    [opts.badSeverity ? "Critical" : "High", opts.rootCause ?? "rc"],
  ).lastInsertRowid;
  if (!opts.skipTaxonomy) {
    db.run(
      "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
      [findingId, taxonomy.id],
    );
  }
  db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
    projectId,
    findingId,
  ]);

  db.run(
    `insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence)
     values (?, ?, 'High', ?)`,
    [semanticId, findingId, opts.highEvidence ?? "some evidence"],
  );

  const childDescriptions =
    opts.childDescriptions ?? (opts.childDescription ? [opts.childDescription] : []);
  for (const [index, description] of childDescriptions.entries()) {
    const childId = db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values (?, 'High', 'child root cause', ?, 'child patterns', 'child exploits')`,
      [`Folded child ${index + 1}`, description],
    ).lastInsertRowid;
    db.run(
      "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
      [childId, taxonomy.id],
    );
    db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
      projectId,
      childId,
    ]);
    db.run(
      `insert into finding_merge
         (from_finding_id, to_finding_id, appended_description, appended_patterns, appended_exploits)
       values (?, ?, 'note', 'note', 'note')`,
      [childId, findingId],
    );
  }

  if (opts.canonicalWithOutgoing) {
    const rawId = db.run(
      "insert into semantic_node (name, definition, description, category) values ('Raw', 'def', 'desc', 'Dexes')",
    ).lastInsertRowid;
    const otherId = db.run(
      "insert into semantic_node (name, definition, description, category) values ('Other', 'def', 'desc', 'Dexes')",
    ).lastInsertRowid;
    db.run(
      "insert into semantic_merge (from_semantic_id, to_semantic_id, appended_description) values (?, ?, 'note')",
      [rawId, semanticId],
    );
    db.run(
      "insert into semantic_merge (from_semantic_id, to_semantic_id, appended_description) values (?, ?, 'note')",
      [semanticId, otherId],
    );
  }

  return { db };
}

test("flags a finding with a link but no link status", async () => {
  const { db } = await seededBroken();
  const r = checkIntegrity(db, { requireAllLinked: true });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "links_have_status")!.passed, false);
});

test("flags a canonical with an outgoing merge edge", async () => {
  const { db } = await seededBroken({ canonicalWithOutgoing: true });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(r.checks.find((c) => c.name === "no_canonical_outgoing_merge")!.passed, false);
});

test("flags an unknown enum value", async () => {
  const { db } = await seededBroken({ badSeverity: true });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(r.checks.find((c) => c.name === "enum_values")!.passed, false);
});

test("flags a finding without taxonomy", async () => {
  const { db } = await seededBroken({ skipTaxonomy: true });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(r.checks.find((c) => c.name === "every_finding_has_category")!.passed, false);
});

test("flags a dangling finding link status row", async () => {
  const { db } = await seededBroken();
  db.run("pragma foreign_keys = off");
  db.run("insert into finding_link_status (audit_finding_id) values (999999)");
  db.run("pragma foreign_keys = on");
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(r.checks.find((c) => c.name === "status_rows_have_finding")!.passed, false);
});

test("flags an invalid semantic category enum value", async () => {
  const { db } = await seededBroken();
  db.run("update semantic_node set category = 'NotACategory'");
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(r.checks.find((c) => c.name === "enum_values")!.passed, false);
});

test("passes a High cross-link with a grounded verbatim quote", async () => {
  const { db } = await seededBroken({
    rootCause: "shares are minted twice in a loop before the transfer",
    highEvidence: 'The root cause says "shares are minted twice in a loop" exactly.',
  });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(
    r.checks.find((c) => c.name === "high_cross_links_have_verbatim_evidence")!.passed,
    true,
  );
});

test("flags a High cross-link whose quote is not in the finding", async () => {
  const { db } = await seededBroken({
    rootCause: "shares are minted twice in a loop before the transfer",
    highEvidence: 'It says "attacker drains the pool during the withdraw callback" here.',
  });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(
    r.checks.find((c) => c.name === "high_cross_links_have_verbatim_evidence")!.passed,
    false,
  );
});

test("flags a High cross-link whose only quote is shorter than 25 chars", async () => {
  const { db } = await seededBroken({
    rootCause: "shares are minted twice in a loop before the transfer",
    highEvidence: 'It says "shares are minted twice" in the text.',
  });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(
    r.checks.find((c) => c.name === "high_cross_links_have_verbatim_evidence")!.passed,
    false,
  );
});

test("grounds a High quote in a folded child's rendered text", async () => {
  const { db } = await seededBroken({
    childDescription:
      "the fee accumulator is credited twice per deposit via the child path",
    highEvidence:
      'The child note says "credited twice per deposit via the child path" verbatim.',
  });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(
    r.checks.find((c) => c.name === "high_cross_links_have_verbatim_evidence")!.passed,
    true,
  );
});

test("grounds a High quote in a folded child beyond the variant cap", async () => {
  const children = Array.from({ length: 8 }, (_, index) => `ordinary child variant ${index + 1}`);
  children.push("the fee accumulator is credited twice per deposit via the ninth child path");
  const { db } = await seededBroken({
    childDescriptions: children,
    highEvidence:
      'The child note says "credited twice per deposit via the ninth child path" verbatim.',
  });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(
    r.checks.find((c) => c.name === "high_cross_links_have_verbatim_evidence")!.passed,
    true,
  );
});

test("grounds a High quote beyond the per-child character cap", async () => {
  const quote = "the fee accumulator is credited twice per deposit via the long child path";
  const { db } = await seededBroken({
    childDescriptions: [`${"x".repeat(420)} ${quote}`],
    highEvidence: `The child note says "${quote}" verbatim.`,
  });
  const r = checkIntegrity(db, { requireAllLinked: false });
  assert.equal(
    r.checks.find((c) => c.name === "high_cross_links_have_verbatim_evidence")!.passed,
    true,
  );
});

test("exempts in-project links from the verbatim quote rule", async () => {
  const seeded = await seededBroken({ highEvidence: inProjectEvidence() });
  const r = checkIntegrity(seeded.db, { requireAllLinked: false });
  assert.equal(
    r.checks.find((c) => c.name === "high_cross_links_have_verbatim_evidence")!.passed,
    true,
  );
});
