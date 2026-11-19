import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  defaultSnapshotDir,
  readIdentity,
  restoreState,
  sha256File,
  snapshotState,
} from "../../scripts/state.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "knowdit-state-test-"));
}

function makeDb(path: string, build: (db: DatabaseSync) => void): void {
  const db = new DatabaseSync(path);
  try {
    build(db);
  } finally {
    db.close();
  }
}

function makeData(
  root: string,
  opts: { projectName?: string; running?: boolean } = {},
): string {
  const data = join(root, "data");
  mkdirSync(join(data, "dataset", "reports"), { recursive: true });
  writeFileSync(
    join(data, "dataset", "manifest.json"),
    JSON.stringify(
      {
        generatedAt: "2026-11-19T00:00:00.000Z",
        contests: [{ c4Id: 453 }],
        excluded: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(data, "dataset", "reports", "453.md"), "# report\n");
  mkdirSync(join(data, "cache"), { recursive: true });
  writeFileSync(join(data, "cache", "abc.json"), '{"cached":true}\n');

  makeDb(join(data, "kg.sqlite"), (db) => {
    db.exec("create table project (id integer primary key, name text not null)");
    db.prepare("insert into project (name) values (?)").run(
      opts.projectName ?? "demo",
    );
  });

  makeDb(join(data, "runs.sqlite"), (db) => {
    db.exec(
      "create table journal_meta (key text primary key, value text not null, updated_at text not null)",
    );
    db.prepare("insert into journal_meta values (?, ?, ?)").run(
      "build_fingerprint",
      "fp-test",
      "2026-11-19T00:00:00.000Z",
    );
    db.exec(
      "create table unit_status (stage text not null, c4_id integer not null, unit_index integer not null, status text not null, primary key (stage, c4_id, unit_index))",
    );
    db.prepare("insert into unit_status values (?, ?, ?, ?)").run(
      "categorize",
      453,
      0,
      "done",
    );
    db.prepare("insert into unit_status values (?, ?, ?, ?)").run(
      "semantics",
      453,
      0,
      "failed",
    );
    if (opts.running) {
      db.prepare("insert into unit_status values (?, ?, ?, ?)").run(
        "findings",
        453,
        0,
        "running",
      );
    }
    db.exec(
      "create table contest_status (c4_id integer primary key, status text not null, reason text, updated_at text not null)",
    );
    db.prepare("insert into contest_status values (?, ?, ?, ?)").run(
      453,
      "running",
      null,
      "2026-11-19T00:00:00.000Z",
    );
  });

  return data;
}

function gitRepo(root: string, content: string): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "file.txt"), content);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "file.txt"], { cwd: root });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "init"],
    { cwd: root },
  );
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

test("snapshot writes a self-contained bundle with identity digests", () => {
  const root = tempRoot();
  const data = makeData(root);
  const out = join(root, "bundle");

  const identity = snapshotState({ dataDir: data, outDir: out, repoDir: root });

  assert.equal(identity.snapshotVersion, 1);
  assert.equal(identity.journal.fingerprint, "fp-test");
  assert.deepEqual(identity.journal.units, {
    total: 2,
    done: 1,
    failed: 1,
    running: 0,
  });
  assert.equal(identity.dataset.contests, 1);
  assert.equal(identity.dataset.generatedAt, "2026-11-19T00:00:00.000Z");
  assert.equal(identity.artifacts.kg.sha256, sha256File(join(out, "kg.sqlite")));
  assert.equal(identity.artifacts.runs.sha256, sha256File(join(out, "runs.sqlite")));
  assert.ok(existsSync(join(out, "dataset", "reports", "453.md")));
  assert.ok(existsSync(join(out, "cache", "abc.json")));
  assert.ok(!existsSync(join(out, "kg.sqlite-wal")));

  const db = new DatabaseSync(join(out, "kg.sqlite"));
  try {
    assert.equal(db.prepare("select name from project").get().name, "demo");
  } finally {
    db.close();
  }
});

