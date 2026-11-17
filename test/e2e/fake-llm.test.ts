import test from "node:test";
import assert from "node:assert/strict";
import { buildKg } from "../../.opencode/plugins/knowdit/src/pipeline/build.ts";
import { fakeBuild } from "../helpers/build.ts";
import { tableDigests } from "../helpers/digest.ts";

test("one contest, fake llm, full pipeline, clean integrity", async () => {
  const { deps } = await fakeBuild({
    contests: [229],
    canned: true,
    dbPath: "data/tmp/e2e.sqlite",
  });
  const r = await buildKg({ ...deps });
  assert.equal(r.integrity.ok, true);
  assert.ok(
    deps.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n >= 1,
  );
  assert.equal(
    deps.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n,
    deps.db.get<{ n: number }>("select count(*) n from audit_finding")!.n,
  );
});

test("rebuild from cache is hash-identical at concurrency 1", async () => {
  const a = await fakeBuild({
    contests: [229],
    canned: true,
    dbPath: "data/tmp/ge-a.sqlite",
  });
  await buildKg({ ...a.deps });

  const b = await fakeBuild({
    contests: [229],
    canned: true,
    dbPath: "data/tmp/ge-b.sqlite",
  });
  await buildKg({ ...b.deps });

  assert.deepEqual(tableDigests(a.deps.db), tableDigests(b.deps.db));
});
