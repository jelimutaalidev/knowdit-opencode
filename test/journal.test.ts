import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../.opencode/plugins/knowdit/src/journal.ts";

test("tracks lifecycle and survives reopen", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "j-")), "runs.sqlite");
  const j = await openJournal(path);
  const unit = { stage: "extract_semantics", c4Id: 110, unitIndex: 0 };
  assert.equal(j.isDone(unit), false);
  j.start(unit);
  j.done(unit, { tokensEst: 10, costEst: 1, promptHash: "p", responseHash: "r" });
  assert.equal(j.isDone(unit), true);
  j.close();
  const j2 = await openJournal(path);
  assert.equal(j2.isDone(unit), true);
  assert.equal(j2.list(110).find((r) => r.unitIndex === 0)?.status, "done");
  j2.fail({ ...unit, unitIndex: 1 }, "boom");
  assert.equal(j2.list(110).find((r) => r.unitIndex === 1)?.status, "failed");
  j2.skip(110, "operator approved skip");
  assert.equal(j2.isSkipped(110), true);
  j2.resetContest(110);
  assert.deepEqual(j2.list(110), []);
  assert.equal(j2.isSkipped(110), false);
  j2.close();
});
