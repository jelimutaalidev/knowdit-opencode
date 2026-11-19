import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDb } from "../helpers/db.ts";
import { openJournal } from "../../.opencode/plugins/knowdit/src/journal.ts";
import { readStats } from "../../.opencode/plugins/knowdit/src/stats.ts";
import { registerKnowditTools } from "../../.opencode/plugins/knowdit/src/register.ts";
import {
  buildHandlers,
  createProgressReporter,
} from "../../.opencode/plugins/knowdit/src/tools/handlers.ts";
import type { KgDb } from "../../.opencode/plugins/knowdit/src/db/client.ts";

async function seededStats(): Promise<{ db: KgDb }> {
  const { db } = await tempDb();

  const projectId = db.run(
    "insert into project (name, status) values ('p', 'completed')",
  ).lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, 'c4-229')", [
    projectId,
  ]);

  const canonicalId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Canonical', 'd', 'x', 'Dexes')",
  ).lastInsertRowid;
  const rawId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Raw', 'd', 'x', 'Dexes')",
  ).lastInsertRowid;
  db.run("insert into project_semantic (project_id, semantic_node_id) values (?, ?)", [
    projectId,
    canonicalId,
  ]);
  db.run("insert into project_semantic (project_id, semantic_node_id) values (?, ?)", [
    projectId,
    rawId,
  ]);
  db.run(
    "insert into semantic_merge (from_semantic_id, to_semantic_id, appended_description) values (?, ?, 'note')",
    [rawId, canonicalId],
  );

  const taxonomyId = db.get<{ id: number }>(
    "select id from finding_category where category = 'Arithmetic' and name = 'Integer Overflow'",
  )!.id;

  const insertFinding = (title: string): number => {
    const id = db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values (?, 'High', 'rc', 'desc', 'p', 'e')`,
      [title],
    ).lastInsertRowid;
    db.run(
      "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
      [id, taxonomyId],
    );
    db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
      projectId,
      id,
    ]);
    return id;
  };

  const firstFinding = insertFinding("First");
  const secondFinding = insertFinding("Second");

  db.run(
    `insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence)
     values (?, ?, 'High', 'in-project link: fake')`,
    [canonicalId, firstFinding],
  );
  db.run(
    `insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence)
     values (?, ?, 'Medium', 'cross-project evidence')`,
    [canonicalId, secondFinding],
  );
  db.run("insert into pending_semantic (semantic_node_id) values (?)", [canonicalId]);

  return { db };
}

test("stats split in-project from cross links by evidence prefix", async () => {
  const { db } = await seededStats();
  const s = readStats(db);
  assert.equal(s.linksTotal, 2);
  assert.equal(s.linksInProject, 1);
  assert.equal(s.linksCross, 1);
  assert.equal(s.semanticsCanonical, 1);
  assert.equal(s.pendingSemantics, 1);
});

test("progress reporter writes JSONL and forwards updates to the tool UI", async () => {
  const dir = mkdtempSync(join(tmpdir(), "progress-"));
  const logPath = join(dir, "progress.log");
  const seen: Record<string, unknown>[] = [];
  const report = createProgressReporter({
    logPath,
    sink: (update) => {
      seen.push(update);
    },
  });

  await report({ stage: "semantics", detail: "extracting", contest: 453 });

  const line = JSON.parse(readFileSync(logPath, "utf8").trim()) as Record<string, unknown>;
  assert.equal(line.stage, "semantics");
  assert.equal(line.contest, 453);
  assert.equal(line.source, "knowdit");
  assert.equal(typeof line.at, "string");
  assert.deepEqual(seen, [
    { source: "knowdit", stage: "semantics", detail: "extracting", contest: 453 },
  ]);
});

async function statusFixture(opts: {
  currentFingerprint: string;
  bundleFingerprint: string;
  createdAt?: string;
}): Promise<{ data: string; stateRoot: string; bundle: string }> {
  const root = mkdtempSync(join(tmpdir(), "status-"));
  const data = join(root, "data");
  mkdirSync(join(data, "dataset"), { recursive: true });
  writeFileSync(
    join(data, "dataset", "manifest.json"),
    JSON.stringify({
      generatedAt: "2026-11-19T00:00:00.000Z",
      contests: [{ c4Id: 331, expected: { high: 1, medium: 4 } }],
      excluded: [],
    }),
  );

  const journal = await openJournal(join(data, "runs.sqlite"));
  journal.ensureFingerprint(opts.currentFingerprint);
  journal.done({ stage: "categorize", c4Id: 331, unitIndex: 0 });
  journal.close();

  const stateRoot = join(root, "knowdit-state");
  const bundle = join(stateRoot, "fp-test", "stamp");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(
    join(bundle, "identity.json"),
    JSON.stringify({
      snapshotVersion: 1,
      createdAt: opts.createdAt ?? "2026-11-19T00:00:00.000Z",
      commit: "abc123",
      pipelineVersion: "2026-11-19.p0p1.4",
      journal: {
        fingerprint: opts.bundleFingerprint,
        units: { total: 1, done: 1, failed: 0, running: 0 },
      },
    }),
  );

  return { data, stateRoot, bundle };
}

function statusHandlers(data: string, stateRoot: string) {
  return buildHandlers({
    dataDir: data,
    stateRoot,
    generate: async () => ({ text: "{}" }),
  });
}

test("kg_status reports the latest snapshot and a matching journal fingerprint", async () => {
  const fixture = await statusFixture({
    currentFingerprint: "fp-current",
    bundleFingerprint: "fp-current",
  });

  const result = await statusHandlers(fixture.data, fixture.stateRoot).kg_status({});
  const content = JSON.parse(result.content) as {
    journal: { fingerprint: string | null };
    snapshot: {
      found: boolean;
      root: string;
      latest: { path: string } | null;
      matchesJournal: boolean | null;
    };
  };

  assert.equal(content.journal.fingerprint, "fp-current");
  assert.equal(content.snapshot.found, true);
  assert.equal(content.snapshot.root, fixture.stateRoot);
  assert.equal(content.snapshot.latest?.path, fixture.bundle);
  assert.equal(content.snapshot.matchesJournal, true);
});

test("kg_status marks a snapshot from another build as a mismatch", async () => {
  const fixture = await statusFixture({
    currentFingerprint: "fp-current",
    bundleFingerprint: "fp-old",
  });

  const result = await statusHandlers(fixture.data, fixture.stateRoot).kg_status({});
  const content = JSON.parse(result.content) as {
    snapshot: { found: boolean; matchesJournal: boolean | null };
  };

  assert.equal(content.snapshot.found, true);
  assert.equal(content.snapshot.matchesJournal, false);
});

test("kg_status scans KNOWDIT_STATE_ROOT when no stateRoot is passed", async () => {
  const fixture = await statusFixture({
    currentFingerprint: "fp-current",
    bundleFingerprint: "fp-current",
  });
  const previous = process.env.KNOWDIT_STATE_ROOT;
  process.env.KNOWDIT_STATE_ROOT = fixture.stateRoot;
  try {
    const handlers = buildHandlers({
      dataDir: fixture.data,
      generate: async () => ({ text: "{}" }),
    });
    const result = await handlers.kg_status({});
    const content = JSON.parse(result.content) as {
      snapshot: { found: boolean; root: string };
    };

    assert.equal(content.snapshot.root, fixture.stateRoot);
    assert.equal(content.snapshot.found, true);
  } finally {
    if (previous === undefined) delete process.env.KNOWDIT_STATE_ROOT;
    else process.env.KNOWDIT_STATE_ROOT = previous;
  }
});

test("registers all five tools in the knowdit namespace", () => {
  const tools: string[] = [];
  registerKnowditTools(
    { namespace: () => {}, add: (t) => tools.push(t.name) },
    {
      dataset_prepare: async () => ({ content: "" }),
      kg_build: async () => ({ content: "" }),
      kg_status: async () => ({ content: "" }),
      kg_query: async () => ({ content: "" }),
      kg_stats: async () => ({ content: "" }),
    },
  );
  assert.deepEqual(tools.sort(), [
    "dataset_prepare",
    "kg_build",
    "kg_query",
    "kg_stats",
    "kg_status",
  ]);
});
