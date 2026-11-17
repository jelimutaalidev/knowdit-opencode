import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKg, seedReferenceTables } from "../../.opencode/plugins/knowdit/src/db/client.ts";

const fixture = JSON.parse(readFileSync("test/fixtures/schema-1.0.1.json", "utf8"));

test("applies the reference schema and seeds 14/7/45", async () => {
  const db = await openKg(join(mkdtempSync(join(tmpdir(), "kg-")), "kg.sqlite"));
  const tables = db.all<{ name: string }>(
    "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name",
  ).map((r) => r.name);
  assert.deepEqual(tables, Object.keys(fixture.tables).sort());
  for (const [table, columns] of Object.entries(fixture.tables)) {
    const actual = db.all<{ name: string }>(`pragma table_info("${table}")`).map((c) => c.name);
    assert.deepEqual(actual, (columns as { name: string }[]).map((c) => c.name), table);
  }
  seedReferenceTables(db);
  seedReferenceTables(db);
  assert.equal(db.get<{ n: number }>("select count(*) n from category")!.n, 14);
  assert.equal(db.get<{ n: number }>("select count(*) n from finding_category")!.n, 45);
  assert.equal(db.get<{ n: number }>("select count(distinct category) n from finding_category")!.n, 7);
  assert.throws(() => db.run(
    "insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence) values (999, 999, 'High', 'x')",
  ));
  db.close();
});
