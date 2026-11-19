import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NEW_ITEM_TOKEN_RATIO,
  applySemanticMerge,
  applyFindingMerge,
  mergeContest,
  splitMergeWindow,
} from "../../.opencode/plugins/knowdit/src/pipeline/merge.ts";
import { openJournal } from "../../.opencode/plugins/knowdit/src/journal.ts";
import { tempDb } from "../helpers/db.ts";
import type { KgDb } from "../../.opencode/plugins/knowdit/src/db/client.ts";
import type { StageContext } from "../../.opencode/plugins/knowdit/src/pipeline/types.ts";

async function seedProject(db: KgDb): Promise<number> {
  const projectId = db.run("insert into project (name, status) values ('p', 'running')").lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, ?)", [projectId, "c4-229"]);
  return projectId;
}

async function seededSemantic(): Promise<{
  db: KgDb;
  rawId: number;
  canonicalId: number;
  projectId: number;
}> {
  const { db } = await tempDb();
  const projectId = await seedProject(db);
  const rawId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Raw', 'raw def', 'raw desc', 'Dexes')",
  ).lastInsertRowid;
  const canonicalId = db.run(
    "insert into semantic_node (name, definition, description, category) values ('Canonical', 'def', 'old desc', 'Dexes')",
  ).lastInsertRowid;
  db.run("insert into project_semantic (project_id, semantic_node_id) values (?, ?)", [projectId, rawId]);
  return { db, rawId, canonicalId, projectId };
}