test("snapshot refuses a journal with a running unit unless allowed", () => {
  const root = tempRoot();
  const data = makeData(root, { running: true });
  const out = join(root, "bundle");

  assert.throws(
    () => snapshotState({ dataDir: data, outDir: out, repoDir: root }),
    /running/i,
  );

  const identity = snapshotState({
    dataDir: data,
    outDir: out,
    repoDir: root,
    allowRunning: true,
  });
  assert.equal(identity.journal.units.running, 1);
});

test("snapshot refuses to replace an existing bundle unless forced", () => {
  const root = tempRoot();
  const data = makeData(root);
  const out = join(root, "bundle");

  snapshotState({ dataDir: data, outDir: out, repoDir: root });
  const first = readIdentity(out);
  writeFileSync(join(out, "stale.txt"), "stale");

  assert.throws(
    () => snapshotState({ dataDir: data, outDir: out, repoDir: root }),
    /exists|force/i,
  );

  const second = snapshotState({
    dataDir: data,
    outDir: out,
    repoDir: root,
    force: true,
  });
  assert.ok(existsSync(join(out, "identity.json")));
  assert.ok(!existsSync(join(out, "stale.txt")));
  assert.ok(second.createdAt >= first.createdAt);
});

test("snapshot refuses to force-replace a directory that is not a bundle", () => {
  const root = tempRoot();
  const data = makeData(root);
  const out = join(root, "not-a-bundle");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "important.txt"), "keep");

  assert.throws(
    () =>
      snapshotState({ dataDir: data, outDir: out, repoDir: root, force: true }),
    /not a snapshot|refus/i,
  );
  assert.equal(readFileSync(join(out, "important.txt"), "utf8"), "keep");
});

test("snapshot refuses output that contains the data directory", () => {
  const root = tempRoot();
  const data = makeData(root);

  assert.throws(
    () =>
      snapshotState({ dataDir: data, outDir: root, repoDir: root, force: true }),
    /overlap|outside|data directory/i,
  );
  assert.ok(existsSync(join(data, "kg.sqlite")));
});

test("restore replaces state, verifies identity, and preserves scratch files", () => {
  const root = tempRoot();
  const data = makeData(root);
  const out = join(root, "bundle");
  snapshotState({ dataDir: data, outDir: out, repoDir: root });

  const target = join(root, "restored");
  mkdirSync(join(target, "tmp"), { recursive: true });
  writeFileSync(join(target, "tmp", "keep.txt"), "keep");

  const result = restoreState({ fromDir: out, dataDir: target, repoDir: root });

  assert.equal(result.backupDir, null);
  assert.equal(readIdentity(out).journal.fingerprint, "fp-test");
  const restoredJournal = new DatabaseSync(join(target, "runs.sqlite"));
  try {
    assert.equal(
      restoredJournal
        .prepare("select value from journal_meta where key = 'build_fingerprint'")
        .get().value,
      "fp-test",
    );
  } finally {
    restoredJournal.close();
  }
  assert.equal(
    JSON.parse(readFileSync(join(target, "dataset", "manifest.json"), "utf8"))
      .generatedAt,
    "2026-11-19T00:00:00.000Z",
  );
  assert.equal(readFileSync(join(target, "tmp", "keep.txt"), "utf8"), "keep");
  assert.ok(existsSync(join(target, "cache", "abc.json")));
});

test("restore rejects a tampered bundle before touching the target", () => {
  const root = tempRoot();
  const data = makeData(root);
  const out = join(root, "bundle");
  snapshotState({ dataDir: data, outDir: out, repoDir: root });
  writeFileSync(join(out, "dataset", "reports", "453.md"), "tampered\n");

  const target = join(root, "restored");
  assert.throws(
    () => restoreState({ fromDir: out, dataDir: target, repoDir: root }),
    /dataset|hash|verify/i,
  );
  assert.ok(!existsSync(join(target, "kg.sqlite")));
});

