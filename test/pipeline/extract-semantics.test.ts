import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { dedupSemantics, extractSemantics } from "../../.opencode/plugins/knowdit/src/pipeline/extract-semantics.ts";
import { fakeCtx } from "../helpers/ctx.ts";

const sem = (name: string, over: Partial<{ description: string; functions: { name: string; contract: string }[] }> = {}) => ({
  name, category: "Dexes", definition: "d", description: over.description ?? "x",
  functions: over.functions ?? [{ name: "swap", contract: "src/A.sol" }],
});

test("dedup merges functions and keeps the longer description", () => {
  const out = dedupSemantics([
    sem("Swap", { description: "short" }),
    sem(" swap ", { description: "much longer", functions: [{ name: "swapExact", contract: "src/A.sol" }, { name: "swap", contract: "src/A.sol" }] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].description, "much longer");
  assert.equal(out[0].functions.length, 2);
});

test("persists raw node, category, functions, and provenance", async () => {
  const { ctx } = await fakeCtx({ semantics: [sem("Swap")] });
  const r = await extractSemantics(ctx);
  assert.equal(r.rawIds.length, 1);
  assert.equal(ctx.db.get<{ category: string }>("select category from semantic_node")!.category, "Dexes");
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_function")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project_semantic")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from sqlite_master where type='table' and name='semantic_node_category'")!.n, 0);
});

test("reuses existing project semantics on retry instead of duplicating", async () => {
  const { ctx, llm } = await fakeCtx({ semantics: [sem("Swap")] });
  const first = await extractSemantics(ctx);
  const calls = llm.calls;

  const second = await extractSemantics(ctx);

  assert.deepEqual(second.rawIds, first.rawIds);
  assert.equal(llm.calls, calls);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_node")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project_semantic")!.n, 1);
});

test("rejects a semantic with no functions or a file outside the snapshot", async () => {
  const noFunctions = await fakeCtx({ semantics: [{ ...sem("Swap"), functions: [] }] });
  await assert.rejects(() => extractSemantics(noFunctions.ctx), /at least one function/i);
  assert.equal(noFunctions.ctx.db.get<{ n: number }>("select count(*) n from semantic_node")!.n, 0);

  const badFile = await fakeCtx({ semantics: [sem("Swap", { functions: [{ name: "swap", contract: "src/Missing.sol" }] })] });
  await assert.rejects(() => extractSemantics(badFile.ctx), /not in the snapshot/i);
  assert.equal(badFile.ctx.db.get<{ n: number }>("select count(*) n from semantic_node")!.n, 0);
});

test("sizes extraction chunks from the model context window", async () => {
  const big = `contract Big {\n${"// padding line\n".repeat(12_000)}}\n`;
  assert.ok(big.length > 100_000);

  async function run(contextWindow?: number) {
    const fake = await fakeCtx({ semantics: [sem("Swap")] });
    writeFileSync(join(fake.ctx.datasetDir, "contracts", "229", "src", "Big.sol"), big);
    fake.ctx.contest = { ...fake.ctx.contest, sourceFiles: ["src/A.sol", "src/Big.sol"] };
    if (contextWindow !== undefined) fake.ctx.contextWindow = contextWindow;
    await extractSemantics(fake.ctx);
    const count = fake.prompts.length;
    fake.cleanup();
    return count;
  }

  assert.equal(await run(1_000_000), 1, "a ~200k-token window should fit one chunk");
  assert.ok((await run()) > 1, "the 8k fallback should split the same project");
});
