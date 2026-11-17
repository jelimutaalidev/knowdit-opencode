import test from "node:test";
import assert from "node:assert/strict";
import { dedupFindings, extractFindings } from "../../.opencode/plugins/knowdit/src/pipeline/extract-findings.ts";
import { fakeCtx } from "../helpers/ctx.ts";

const finding = (over: Partial<{ title: string; severity: "High" | "Medium" | "Low"; description: string; root_cause: string }> = {}) => ({
  title: over.title ?? "Bad thing", severity: over.severity ?? "Medium", category: "Arithmetic",
  subcategory: "Integer Overflow", root_cause: over.root_cause ?? "rc",
  description: over.description ?? "d", patterns: "p", exploits: "e",
});

test("dedup keeps the higher severity and the longer text", () => {
  const out = dedupFindings([finding({ severity: "Medium", description: "short" }), finding({ severity: "High", description: "a much longer description", root_cause: "a longer root cause" })]);
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, "High");
  assert.equal(out[0].description, "a much longer description");
  assert.equal(out[0].root_cause, "a longer root cause");
});

test("persists raw finding, taxonomy, and provenance", async () => {
  const { ctx } = await fakeCtx({ findings: [finding()] });
  await extractFindings(ctx);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding_category")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project_finding")!.n, 1);
});

test("reuses existing project findings on retry instead of duplicating", async () => {
  const { ctx, llm } = await fakeCtx({ findings: [finding()] });
  const first = await extractFindings(ctx);
  const calls = llm.calls;

  const second = await extractFindings(ctx);

  assert.deepEqual(second.rawIds, first.rawIds);
  assert.equal(llm.calls, calls);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project_finding")!.n, 1);
});

test("rejects an unknown taxonomy pair and writes nothing", async () => {
  const { ctx } = await fakeCtx({ findings: [{ ...finding(), subcategory: "Nope" }] });
  await assert.rejects(() => extractFindings(ctx), /unknown subcategory/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding")!.n, 0);
});

test("prompt carries the trimmed report and no contract source", async () => {
  const { ctx, prompts } = await fakeCtx({ findings: [finding()] });
  await extractFindings(ctx);
  assert.ok(prompts.every((p) => p.includes("REPORT-BODY")));
  assert.ok(prompts.every((p) => !p.includes("SOURCE-SENTINEL")));
});
