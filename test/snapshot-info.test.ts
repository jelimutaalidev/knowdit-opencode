import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLatestSnapshot } from "../.opencode/plugins/knowdit/src/snapshot-info.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "snapshot-info-"));
}

function writeIdentity(dir: string, over: Record<string, unknown> = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "identity.json"),
    JSON.stringify({
      snapshotVersion: 1,
      createdAt: "2026-11-19T00:00:00.000Z",
      commit: "abc123",
      pipelineVersion: "2026-11-19.p0p1.4",
      journal: {
        fingerprint: "fp-current",
        units: { total: 17, done: 17, failed: 0, running: 0 },
      },
      ...over,
    }),
  );
}

test("picks the newest valid bundle and reports its age", () => {
  const root = tempRoot();
  writeIdentity(join(root, "fp-a", "older"), {
    createdAt: "2026-11-18T00:00:00.000Z",
  });
  const newest = join(root, "fp-b", "newest");
  writeIdentity(newest, { createdAt: "2026-11-19T00:00:00.000Z" });

  const found = findLatestSnapshot({
    root,
    now: new Date("2026-11-19T01:00:00.000Z"),
  });

  assert.equal(found.found, true);
  assert.equal(found.truncated, false);
  assert.equal(found.latest?.path, newest);
  assert.equal(found.latest?.ageSeconds, 3600);
  assert.equal(found.latest?.fingerprint, "fp-current");
  assert.deepEqual(found.latest?.units, {
    total: 17,
    done: 17,
    failed: 0,
    running: 0,
  });
});

test("ignores invalid, incompatible, and hidden bundles", () => {
  const root = tempRoot();
  const valid = join(root, "fp-valid", "stamp");
  writeIdentity(valid, { createdAt: "2026-11-18T00:00:00.000Z" });

  const invalid = join(root, "fp-invalid", "stamp");
  mkdirSync(invalid, { recursive: true });
  writeFileSync(join(invalid, "identity.json"), "{not json");

  writeIdentity(join(root, "fp-v2", "stamp"), {
    snapshotVersion: 2,
    createdAt: "2026-11-20T00:00:00.000Z",
  });
  writeIdentity(join(root, ".tmp-123", "stamp"), {
    createdAt: "2026-11-21T00:00:00.000Z",
  });

  const found = findLatestSnapshot({ root });

  assert.equal(found.found, true);
  assert.equal(found.latest?.path, valid);
});

test("reports truncation instead of silently missing bundles", () => {
  const root = tempRoot();
  for (const name of ["a", "b", "c"]) writeIdentity(join(root, name));

  const found = findLatestSnapshot({ root, maxCandidates: 2 });

  assert.equal(found.found, true);
  assert.equal(found.truncated, true);
});

test("does not descend past maxDepth", () => {
  const root = tempRoot();
  const tooDeep = join(root, "a", "b", "c");
  writeIdentity(tooDeep);

  assert.equal(findLatestSnapshot({ root, maxDepth: 2 }).found, false);
  assert.equal(findLatestSnapshot({ root, maxDepth: 3 }).found, true);
});

test("returns not found for a missing or empty root", () => {
  const root = tempRoot();
  const missing = findLatestSnapshot({ root: join(root, "nope") });
  assert.equal(missing.found, false);
  assert.equal(missing.latest, null);

  const empty = findLatestSnapshot({ root });
  assert.equal(empty.found, false);
  assert.equal(empty.truncated, false);
});

test("falls back to file mtime when createdAt is invalid", () => {
  const root = tempRoot();
  const bundle = join(root, "fp-x", "stamp");
  writeIdentity(bundle, { createdAt: "not-a-date" });

  const found = findLatestSnapshot({ root });

  assert.equal(found.found, true);
  assert.equal(found.latest?.path, bundle);
  assert.ok((found.latest?.ageSeconds ?? -1) >= 0);
});
