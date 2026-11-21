import test from "node:test";
import assert from "node:assert/strict";
import type { LlmCaller } from "../../.opencode/plugins/knowdit/src/llm/types.ts";
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

test("fails fast when the build fingerprint changed", async () => {
  const { deps } = await fakeBuild({ contests: [229] });
  await buildKg({ ...deps });

  await assert.rejects(
    () => buildKg({ ...deps, contextWindow: 123_456 }),
    /fingerprint changed|reset_all/i,
  );
});

test("reset_all rebinds the fingerprint and rebuilds cleanly", async () => {
  const { deps } = await fakeBuild({ contests: [229] });
  await buildKg({ ...deps });

  const result = await buildKg({ ...deps, contextWindow: 123_456, resetAll: true });

  assert.equal(result.integrity.ok, true);
});

test("refuses an unversioned journal that already has completed units", async () => {
  const { deps } = await fakeBuild({
    contests: [229],
    alreadyDone: true,
    bindFingerprint: false,
  });

  await assert.rejects(() => buildKg({ ...deps }), /unversioned|reset_all/i);
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

test("repairs an in-project link lost after the link stage was journaled done", async () => {
  const { deps, order } = await fakeBuild({ contests: [229] });
  await buildKg({ ...deps });
  const linkRuns = order.filter((entry) => entry === "link:229").length;

  // Simulate observed C4-286 state: findings were re-extracted (or links were
  // cleared) after the link unit finished, leaving the finding ungrounded.
  deps.db.run("delete from semantic_finding_link");

  const result = await buildKg({ ...deps });

  assert.equal(result.integrity.ok, true);
  assert.equal(order.filter((entry) => entry === "link:229").length, linkRuns + 1);
  assert.equal(
    deps.db.get<{ n: number }>(
      "select count(*) n from semantic_finding_link where evidence like 'in-project link:%'",
    )!.n,
    1,
  );
});

test("passes the model context window to the global linker", async () => {
  const { deps } = await fakeBuild({ contests: [229, 71], contextWindow: 2_000 });
  const base = deps.llm;
  let globalCalls = 0;
  const llm = {
    async json<T>(input: {
      prompt: string;
      validate: (value: unknown) => T;
      key?: string;
    }): Promise<{ value: T; tokensEst: number; costEst: number }> {
      if (input.prompt.includes('"semantic_evidence"')) globalCalls += 1;
      return base.json(input);
    },
  } as LlmCaller;

  await buildKg({ ...deps, llm, contextWindow: 2_000 });

  // 2 candidate chunks × 2 finding batches at the 20% utilization of a
  // 2 000-token window; the unwired 8 000-token fallback makes one call.
  assert.equal(globalCalls, 4);
});

test("a cross-contest merge does not make the merged contest look link-incomplete", async () => {
  const { deps, order } = await fakeBuild({ contests: [229, 71] });
  const base = deps.llm;
  const canonicalId = () =>
    deps.db.get<{ id: number }>(
      "select id from audit_finding where title = 'Fake Finding 229'",
    )!.id;
  const llm = {
    async json<T>(input: {
      prompt: string;
      validate: (value: unknown) => T;
      key?: string;
    }): Promise<{ value: T; tokensEst: number; costEst: number }> {
      if (
        input.prompt.includes('"new_finding_title"') &&
        input.prompt.includes("Fake Finding 71")
      ) {
        return {
          value: input.validate({
            decisions: [
              {
                reason: "fake cross-contest fold",
                new_finding_title: "Fake Finding 71",
                merge_target_ids: [canonicalId()],
                appended_description: "note",
                appended_patterns: "note",
                appended_exploits: "note",
              },
            ],
          }),
          tokensEst: 1,
          costEst: 0,
        };
      }
      return base.json(input);
    },
  } as LlmCaller;

  const first = await buildKg({ ...deps, llm });
  assert.equal(first.integrity.ok, true);

  const linkRuns = order.filter((entry) => entry === "link:71").length;
  const second = await buildKg({ ...deps, llm });

  assert.equal(second.integrity.ok, true);
  assert.equal(order.filter((entry) => entry === "link:71").length, linkRuns);
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

test("global-link progress stays at zero until findings actually finish", async () => {
  const updates: Record<string, unknown>[] = [];
  const { deps } = await fakeBuild({ contests: [229, 71, 101] });

  await buildKg({
    ...deps,
    onProgress: (update) => {
      updates.push(update);
    },
  });

  const global = updates.filter((update) => update.stage === "global");
  const starts = global.filter((update) => /^Linking finding \d+\//.test(String(update.detail)));
  const finishes = global.filter((update) =>
    /^(Linked|Failed) finding \d+\//.test(String(update.detail)),
  );

  assert.equal(starts.length, 3);
  assert.equal(finishes.length, 3);
  // A start event only announces work; it must not claim any completed links.
  assert.deepEqual(
    starts.map((update) => update.completed),
    [0, 0, 0],
  );
  // Only terminal events advance the bar, one finding at a time.
  assert.deepEqual(
    finishes.map((update) => update.completed),
    [1, 2, 3],
  );
});
