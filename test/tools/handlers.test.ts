import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDb } from "../helpers/db.ts";
import { readStats } from "../../.opencode/plugins/knowdit/src/stats.ts";
import { registerKnowditTools } from "../../.opencode/plugins/knowdit/src/register.ts";
import { createProgressReporter } from "../../.opencode/plugins/knowdit/src/tools/handlers.ts";
import type { KgDb } from "../../.opencode/plugins/knowdit/src/db/client.ts";

async function seededStats(): Promise<{ db: KgDb }> {
  const { db } = await tempDb();

  const projectId = db.run(
    "insert into project (name, status) values ('p', 'completed')",
  ).lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, 'c4-229')", [
    projectId,
  ]);

  const canonicalId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Canonical', 'd', 'x', 'Dexes')",
  ).lastInsertRowid;
  const rawId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Raw', 'd', 'x', 'Dexes')",
  ).lastInsertRowid;
  db.run("insert into project_semantic (project_id, semantic_node_id) values (?, ?)", [
    projectId,
    canonicalId,
  ]);
  db.run("insert into project_semantic (project_id, semantic_node_id) values (?, ?)", [
    projectId,
    rawId,
  ]);
  db.run(
    "insert into semantic_merge (from_semantic_id, to_semantic_id, appended_description) values (?, ?, 'note')",
    [rawId, canonicalId],
  );

  const taxonomyId = db.get<{ id: number }>(
    "select id from finding_category where category = 'Arithmetic' and name = 'Integer Overflow'",
  )!.id;

  const insertFinding = (title: string): number => {
    const id = db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values (?, 'High', 'rc', 'desc', 'p', 'e')`,
      [title],
    ).lastInsertRowid;
    db.run(
      "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
      [id, taxonomyId],
    );
    db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
      projectId,
      id,
    ]);
    return id;
  };

  const firstFinding = insertFinding("First");
  const secondFinding = insertFinding("Second");

  db.run(
    `insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence)
     values (?, ?, 'High', 'in-project link: fake')`,
    [canonicalId, firstFinding],
  );
  db.run(
    `insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence)
     values (?, ?, 'Medium', 'cross-project evidence')`,
    [canonicalId, secondFinding],
  );
  db.run("insert into pending_semantic (semantic_node_id) values (?)", [canonicalId]);

  return { db };
}

test("stats split in-project from cross links by evidence prefix", async () => {
  const { db } = await seededStats();
  const s = readStats(db);
  assert.equal(s.linksTotal, 2);
  assert.equal(s.linksInProject, 1);
  assert.equal(s.linksCross, 1);
  assert.equal(s.semanticsCanonical, 1);
  assert.equal(s.pendingSemantics, 1);
});

test("progress reporter writes JSONL and forwards updates to the tool UI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "progress-"));
  const logPath = join(dir, "progress.log");
  const seen: Record<string, unknown>[] = [];
  const report = createProgressReporter({
    logPath,
    sink: (update) => {
      seen.push(update);
    },
  });

  await report({ stage: "semantics", detail: "extracting", contest: 453 });

  const line = JSON.parse(readFileSync(logPath, "utf8").trim()) as Record<string, unknown>;
  assert.equal(line.stage, "semantics");
  assert.equal(line.contest, 453);
  assert.equal(line.source, "knowdit");
  assert.equal(typeof line.at, "string");
  assert.deepEqual(seen, [
    { source: "knowdit", stage: "semantics", detail: "extracting", contest: 453 },
  ]);
});

test("registers all five tools in the knowdit namespace", () => {
  const tools: string[] = [];
  registerKnowditTools(
    { namespace: () => {}, add: (t) => tools.push(t.name) },
    {
      dataset_prepare: async () => ({ content: "" }),
      kg_build: async () => ({ content: "" }),
      kg_status: async () => ({ content: "" }),
      kg_query: async () => ({ content: "" }),
      kg_stats: async () => ({ content: "" }),
    },
  );
  assert.deepEqual(tools.sort(), [
    "dataset_prepare",
    "kg_build",
    "kg_query",
    "kg_stats",
    "kg_status",
  ]);
});