test("restore refuses to overwrite state without force and backs it up with force", () => {
  const root = tempRoot();
  const source = makeData(join(root, "source"), { projectName: "new" });
  const out = join(root, "bundle");
  snapshotState({ dataDir: source, outDir: out, repoDir: root });

  const target = makeData(join(root, "target"), { projectName: "old" });
  mkdirSync(join(target, "tmp"), { recursive: true });
  writeFileSync(join(target, "tmp", "keep.txt"), "keep");

  assert.throws(
    () => restoreState({ fromDir: out, dataDir: target, repoDir: root }),
    /force/i,
  );

  const result = restoreState({
    fromDir: out,
    dataDir: target,
    repoDir: root,
    force: true,
  });
  assert.ok(result.backupDir);
  assert.ok(existsSync(join(result.backupDir, "kg.sqlite")));

  const restored = new DatabaseSync(join(target, "kg.sqlite"));
  try {
    assert.equal(restored.prepare("select name from project").get().name, "new");
  } finally {
    restored.close();
  }

  const backup = new DatabaseSync(join(result.backupDir, "kg.sqlite"));
  try {
    assert.equal(backup.prepare("select name from project").get().name, "old");
  } finally {
    backup.close();
  }
  assert.equal(readFileSync(join(target, "tmp", "keep.txt"), "utf8"), "keep");
});

test("restore refuses a bundle directory that contains the target data", () => {
  const root = tempRoot();
  const data = makeData(root);
  const out = join(root, "bundle");
  snapshotState({ dataDir: data, outDir: out, repoDir: root });

  // Make a valid bundle at the ancestor, so fromDir contains dataDir.
  for (const name of ["identity.json", "kg.sqlite", "runs.sqlite"]) {
    copyFileSync(join(out, name), join(root, name));
  }
  cpSync(join(out, "dataset"), join(root, "dataset"), { recursive: true });
  cpSync(join(out, "cache"), join(root, "cache"), { recursive: true });

  assert.throws(
    () =>
      restoreState({
        fromDir: root,
        dataDir: data,
        repoDir: root,
        force: true,
      }),
    /overlap|outside|contain/i,
  );
});

test("restore refuses a bundle from a different commit", () => {
  const root = tempRoot();
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  gitRepo(repoA, "a");
  gitRepo(repoB, "b");

  const data = makeData(root);
  const out = join(root, "bundle");
  snapshotState({ dataDir: data, outDir: out, repoDir: repoA });

  const target = join(root, "restored");
  assert.throws(
    () => restoreState({ fromDir: out, dataDir: target, repoDir: repoB }),
    /commit/i,
  );
});

test("default snapshot directory groups bundles by fingerprint and timestamp", () => {
  const date = new Date("2026-11-19T10:20:30.000Z");

  assert.equal(
    defaultSnapshotDir(date, "abcdef1234567890"),
    join(homedir(), "knowdit-state", "fp-abcdef123456", "2026-11-19T10-20-30-000Z"),
  );
  assert.equal(
    defaultSnapshotDir(date),
    join(homedir(), "knowdit-state", "nofp", "2026-11-19T10-20-30-000Z"),
  );
});

test("CLI rejects unknown options with usage and exit code 2", () => {
  const result = spawnSync(
    process.execPath,
    ["scripts/state-snapshot.ts", "--bogus"],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown option: --bogus/);
  assert.doesNotMatch(result.stderr, /at file:/);
});

test("CLI snapshot and restore round-trip a bundle", () => {
  const root = tempRoot();
  const data = makeData(root);
  const out = join(root, "cli-bundle");
  const repo = process.cwd();

  execFileSync(
    process.execPath,
    ["scripts/state-snapshot.ts", "--data", data, "--out", out, "--repo", root],
    { cwd: repo, encoding: "utf8" },
  );
  assert.ok(existsSync(join(out, "identity.json")));

  const target = join(root, "cli-restored");
  execFileSync(
    process.execPath,
    ["scripts/state-restore.ts", "--from", out, "--data", target, "--repo", root],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(readIdentity(out).journal.fingerprint, "fp-test");
  assert.ok(existsSync(join(target, "runs.sqlite")));
});
