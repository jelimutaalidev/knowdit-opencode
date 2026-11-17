import test from "node:test";
import assert from "node:assert/strict";
import { applySemanticMerge, applyFindingMerge } from "../../.opencode/plugins/knowdit/src/pipeline/merge.ts";
import { tempDb } from "../helpers/db.ts";
import type { KgDb } from "../../.opencode/plugins/knowdit/src/db/client.ts";

async function seedProject(db: KgDb): Promise<number> {
  const projectId = db.run("insert into project (name, status) values ('p', 'running')").lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, ?)", [projectId, "c4-229"]);
  return projectId;
}

async function seededSemantic(): Promise<{
  db: KgDb;
  rawId: number;
  canonicalId: number;
  projectId: number;
}> {
  const { db } = await tempDb();
  const projectId = await seedProject(db);
  const rawId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Raw', 'raw def', 'raw desc', 'Dexes')",
  ).lastInsertRowid;
  const canonicalId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Canonical', 'def', 'old desc', 'Dexes')",
  ).lastInsertRowid;
  db.run("insert into project_semantic (project_id, semantic_node_id) values (?, ?)", [projectId, rawId]);
  return { db, rawId, canonicalId, projectId };
}

async function seededFinding(): Promise<{
  db: KgDb;
  rawId: number;
  canonicalIds: number[];
  projectId: number;
}> {
  const { db } = await tempDb();
  const projectId = await seedProject(db);
  const taxonomyId = db.get<{ id: number }>(
    "select id from finding_category where category = 'Arithmetic' and name = 'Integer Overflow'",
  )!.id;

  const insertFinding = (title: string, severity: string): number => {
    const id = db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values (?, ?, 'rc', 'desc', 'p', 'e')`,
      [title, severity],
    ).lastInsertRowid;
    db.run(
      "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
      [id, taxonomyId],
    );
    return id;
  };

  const rawId = insertFinding("Raw", "High");
  const canonicalIds = [insertFinding("Canonical A", "High"), insertFinding("Canonical B", "Medium")];
  db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [projectId, rawId]);
  return { db, rawId, canonicalIds, projectId };
}

test("semantic merge keeps identity frozen and grows canonical provenance", async () => {
  const { db, rawId, canonicalId, projectId } = await seededSemantic();
  applySemanticMerge(db, rawId, { action: "merge", targetIds: [canonicalId], updatedDescription: "new desc", appendedDescription: "note" });
  const c = db.get<{ name: string; definition: string; description: string }>("select name, definition, description from semantic_node where id = ?", [canonicalId])!;
  assert.equal(c.name, "Canonical");
  assert.equal(c.definition, "def");
  assert.equal(c.description, "new desc");
  assert.equal(db.get<{ n: number }>("select count(*) n from semantic_merge")!.n, 1);
  assert.equal(db.get<{ n: number }>("select count(*) n from project_semantic where project_id = ? and semantic_node_id = ?", [projectId, canonicalId])!.n, 1);
});

test("merge without an appended note is rejected", async () => {
  const { db, rawId, canonicalId } = await seededSemantic();
  assert.throws(() => applySemanticMerge(db, rawId, { action: "merge", targetIds: [canonicalId] }), /appended note is required/i);
});

test("finding merge refuses identity fields and accepts multi-target", async () => {
  const { db, rawId, canonicalIds, projectId } = await seededFinding();
  assert.throws(
    () => applyFindingMerge(db, rawId, { action: "merge", targetIds: [canonicalIds[0]], appendedDescription: "n", updatedDescription: "d", updatedPatterns: "p", updatedExploits: "e", title: "changed" } as never),
    /identity/i,
  );
  applyFindingMerge(db, rawId, { action: "merge", targetIds: canonicalIds, appendedDescription: "n" });
  assert.equal(db.get<{ n: number }>("select count(*) n from finding_merge")!.n, 2);
  assert.equal(db.get<{ n: number }>("select count(*) n from project_finding where project_id = ? and audit_finding_id in (?, ?)", [projectId, ...canonicalIds])!.n, 2);
});
