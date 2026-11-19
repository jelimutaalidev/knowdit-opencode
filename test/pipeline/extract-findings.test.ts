import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_FINDING_REPAIR_ATTEMPTS,
  dedupFindings,
  extractFindings,
} from "../../.opencode/plugins/knowdit/src/pipeline/extract-findings.ts";
import { ModelLimitError } from "../../.opencode/plugins/knowdit/src/llm/caller.ts";
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

test("drops a finding with an unknown taxonomy pair and keeps valid ones", async () => {
  const { ctx, llm } = await fakeCtx({
    findings: [
      finding({ title: "Good thing" }),
      { ...finding({ title: "Bad thing" }), subcategory: "Nope" },
    ],
  });

  const result = await extractFindings(ctx);

  assert.equal(result.rawIds.length, 1);
  assert.deepEqual(
    ctx.db
      .all<{ title: string }>("select title from audit_finding order by id")
      .map((row) => row.title),
    ["Good thing"],
  );
  assert.equal(llm.calls, 2, "an omitted repair response resolves the rejection");
});

test("repairs a rejected finding with per-item reasons", async () => {
  const { ctx, llm, prompts } = await fakeCtx({
    findings: [
      finding({ title: "Good thing" }),
      { ...finding({ title: "Bad thing" }), subcategory: "Nope" },
    ],
    repairFindings: [finding({ title: "Bad thing" })],
  });

  const result = await extractFindings(ctx);

  assert.equal(result.rawIds.length, 2);
  assert.equal(llm.calls, 2);
  const repairPrompt = prompts[1];
  assert.match(repairPrompt, /### Rejected Findings/);
  assert.match(repairPrompt, /unknown subcategory 'Nope'/);
  assert.match(repairPrompt, /Bad thing/);
  assert.match(repairPrompt, /Already Accepted Findings/);
  assert.match(repairPrompt, /Good thing/);
  assert.deepEqual(
    ctx.db
      .all<{ title: string }>("select title from audit_finding order by id")
      .map((row) => row.title),
    ["Good thing", "Bad thing"],
  );
});

test("drops findings still invalid after the bounded repair attempts", async () => {
  const invalid = { ...finding({ title: "Bad thing" }), subcategory: "Nope" };
  const { ctx, llm } = await fakeCtx({
    findings: [invalid],
    repairFindings: [invalid],
  });

  const result = await extractFindings(ctx);

  assert.deepEqual(result.rawIds, []);
  assert.equal(llm.calls, 1 + MAX_FINDING_REPAIR_ATTEMPTS);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding")!.n, 0);
});

test("counts every duplicate-title rejection when the repair omits them", async () => {
  const first = { ...finding({ title: "Duplicate thing" }), subcategory: "Nope" };
  const second = { ...finding({ title: "Duplicate thing" }), severity: "Severe" };
  const { ctx } = await fakeCtx({ findings: [first, second] });

  const result = await extractFindings(ctx);

  assert.deepEqual(result.rawIds, []);
  assert.equal(result.dropped, 2);
});

test("one repaired item resolves only one duplicate-title rejection", async () => {
  const first = { ...finding({ title: "Duplicate thing" }), subcategory: "Nope" };
  const second = { ...finding({ title: "Duplicate thing" }), severity: "Severe" };
  const { ctx } = await fakeCtx({
    findings: [first, second],
    repairFindings: [finding({ title: "Duplicate thing" })],
  });

  const result = await extractFindings(ctx);

  assert.equal(result.rawIds.length, 1);
  assert.equal(result.dropped, 1);
});

test("repair prompt disambiguates accepted findings by root cause", async () => {
  const { ctx, prompts } = await fakeCtx({
    findings: [
      finding({ title: "Collision", root_cause: "already accepted root cause" }),
      {
        ...finding({ title: "Collision", root_cause: "rejected root cause" }),
        subcategory: "Nope",
      },
    ],
    repairFindings: [finding({ title: "Collision", root_cause: "repaired root cause" })],
  });

  await extractFindings(ctx);

  const acceptedSection = prompts[1].split("### Already Accepted Findings")[1] ?? "";
  assert.match(acceptedSection, /already accepted root cause/);
  assert.match(prompts[1], /rejected root cause/);
});

test("an accepted echo does not resolve a same-title rejection", async () => {
  const accepted = finding({ title: "Collision", root_cause: "accepted root cause" });
  const rejected = {
    ...finding({ title: "Collision", root_cause: "rejected root cause" }),
    subcategory: "Nope",
  };
  const { ctx } = await fakeCtx({
    findings: [accepted, rejected],
    repairFindings: [accepted],
  });

  const result = await extractFindings(ctx);

  assert.equal(result.rawIds.length, 1);
  assert.equal(result.dropped, 1);
});

test("does not inflate the rejection queue with duplicate repair output", async () => {
  const invalid = { ...finding({ title: "Bad thing" }), subcategory: "Nope" };
  const { ctx, llm } = await fakeCtx({
    findings: [invalid],
    repairFindings: [invalid, invalid],
  });

  const result = await extractFindings(ctx);

  assert.deepEqual(result.rawIds, []);
  assert.equal(result.dropped, 1);
  assert.equal(llm.calls, 1 + MAX_FINDING_REPAIR_ATTEMPTS);
});

test("keeps a structural extraction error fatal", async () => {
  const { ctx } = await fakeCtx({
    findings: "not-an-array" as unknown as never,
  });

  await assert.rejects(() => extractFindings(ctx), /expected a findings array/);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding")!.n, 0);
});

test("fails fast on a model limit during repair", async () => {
  const invalid = { ...finding({ title: "Bad thing" }), subcategory: "Nope" };
  const { ctx, llm } = await fakeCtx({
    findings: [invalid],
    repairError: new ModelLimitError("free usage limit"),
  });

  await assert.rejects(
    () => extractFindings(ctx),
    (error: unknown) => error instanceof ModelLimitError,
  );
  assert.equal(llm.calls, 2);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from audit_finding")!.n, 0);
});

test("does not call repair when every finding passed validation", async () => {
  const { ctx, llm } = await fakeCtx({ findings: [finding()] });
  await extractFindings(ctx);
  assert.equal(llm.calls, 1);
});

test("prompt carries the trimmed report and no contract source", async () => {
  const { ctx, prompts } = await fakeCtx({ findings: [finding()] });
  await extractFindings(ctx);
  assert.ok(prompts.every((p) => p.includes("REPORT-BODY")));
  assert.ok(prompts.every((p) => !p.includes("SOURCE-SENTINEL")));
});
