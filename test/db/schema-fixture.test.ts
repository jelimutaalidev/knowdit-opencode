import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync("test/fixtures/schema-1.0.1.json", "utf8"));

test("fixture is the 18-table v1.0.1 schema", () => {
  assert.equal(fixture.version, "1.0.1");
  assert.deepEqual(Object.keys(fixture.tables).sort(), [
    "audit_finding", "audit_finding_category", "category", "finding_category",
    "finding_link_status", "finding_merge", "merge_status", "operation_history",
    "pending_semantic", "project", "project_category", "project_finding",
    "project_platform", "project_semantic", "semantic_finding_link",
    "semantic_function", "semantic_merge", "semantic_node",
  ]);
  assert.equal(fixture.tables.category.length, 2);
  assert.equal(fixture.tables.finding_category.length, 4);
  assert.deepEqual(
    fixture.tables.semantic_finding_link.map((c: { name: string }) => c.name),
    ["semantic_node_id", "audit_finding_id", "strength", "evidence"],
  );
  assert.equal(fixture.tables.semantic_finding_link.filter((c: { pk: number }) => c.pk > 0).length, 2);
  assert.equal(Object.keys(fixture.tables).length, 18);
});
