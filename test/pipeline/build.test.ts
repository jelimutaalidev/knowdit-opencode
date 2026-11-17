import test from "node:test";
import assert from "node:assert/strict";
import { buildKg, resetContest } from "../../.opencode/plugins/knowdit/src/pipeline/build.ts";
import { fakeBuild } from "../helpers/build.ts";

test("runs stages in order for each contest and finalizes once", async () => {
  const { deps, order } = await fakeBuild({ contests: [229, 71] });
  const r = await buildKg({ ...deps });
  assert.deepEqual(order, [
    "categorize:229",
    "semantics:229",
    "findings:229",
    "link:229",
    "merge:229",
    "categorize:71",
    "semantics:71",
    "findings:71",
    "link:71",
    "merge:71",
    "global",
    "finalize",
  ]);
  assert.equal(r.contests, 2);
});

test("does not re-run a contest whose units are done", async () => {
  const { deps, order } = await fakeBuild({ contests: [229], alreadyDone: true });
  await buildKg({ ...deps });
  assert.ok(!order.includes("categorize:229"));
});

test("force after merge requires resetAll", async () => {
  const { deps } = await fakeBuild({ contests: [229], merged: true });
  await assert.rejects(() => buildKg({ ...deps, force: true }), /reset_all/i);
});

test("retries a failed unit in place before merge and global linking", async () => {
  const { deps, order } = await fakeBuild({ contests: [229, 71], failContest: 229 });
  const result = await buildKg({ ...deps });

  assert.equal(result.integrity.ok, true);
  assert.ok(order.includes("merge:229"));
  assert.equal(
    deps.journal.list(229).find((unit) => unit.stage === "merge")!.status,
    "done",
  );
});

test("emits live progress for every stage of a build", async () => {
  const updates: Record<string, unknown>[] = [];
  const { deps } = await fakeBuild({ contests: [229] });

  await buildKg({
    ...deps,
    onProgress: (update) => {
      updates.push(update);
    },
  });

  const stages = new Set(updates.map((update) => update.stage));
  for (const stage of [
    "categorize",
    "semantics",
    "findings",
    "link",
    "merge",
    "contest_done",
    "global",
    "finalize",
    "done",
  ]) {
    assert.ok(stages.has(stage), `missing progress stage '${stage}'`);
  }
  assert.ok(updates.every((update) => typeof update.detail === "string"));
});

test("repairs global links when global is marked done but findings lack status", async () => {
  const { deps, order } = await fakeBuild({ contests: [229] });
  await buildKg({ ...deps });
  assert.equal(
    deps.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n,
    1,
  );

  // Simulate the observed failure: the global unit was journaled done while
  // findings still had in-project links but no global-link decision.
  deps.db.run("delete from finding_link_status");
  const globalRuns = order.filter((entry) => entry === "global").length;

  const result = await buildKg({ ...deps });

  assert.equal(result.integrity.ok, true);
  assert.equal(
    deps.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n,
    1,
  );
  assert.equal(order.filter((entry) => entry === "global").length, globalRuns + 1);
});

test("a skipped contest unblocks the rest of the build", async () => {
  const { deps, journal } = await fakeBuild({ contests: [229, 71], failContest: 229 });
  journal.skip(229, "accepted after review");
  const r = await buildKg({ ...deps });
  assert.equal(r.integrity.ok, true);
});

test("resetContest removes only that contest's rows", async () => {
  const { deps } = await fakeBuild({ contests: [229, 71] });
  await buildKg({ ...deps });
  resetContest(deps.db, 229);
  assert.equal(deps.db.get<{ n: number }>("select count(*) n from project")!.n, 1);
});
