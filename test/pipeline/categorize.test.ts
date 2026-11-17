import test from "node:test";
import assert from "node:assert/strict";
import { categorizeProject } from "../../.opencode/plugins/knowdit/src/pipeline/categorize.ts";
import { fakeCtx } from "../helpers/ctx.ts";

test("writes project, platform, and categories; dedupes input", async () => {
  const { ctx, prompts } = await fakeCtx({ categories: ["Dexes", "Dexes", "Lending"] });
  const r = await categorizeProject(ctx);
  assert.deepEqual(r.categories, ["Dexes", "Lending"]);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project")!.n, 1);
  assert.equal(ctx.db.get<{ status: string }>("select status from project")!.status, "completed");
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project_category")!.n, 2);
  assert.equal(ctx.db.get<{ platform_id: string }>("select platform_id from project_platform")!.platform_id, "c4-229");
  assert.ok(prompts[0].includes("src/A.sol"));
  assert.ok(prompts[0].includes("SOURCE-SENTINEL"));
});

test("rejects an out-of-enum category and writes nothing", async () => {
  const { ctx } = await fakeCtx({ categories: ["Gaming"] });
  await assert.rejects(() => categorizeProject(ctx), /unknown DeFi category/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from project")!.n, 0);
});
