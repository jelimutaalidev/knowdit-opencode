import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openJournal } from "../.opencode/plugins/knowdit/src/journal.ts";
import { openKg } from "../.opencode/plugins/knowdit/src/db/client.ts";

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

test("binds a build fingerprint and allows resume under the same one", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "j-")), "runs.sqlite");
  const j = await openJournal(path);
  j.ensureFingerprint("manifest-a|pipeline-1");
  j.done({ stage: "findings", c4Id: 110, unitIndex: 0 });
  j.close();

  const resumed = await openJournal(path);
  resumed.ensureFingerprint("manifest-a|pipeline-1");
  assert.equal(
    resumed.isDone({ stage: "findings", c4Id: 110, unitIndex: 0 }),
    true,
  );
  resumed.close();
});

test("reset_all records its reason and keeps it through fingerprint rebinding", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "j-")), "runs.sqlite");
  const j = await openJournal(path);
  j.ensureFingerprint("manifest-a|pipeline-1");
  j.done({ stage: "findings", c4Id: 110, unitIndex: 0 });
  j.resetAll("imported KG was rebuilt from a different dataset");
  j.ensureFingerprint("manifest-b|pipeline-2");
  j.close();

  const db = await openKg(path);
  const row = db.get<{ value: string }>(
    "select value from journal_meta where key = 'reset_reason'",
  );
  assert.equal(row?.value, "imported KG was rebuilt from a different dataset");
  db.close();
});

test("rejects resume when the dataset or pipeline fingerprint changed", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "j-")), "runs.sqlite");
  const j = await openJournal(path);
  j.ensureFingerprint("manifest-a|pipeline-1");
  j.done({ stage: "findings", c4Id: 110, unitIndex: 0 });
  j.close();

  const changed = await openJournal(path);
  assert.throws(
    () => changed.ensureFingerprint("manifest-b|pipeline-1"),
    /fingerprint changed|dataset changed|reset_all/i,
  );
  changed.close();
});

test("treats an unversioned journal with completed units as stale", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "j-")), "runs.sqlite");
  const j = await openJournal(path);
  j.done({ stage: "findings", c4Id: 110, unitIndex: 0 });
  j.close();

  const legacy = await openJournal(path);
  assert.throws(
    () => legacy.ensureFingerprint("manifest-a|pipeline-1"),
    /unversioned|no build fingerprint|reset_all/i,
  );
  legacy.close();
});