async function seededFinding(): Promise<{
  db: KgDb;
  rawId: number;
  canonicalIds: number[];
  projectId: number;
}> {
  const { db } = await tempDb();
  const projectId = await seedProject(db);
  const taxonomyId = db.get<{ id: number }>(
    "select id from finding_category where category = 'Arithmetic' and name = 'Integer Overflow'",
  )!.id;

  const insertFinding = (title: string, severity: string): number => {
    const id = db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values (?, ?, 'rc', 'desc', 'p', 'e')`,
      [title, severity],
    ).lastInsertRowid;
    db.run(
      "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
      [id, taxonomyId],
    );
    return id;
  };

  const rawId = insertFinding("Raw", "High");
  const canonicalIds = [insertFinding("Canonical A", "High"), insertFinding("Canonical B", "Medium")];
  db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [projectId, rawId]);
  return { db, rawId, canonicalIds, projectId };
}

test("semantic merge keeps identity frozen and grows canonical provenance", async () => {
  const { db, rawId, canonicalId, projectId } = await seededSemantic();
  applySemanticMerge(db, rawId, { action: "merge", targetIds: [canonicalId], updatedDescription: "new desc", appendedDescription: "note" });
  const c = db.get<{ name: string; definition: string; description: string }>("select name, definition, description from semantic_node where id = ?", [canonicalId])!;
  assert.equal(c.name, "Canonical");
  assert.equal(c.definition, "def");
  assert.equal(c.description, "new desc");
  assert.equal(db.get<{ n: number }>("select count(*) n from semantic_merge")!.n, 1);
  assert.equal(db.get<{ n: number }>("select count(*) n from project_semantic where project_id = ? and semantic_node_id = ?", [projectId, canonicalId])!.n, 1);
});

test("merge without an appended note is rejected", async () => {
  const { db, rawId, canonicalId } = await seededSemantic();
  assert.throws(() => applySemanticMerge(db, rawId, { action: "merge", targetIds: [canonicalId] }), /appended note is required/i);
});

test("finding merge refuses identity fields and accepts multi-target", async () => {
  const { db, rawId, canonicalIds, projectId } = await seededFinding();
  assert.throws(
    () => applyFindingMerge(db, rawId, { action: "merge", targetIds: [canonicalIds[0]], appendedDescription: "n", updatedDescription: "d", updatedPatterns: "p", updatedExploits: "e", title: "changed" } as never),
    /identity/i,
  );
  applyFindingMerge(db, rawId, { action: "merge", targetIds: canonicalIds, appendedDescription: "n" });
  assert.equal(db.get<{ n: number }>("select count(*) n from finding_merge")!.n, 2);
  assert.equal(db.get<{ n: number }>("select count(*) n from project_finding where project_id = ? and audit_finding_id in (?, ?)", [projectId, ...canonicalIds])!.n, 2);
});

// ── mergeContest orchestration ─────────────────────────────────────────────

type MergeKind = "semantic" | "finding";

type MergeCall = {
  kind: MergeKind;
  index: number;
  prompt: string;
  candidateIds: number[];
  incomingNames: string[];
  incomingTitles: string[];
};

async function mergeHarness(opts: {
  contextWindow?: number;
  respond: (call: MergeCall) => unknown;
}): Promise<{
  ctx: StageContext;
  db: KgDb;
  llm: { calls: number };
  prompts: string[];
  projectId: number;
}> {
  const { db } = await tempDb();
  const journal = await openJournal(
    join(mkdtempSync(join(tmpdir(), "merge-")), "runs.sqlite"),
  );
  const projectId = db.run(
    "insert into project (name, status) values ('p', 'running')",
  ).lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, 'c4-229')", [
    projectId,
  ]);

  const prompts: string[] = [];
  const llm = {
    calls: 0,
    async json<T>(input: {
      prompt: string;
      validate: (value: unknown) => T;
    }): Promise<{ value: T; tokensEst: number; costEst: number }> {
      llm.calls += 1;
      prompts.push(input.prompt);
      const kind: MergeKind = input.prompt.includes('"new_semantic_name"')
        ? "semantic"
        : "finding";
      const candidateIds = [...input.prompt.matchAll(/^ID: (\d+)$/gm)].map((match) =>
        Number(match[1]),
      );
      const heading =
        kind === "semantic"
          ? "### Newly Extracted Semantics (from the current project)"
          : "## Newly Extracted Findings";
      const incomingBlock = input.prompt.split(heading)[1]?.split("## Instructions")[0] ?? "";
      const incomingNames = [...incomingBlock.matchAll(/^Name: (.+)$/gm)].map(
        (match) => match[1],
      );
      const incomingTitles = [...incomingBlock.matchAll(/^Title: (.+)$/gm)].map(
        (match) => match[1],
      );
      const payload = opts.respond({
        kind,
        index: llm.calls,
        prompt: input.prompt,
        candidateIds,
        incomingNames,
        incomingTitles,
      });
      if (payload instanceof Error) throw payload;
      return { value: input.validate(payload), tokensEst: 0, costEst: 0 };
    },
  };

  const ctx = {
    db,
    llm,
    journal,
    datasetDir: "",
    contextWindow: opts.contextWindow,
    contest: {
      localId: 1,
      c4Id: 229,
      slug: "contest-229",
      title: "Contest 229",
      coreLoc: 1,
      sourceFiles: [],
      report: null,
      expected: { high: 0, medium: 0 },
    },
  } as unknown as StageContext;

  return { ctx, db, llm, prompts, projectId };
}

type SemanticSeed = {
  name: string;
  category?: string;
  definition?: string;
  description?: string;
  raw?: boolean;
  children?: { name: string; definition: string; description: string }[];
};

function insertSemantic(db: KgDb, projectId: number, seed: SemanticSeed): number {
  const id = db.run(
    "insert into semantic_node (name, definition, description, category) values (?, ?, ?, ?)",
    [
      seed.name,
      seed.definition ?? `${seed.name} definition`,
      seed.description ?? `${seed.name} description`,
      seed.category ?? "Dexes",
    ],
  ).lastInsertRowid;
  if (seed.raw) {
    db.run("insert into project_semantic (project_id, semantic_node_id) values (?, ?)", [
      projectId,
      id,
    ]);
  }
  for (const child of seed.children ?? []) {
    const childId = db.run(
      "insert into semantic_node (name, definition, description, category) values (?, ?, ?, ?)",
      [child.name, child.definition, child.description, seed.category ?? "Dexes"],
    ).lastInsertRowid;
    db.run(
      `insert into semantic_merge (from_semantic_id, to_semantic_id, appended_description)
       values (?, ?, 'note')`,
      [childId, id],
    );
  }
  return id;
}

type FindingSeed = {
  title: string;
  category?: string;
  subcategory?: string;
  severity?: string;
  rootCause?: string;
  description?: string;
  patterns?: string;
  exploits?: string;
  raw?: boolean;
  children?: Omit<FindingSeed, "raw">[];
};

function insertFinding(db: KgDb, projectId: number, seed: FindingSeed): number {
  const category = seed.category ?? "Arithmetic";
  const subcategory = seed.subcategory ?? "Integer Overflow";
  const taxonomy = db.get<{ id: number }>(
    "select id from finding_category where category = ? and name = ?",
    [category, subcategory],
  );
  if (!taxonomy) throw new Error(`unknown taxonomy ${category}/${subcategory}`);
  const id = db.run(
    `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
     values (?, ?, ?, ?, ?, ?)`,
    [
      seed.title,
      seed.severity ?? "High",
      seed.rootCause ?? `${seed.title} root cause`,
      seed.description ?? `${seed.title} description`,
      seed.patterns ?? "patterns",
      seed.exploits ?? "exploits",
    ],
  ).lastInsertRowid;
  db.run(
    "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
    [id, taxonomy.id],
  );
  if (seed.raw) {
    db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
      projectId,
      id,
    ]);
  }
  for (const child of seed.children ?? []) {
    const childId = insertFinding(db, projectId, { ...child, raw: false });
    db.run(
      `insert into finding_merge
         (from_finding_id, to_finding_id, appended_description, appended_patterns, appended_exploits)
       values (?, ?, 'n', 'p', 'e')`,
      [childId, id],
    );
  }
  return id;
}

const APPENDED = "adds one concrete sub-step beyond the canonical write-up";

function mergeEveryIncoming(call: MergeCall): unknown {
  if (call.kind === "semantic") {
    return {
      decisions: call.incomingNames.map((name) => ({
        reason: "fake semantic merge",
        new_semantic_name: name,
        merge_target_ids: [call.candidateIds[0]],
        appended_description: APPENDED,
      })),
    };
  }
  return {
    decisions: call.incomingTitles.map((title) => ({
      reason: "fake finding merge",
      new_finding_title: title,
      merge_target_ids: [call.candidateIds[0]],
      appended_description: APPENDED,
      appended_patterns: APPENDED,
      appended_exploits: APPENDED,
    })),
  };
}

test("merge window split reserves 80% of the usable window for new items", () => {
  assert.deepEqual(splitMergeWindow(100_000, 0.8), {
    newItemBudget: 80_000,
    candidateBudget: 20_000,
  });
  assert.deepEqual(splitMergeWindow(100_000, 0.5), {
    newItemBudget: 50_000,
    candidateBudget: 50_000,
  });
  const tiny = splitMergeWindow(3_000, 0.8);
  assert.ok(tiny.newItemBudget >= 2048);
  assert.ok(tiny.candidateBudget >= 2048);
});

test("merge window split reserves 85% of the usable window by default", () => {
  assert.equal(NEW_ITEM_TOKEN_RATIO, 0.85);
  assert.deepEqual(splitMergeWindow(100_000, NEW_ITEM_TOKEN_RATIO), {
    newItemBudget: 85_000,
    candidateBudget: 15_000,
  });
});

test("applies merge writes in raw extraction order", async () => {
  const h = await mergeHarness({
    respond: (call) => ({
      decisions: [...call.incomingNames].reverse().map((name) => ({
        reason: "reverse-order decision",
        new_semantic_name: name,
        merge_target_ids: [call.candidateIds[0]],
        updated_description: `${name} updated`,
        appended_description: APPENDED,
      })),
    }),
  });
  insertSemantic(h.db, h.projectId, {
    name: "Canonical",
    description: "short canonical description",
  });
  insertSemantic(h.db, h.projectId, { name: "Raw A", raw: true });
  insertSemantic(h.db, h.projectId, { name: "Raw B", raw: true });

  await mergeContest(h.ctx);

  const canonical = h.db.get<{ description: string }>(
    "select description from semantic_node where name = 'Canonical'",
  )!;
  assert.equal(canonical.description, "Raw B updated");
});

test("persists semantic and finding merges in one transaction", async () => {
  const h = await mergeHarness({ respond: mergeEveryIncoming });
  insertSemantic(h.db, h.projectId, { name: "Canonical semantic" });
  insertSemantic(h.db, h.projectId, { name: "Raw semantic", raw: true });
  insertFinding(h.db, h.projectId, { title: "Canonical finding" });
  insertFinding(h.db, h.projectId, { title: "Raw finding", raw: true });

  const originalTx = h.ctx.db.tx.bind(h.ctx.db);
  let txCalls = 0;
  h.ctx.db.tx = <T>(fn: () => T): T => {
    txCalls += 1;
    return originalTx(fn);
  };

  const result = await mergeContest(h.ctx);

  assert.equal(result.semanticEdges, 1);
  assert.equal(result.findingEdges, 1);
  assert.equal(txCalls, 1);
});

test("merge only offers canonicals from the incoming categories", async () => {
  const h = await mergeHarness({ respond: mergeEveryIncoming });
  const dexesCanonical = insertSemantic(h.db, h.projectId, {
    name: "Dexes canonical",
    category: "Dexes",
  });
  insertSemantic(h.db, h.projectId, { name: "Lending canonical", category: "Lending" });
  insertSemantic(h.db, h.projectId, { name: "Raw dexes", category: "Dexes", raw: true });

  const arithmeticCanonical = insertFinding(h.db, h.projectId, {
    title: "Arithmetic canonical",
    category: "Arithmetic",
  });
  insertFinding(h.db, h.projectId, {
    title: "Access canonical",
    category: "Access Control",
    subcategory: "Caller Not Checked",
  });
  insertFinding(h.db, h.projectId, { title: "Raw arithmetic", raw: true });

  const result = await mergeContest(h.ctx);

  const semanticPrompt = h.prompts.find((p) => p.includes('"new_semantic_name"'))!;
  assert.match(semanticPrompt, /Dexes canonical/);
  assert.doesNotMatch(semanticPrompt, /Lending canonical/);
  const findingPrompt = h.prompts.find((p) => p.includes('"new_finding_title"'))!;
  assert.match(findingPrompt, /Arithmetic canonical/);
  assert.doesNotMatch(findingPrompt, /Access canonical/);

  assert.deepEqual(
    h.db
      .all<{ to_semantic_id: number }>("select to_semantic_id from semantic_merge")
      .map((row) => row.to_semantic_id),
    [dexesCanonical],
  );
  assert.deepEqual(
    h.db
      .all<{ to_finding_id: number }>("select to_finding_id from finding_merge")
      .map((row) => row.to_finding_id),
    [arithmeticCanonical],
  );
  assert.equal(result.semanticEdges, 1);
  assert.equal(result.findingEdges, 1);
});

test("chunks canonical candidates and unions merge targets across chunks", async () => {
  const h = await mergeHarness({
    contextWindow: 30_000,
    respond: (call) =>
      call.kind === "semantic"
        ? {
            decisions: call.incomingNames.map((name) => ({
              reason: "chunk merge",
              new_semantic_name: name,
              merge_target_ids: call.candidateIds.slice(0, 1),
              appended_description: APPENDED,
            })),
          }
        : { decisions: [] },
  });
  for (let index = 0; index < 30; index++) {
    insertSemantic(h.db, h.projectId, {
      name: `Canonical ${index}`,
      description: `concrete description ${index} `.repeat(60),
    });
  }
  const rawId = insertSemantic(h.db, h.projectId, { name: "Raw", raw: true });

  const result = await mergeContest(h.ctx);

  const semanticPrompts = h.prompts.filter((p) => p.includes('"new_semantic_name"'));
  assert.ok(semanticPrompts.length > 1, `expected chunks, got ${semanticPrompts.length}`);
  const seen = new Set<number>();
  for (const prompt of semanticPrompts) {
    const ids = [...prompt.matchAll(/^ID: (\d+)$/gm)].map((match) => Number(match[1]));
    assert.ok(ids.length < 30, "a prompt still carries every canonical");
    for (const id of ids) seen.add(id);
  }
  assert.equal(seen.size, 30);
  const chunkFirstIds = semanticPrompts
    .map((prompt) => Number([...prompt.matchAll(/^ID: (\d+)$/gm)][0][1]))
    .sort((lhs, rhs) => lhs - rhs);
  assert.deepEqual(
    h.db
      .all<{ to_semantic_id: number }>(
        "select to_semantic_id from semantic_merge where from_semantic_id = ?",
        [rawId],
      )
      .map((row) => row.to_semantic_id)
      .sort((lhs, rhs) => lhs - rhs),
    chunkFirstIds,
  );
  assert.equal(result.semanticEdges, semanticPrompts.length);
});

test("batches incoming items at the reference count cap", async () => {
  const h = await mergeHarness({ contextWindow: 200_000, respond: mergeEveryIncoming });
  insertSemantic(h.db, h.projectId, { name: "Canonical" });
  for (let index = 0; index < 41; index++) {
    insertSemantic(h.db, h.projectId, { name: `Raw ${index}`, raw: true });
  }

  const result = await mergeContest(h.ctx);

  const semanticPrompts = h.prompts.filter((p) => p.includes('"new_semantic_name"'));
  assert.equal(semanticPrompts.length, 2);
  const counts = semanticPrompts
    .map((prompt) => {
      const block = prompt
        .split("### Newly Extracted Semantics (from the current project)")[1]
        .split("## Instructions")[0];
      return [...block.matchAll(/^Name: /gm)].length;
    })
    .sort((lhs, rhs) => lhs - rhs);
  assert.deepEqual(counts, [1, 40]);
  assert.equal(h.db.get<{ n: number }>("select count(*) n from semantic_merge")!.n, 41);
  assert.equal(result.semanticEdges, 41);
});

test("an omitted merge decision means New instead of failing the chunk", async () => {
  const h = await mergeHarness({
    respond: (call) =>
      call.kind === "semantic"
        ? {
            decisions: [
              {
                reason: "only one decision",
                new_semantic_name: call.incomingNames[0],
                merge_target_ids: [call.candidateIds[0]],
                appended_description: APPENDED,
              },
            ],
          }
        : { decisions: [] },
  });
  insertSemantic(h.db, h.projectId, { name: "Canonical" });
  insertSemantic(h.db, h.projectId, { name: "Raw A", raw: true });
  insertSemantic(h.db, h.projectId, { name: "Raw B", raw: true });

  const result = await mergeContest(h.ctx);

  assert.equal(result.semanticEdges, 1);
  assert.equal(h.db.get<{ n: number }>("select count(*) n from semantic_merge")!.n, 1);
});

test("rejects a merge target that is not in the candidate chunk", async () => {
  const h = await mergeHarness({
    respond: (call) => ({
      decisions: [
        {
          reason: "outside chunk",
          new_semantic_name: call.incomingNames[0],
          merge_target_ids: [call.candidateIds[0] + 1000],
          appended_description: APPENDED,
        },
      ],
    }),
  });
  insertSemantic(h.db, h.projectId, { name: "Canonical" });
  insertSemantic(h.db, h.projectId, { name: "Raw", raw: true });

  await assert.rejects(() => mergeContest(h.ctx), /not in this chunk|candidate list/i);
  assert.equal(h.db.get<{ n: number }>("select count(*) n from semantic_merge")!.n, 0);
});

test("rejects an updated description over the reference length cap", async () => {
  const h = await mergeHarness({
    respond: (call) => ({
      decisions: [
        {
          reason: "too long",
          new_semantic_name: call.incomingNames[0],
          merge_target_ids: [call.candidateIds[0]],
          updated_description: "x".repeat(2001),
          appended_description: APPENDED,
        },
      ],
    }),
  });
  insertSemantic(h.db, h.projectId, { name: "Canonical" });
  insertSemantic(h.db, h.projectId, { name: "Raw", raw: true });

  await assert.rejects(() => mergeContest(h.ctx), /2000/);
});

test("rejects an updated description that abstracts a concrete canonical", async () => {
  const h = await mergeHarness({
    respond: (call) => ({
      decisions: [
        {
          reason: "abstract",
          new_semantic_name: call.incomingNames[0],
          merge_target_ids: [call.candidateIds[0]],
          updated_description: "improper access control",
          appended_description: APPENDED,
        },
      ],
    }),
  });
  insertSemantic(h.db, h.projectId, {
    name: "Canonical",
    description: "d".repeat(200),
  });
  insertSemantic(h.db, h.projectId, { name: "Raw", raw: true });

  await assert.rejects(() => mergeContest(h.ctx), /generalization|shorter|concrete/i);
});

test("accepts an updated description at the shrink boundary", async () => {
  const h = await mergeHarness({
    respond: (call) => ({
      decisions: [
        {
          reason: "boundary",
          new_semantic_name: call.incomingNames[0],
          merge_target_ids: [call.candidateIds[0]],
          updated_description: "x".repeat(120),
          appended_description: APPENDED,
        },
      ],
    }),
  });
  insertSemantic(h.db, h.projectId, {
    name: "Canonical",
    description: "d".repeat(200),
  });
  insertSemantic(h.db, h.projectId, { name: "Raw", raw: true });

  const result = await mergeContest(h.ctx);
  assert.equal(result.semanticEdges, 1);
});

test("rejects a semantic merge without an appended note", async () => {
  const h = await mergeHarness({
    respond: (call) => ({
      decisions: [
        {
          reason: "missing note",
          new_semantic_name: call.incomingNames[0],
          merge_target_ids: [call.candidateIds[0]],
        },
      ],
    }),
  });
  insertSemantic(h.db, h.projectId, { name: "Canonical" });
  insertSemantic(h.db, h.projectId, { name: "Raw", raw: true });

  await assert.rejects(() => mergeContest(h.ctx), /appended_description/);
});

test("rejects an appended note over the reference length cap", async () => {
  const h = await mergeHarness({
    respond: (call) => ({
      decisions: [
        {
          reason: "note too long",
          new_semantic_name: call.incomingNames[0],
          merge_target_ids: [call.candidateIds[0]],
          appended_description: "n".repeat(601),
        },
      ],
    }),
  });
  insertSemantic(h.db, h.projectId, { name: "Canonical" });
  insertSemantic(h.db, h.projectId, { name: "Raw", raw: true });

  await assert.rejects(() => mergeContest(h.ctx), /600/);
});

test("finding merges require all three appended notes", async () => {
  const h = await mergeHarness({
    respond: (call) => ({
      decisions: [
        {
          reason: "missing patterns note",
          new_finding_title: call.incomingTitles[0],
          merge_target_ids: [call.candidateIds[0]],
          appended_description: APPENDED,
          appended_exploits: APPENDED,
        },
      ],
    }),
  });
  insertFinding(h.db, h.projectId, { title: "Canonical" });
  insertFinding(h.db, h.projectId, { title: "Raw", raw: true });

  await assert.rejects(() => mergeContest(h.ctx), /appended_patterns/);
});

test("renders merged raw children beside canonical merge candidates", async () => {
  const h = await mergeHarness({ respond: () => ({ decisions: [] }) });
  insertSemantic(h.db, h.projectId, {
    name: "Canonical semantic",
    children: [
      {
        name: "Folded semantic child",
        definition: "child definition",
        description: "SEM-CHILD-SENTINEL",
      },
    ],
  });
  insertSemantic(h.db, h.projectId, { name: "Raw semantic", raw: true });
  insertFinding(h.db, h.projectId, {
    title: "Canonical finding",
    children: [
      {
        title: "Folded finding child",
        rootCause: "child root cause",
        description: "FIND-CHILD-SENTINEL",
        patterns: "child patterns",
        exploits: "child exploits",
      },
    ],
  });
  insertFinding(h.db, h.projectId, { title: "Raw finding", raw: true });

  await mergeContest(h.ctx);

  const semanticPrompt = h.prompts.find((p) => p.includes('"new_semantic_name"'))!;
  assert.match(semanticPrompt, /Merged from \(historical raws/);
  assert.match(semanticPrompt, /SEM-CHILD-SENTINEL/);
  const findingPrompt = h.prompts.find((p) => p.includes('"new_finding_title"'))!;
  assert.match(findingPrompt, /Merged from \(historical raws/);
  assert.match(findingPrompt, /FIND-CHILD-SENTINEL/);
});

test("admits every incoming item as New when no canonical candidate exists", async () => {
  const h = await mergeHarness({
    respond: () => {
      throw new Error("merge must not call the model without candidates");
    },
  });
  insertSemantic(h.db, h.projectId, { name: "Raw semantic", raw: true });
  insertFinding(h.db, h.projectId, { title: "Raw finding", raw: true });

  const result = await mergeContest(h.ctx);

  assert.equal(h.llm.calls, 0);
  assert.equal(result.semanticEdges, 0);
  assert.equal(result.findingEdges, 0);
  assert.equal(h.db.get<{ n: number }>("select count(*) n from semantic_merge")!.n, 0);
  assert.equal(h.db.get<{ n: number }>("select count(*) n from finding_merge")!.n, 0);
});
