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

test("refuses merge and global link while a failed contest is not skipped", async () => {
  const { deps } = await fakeBuild({ contests: [229, 71], failContest: 229 });
  await assert.rejects(() => buildKg({ ...deps }), /contest 229/i);
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
