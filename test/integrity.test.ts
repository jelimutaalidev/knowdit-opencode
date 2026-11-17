import test from "node:test";
import assert from "node:assert/strict";
import { checkIntegrity } from "../.opencode/plugins/knowdit/src/integrity.ts";
import { tempDb } from "./helpers/db.ts";
import type { KgDb } from "../.opencode/plugins/knowdit/src/db/client.ts";

async function seededBroken(opts: {
  canonicalWithOutgoing?: boolean;
  badSeverity?: boolean;
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
     values ('Finding', ?, 'rc', 'desc', 'p', 'e')`,
    [opts.badSeverity ? "Critical" : "High"],
  ).lastInsertRowid;
  db.run(
    "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
    [findingId, taxonomy.id],
  );
  db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
    projectId,
    findingId,
  ]);

  db.run(
    "insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence) values (?, ?, 'High', 'some evidence')",
    [semanticId, findingId],
  );

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
