import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HIGH_QUOTE_MIN_CHARS,
  MIN_HIGH_MEDIUM_BYTES,
  MIN_LOW_BYTES,
  linkGlobal,
  normalizeForQuoteMatch,
} from "../../.opencode/plugins/knowdit/src/pipeline/link-global.ts";
import { inProjectEvidence } from "../../.opencode/plugins/knowdit/src/pipeline/evidence.ts";
import { openJournal } from "../../.opencode/plugins/knowdit/src/journal.ts";
import { tempDb } from "../helpers/db.ts";

type LinkSpec = { semanticIndex: number; strength: "High" | "Medium" | "Low"; evidence: string };

async function seededGlobalCtx(
  links: LinkSpec[],
  opts: { retryLinks?: LinkSpec[]; pending?: boolean; failFirstCall?: boolean } = {},
): Promise<{
  ctx: {
    db: Awaited<ReturnType<typeof tempDb>>["db"];
    llm: { calls: number; json: (input: { prompt: string; validate: (value: unknown) => unknown }) => Promise<{ value: unknown; tokensEst: number; costEst: number }> };
    journal: Awaited<ReturnType<typeof openJournal>>;
  };
  llm: { calls: number };
  db: Awaited<ReturnType<typeof tempDb>>["db"];
}> {
  const { db } = await tempDb();
  const journal = await openJournal(join(mkdtempSync(join(tmpdir(), "link-global-")), "runs.sqlite"));

  const projectId = db.run(
    "insert into project (name, status) values ('p', 'running')",
  ).lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, 'c4-229')", [
    projectId,
  ]);

  const taxonomy = db.get<{ id: number }>(
    "select id from finding_category where category = 'Arithmetic' and name = 'Integer Overflow'",
  )!;
  const findingId = db.run(
    `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
     values ('Pool drain', 'High', 'shares are minted twice in a loop',
             'the pool drains because shares are minted twice in a loop when users withdraw',
             'p', 'e')`,
  ).lastInsertRowid;
  db.run(
    "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
    [findingId, taxonomy.id],
  );
  db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
    projectId,
    findingId,
  ]);

  const maxIndex = Math.max(
    ...[...links, ...(opts.retryLinks ?? [])].map((link) => link.semanticIndex),
    0,
  );
  const semanticIds: number[] = [];
  for (let index = 0; index <= maxIndex; index += 1) {
    semanticIds.push(
      db.run(
        "insert into semantic_node (name, definition, description, category) values (?, 'def', 'desc', 'Dexes')",
        [`Semantic ${index}`],
      ).lastInsertRowid,
    );
  }

  if (opts.pending) {
    db.run("insert into pending_semantic (semantic_node_id) values (?)", [semanticIds[0]]);
  }

  const llm = {
    calls: 0,
    async json(input: { prompt: string; validate: (value: unknown) => unknown }) {
      llm.calls += 1;
      if (opts.failFirstCall && llm.calls === 1) {
        throw new Error("Free usage limit reached. Free models work in OpenCode on a schedule.");
      }
      const spec = llm.calls === 1 || opts.retryLinks === undefined ? links : opts.retryLinks;
      const payload = {
        links: [
          {
            finding_id: `F-${findingId}`,
            reasoning: "fake global link",
            semantic_evidence: spec.map((link) => ({
              semantic_id: semanticIds[link.semanticIndex],
              strength: link.strength,
              why_finding_can_fire: link.evidence,
            })),
          },
        ],
      };
      return { value: input.validate(payload), tokensEst: 0, costEst: 0 };
    },
  };

  return {
    ctx: { db, llm, journal },
    llm,
    db,
  };
}

const medium = (label: string): string =>
  `${label}: the finding shares the pool accounting prerequisite this semantic describes.`;

const QUOTE = "shares are minted twice in a loop";

// ── multi-finding/multi-candidate harness ──────────────────────────────────

type GraphFinding = {
  title: string;
  severity?: string;
  rootCause?: string;
  description?: string;
  patterns?: string;
  exploits?: string;
  children?: { title: string; rootCause: string; description: string }[];
};

type GraphSemantic = {
  name: string;
  category?: string;
  definition?: string;
  description?: string;
  children?: { name: string; definition: string; description: string }[];
};

async function seededGraph(opts: {
  findings: GraphFinding[];
  semantics: GraphSemantic[];
  contextWindow?: number;
  respond: (call: {
    index: number;
    prompt: string;
    findingIds: string[];
    candidateIds: number[];
  }) => unknown;
}): Promise<{
  ctx: Parameters<typeof linkGlobal>[0];
  llm: { calls: number };
  db: Awaited<ReturnType<typeof tempDb>>["db"];
  prompts: string[];
}> {
  const { db } = await tempDb();
  const journal = await openJournal(join(mkdtempSync(join(tmpdir(), "link-graph-")), "runs.sqlite"));
  const projectId = db.run("insert into project (name, status) values ('p', 'running')").lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, 'c4-229')", [projectId]);

  const taxonomy = db.get<{ id: number }>(
    "select id from finding_category where category = 'Arithmetic' and name = 'Integer Overflow'",
  )!;

  for (const finding of opts.findings) {
    const findingId = db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values (?, ?, ?, ?, ?, ?)`,
      [
        finding.title,
        finding.severity ?? "High",
        finding.rootCause ?? "rc",
        finding.description ?? "desc",
        finding.patterns ?? "p",
        finding.exploits ?? "e",
      ],
    ).lastInsertRowid;
    db.run(
      "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
      [findingId, taxonomy.id],
    );
    db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
      projectId,
      findingId,
    ]);

    for (const child of finding.children ?? []) {
      const childId = db.run(
        `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
         values (?, ?, ?, ?, ?, ?)`,
        [
          child.title,
          finding.severity ?? "High",
          child.rootCause,
          child.description,
          "child patterns",
          "child exploits",
        ],
      ).lastInsertRowid;
      db.run(
        "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
        [childId, taxonomy.id],
      );
      db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
        projectId,
        childId,
      ]);
      db.run(
        `insert into finding_merge
           (from_finding_id, to_finding_id, appended_description, appended_patterns, appended_exploits)
         values (?, ?, 'child note', 'child note', 'child note')`,
        [childId, findingId],
      );
    }
  }

  for (const semantic of opts.semantics) {
    const semanticId = db.run(
      "insert into semantic_node (name, definition, description, category) values (?, ?, ?, ?)",
      [
        semantic.name,
        semantic.definition ?? "definition",
        semantic.description ?? "description",
        semantic.category ?? "Dexes",
      ],
    ).lastInsertRowid;
    for (const child of semantic.children ?? []) {
      const childId = db.run(
        "insert into semantic_node (name, definition, description, category) values (?, ?, ?, ?)",
        [child.name, child.definition, child.description, semantic.category ?? "Dexes"],
      ).lastInsertRowid;
      db.run(
        `insert into semantic_merge (from_semantic_id, to_semantic_id, appended_description)
         values (?, ?, 'child note')`,
        [childId, semanticId],
      );
    }
  }

  const prompts: string[] = [];
  const llm = {
    calls: 0,
    async json(input: { prompt: string; validate: (value: unknown) => unknown }) {
      llm.calls += 1;
      prompts.push(input.prompt);
      const findingIds = [...input.prompt.matchAll(/^### (F-\d+)$/gm)].map((m) => m[1]);
      const candidateIds = [...input.prompt.matchAll(/^Candidate ID: (\d+)$/gm)].map((m) =>
        Number(m[1]),
      );
      const payload = opts.respond({
        index: llm.calls,
        prompt: input.prompt,
        findingIds,
        candidateIds,
      });
      if (payload instanceof Error) throw payload;
      return { value: input.validate(payload), tokensEst: 0, costEst: 0 };
    },
  };

  return {
    ctx: {
      db,
      llm,
      journal,
      c4Ids: [229],
      contextWindow: opts.contextWindow,
    },
    llm,
    db,
    prompts,
  };
}

function linksFor(
  findingIds: readonly string[],
  candidateIds: readonly number[],
  evidence: (findingId: string, semanticId: number) => string,
): unknown {
  return {
    links: findingIds.map((findingId) => ({
      finding_id: findingId,
      reasoning: "graph harness decision",
      semantic_evidence:
        candidateIds.length === 0
          ? []
          : [
              {
                semantic_id: candidateIds[0],
                strength: "Medium",
                why_finding_can_fire: evidence(findingId, candidateIds[0]),
              },
            ],
    })),
  };
}

test("batches pending findings into one prompt", async () => {
  const { ctx, llm, db, prompts } = await seededGraph({
    findings: [
      { title: "A", description: "finding a" },
      { title: "B", description: "finding b" },
      { title: "C", description: "finding c" },
    ],
    semantics: [{ name: "Only semantic" }],
    contextWindow: 20_000,
    respond: ({ findingIds, candidateIds }) =>
      linksFor(findingIds, candidateIds, medium),
  });

  await linkGlobal(ctx);

  assert.equal(llm.calls, 1);
  for (const id of ["F-1", "F-2", "F-3"]) assert.match(prompts[0], new RegExp(`### ${id}`));
  assert.equal(
    db.get<{ n: number }>("select count(*) n from finding_link_status")!.n,
    3,
  );
});

test("renders the union of DeFi categories from every owning project", async () => {
  const { ctx, db, prompts } = await seededGraph({
    findings: [{ title: "Shared finding" }],
    semantics: [{ name: "Only semantic" }],
    contextWindow: 20_000,
    respond: ({ findingIds, candidateIds }) =>
      linksFor(findingIds, candidateIds, medium),
  });
  const findingId = db.get<{ id: number }>(
    "select id from audit_finding where title = 'Shared finding'",
  )!.id;
  const firstProject = db.get<{ id: number }>("select id from project limit 1")!.id;
  const secondProject = db.run(
    "insert into project (name, status) values ('q', 'running')",
  ).lastInsertRowid;
  db.run("insert into project_platform (project_id, platform_id) values (?, 'c4-300')", [
    secondProject,
  ]);
  db.run("insert into project_finding (project_id, audit_finding_id) values (?, ?)", [
    secondProject,
    findingId,
  ]);
  for (const [projectId, names] of [
    [firstProject, ["Dexes"]],
    [secondProject, ["Lending", "Dexes"]],
  ] as const) {
    for (const name of names) {
      db.run(
        `insert into project_category (project_id, category_id)
         select ?, id from category where name = ?`,
        [projectId, name],
      );
    }
  }

  await linkGlobal(ctx);

  assert.match(prompts[0], /Project DeFi Categories: Dexes, Lending/);
});

test("orders candidate semantics by category, name, then id", async () => {
  const { ctx, prompts } = await seededGraph({
    findings: [{ title: "Shared finding" }],
    semantics: [
      { name: "Alpha", category: "Lending" },
      { name: "Zed", category: "Dexes" },
      { name: "Zulu", category: "Lending" },
    ],
    contextWindow: 20_000,
    respond: ({ findingIds, candidateIds }) =>
      linksFor(findingIds, candidateIds, medium),
  });

  await linkGlobal(ctx);

  const prompt = prompts[0];
  const zed = prompt.indexOf("Name: Zed");
  const alpha = prompt.indexOf("Name: Alpha");
  const zulu = prompt.indexOf("Name: Zulu");
  assert.ok(zed >= 0 && alpha >= 0 && zulu >= 0, "all candidates are rendered");
  assert.ok(zed < alpha && alpha < zulu, "candidates follow category, name, then id");
});

test("retries omitted findings with a prompt restricted to them", async () => {
  let firstIds: string[] = [];
  const { ctx, llm, db, prompts } = await seededGraph({
    findings: [
      { title: "A", description: "finding a" },
      { title: "B", description: "finding b" },
    ],
    semantics: [{ name: "Only semantic" }],
    contextWindow: 20_000,
    respond: ({ index, findingIds, candidateIds }) => {
      if (index === 1) {
        firstIds = findingIds;
        return linksFor(findingIds.slice(0, 1), candidateIds, medium);
      }
      return linksFor(findingIds, candidateIds, medium);
    },
  });

  const result = await linkGlobal(ctx);

  assert.equal(llm.calls, 2);
  assert.equal(firstIds.length, 2);
  const retried = [...prompts[1].matchAll(/^### (F-\d+)$/gm)].map((match) => match[1]);
  assert.deepEqual(retried, [firstIds[1]]);
  assert.ok(!prompts[1].includes(`### ${firstIds[0]}`));
  assert.equal(result.linked, 2);
  assert.equal(
    db.get<{ n: number }>("select count(*) n from finding_link_status")!.n,
    2,
  );
});

test("treats findings omitted after every attempt as no-link results", async () => {
  let omittedId = 0;
  const { ctx, llm, db } = await seededGraph({
    findings: [
      { title: "A", description: "finding a" },
      { title: "B", description: "finding b" },
    ],
    semantics: [{ name: "Only semantic" }],
    contextWindow: 20_000,
    respond: ({ findingIds, candidateIds }) => {
      if (findingIds.length > 1) {
        omittedId = Number(findingIds[1].slice(2));
        return linksFor(findingIds.slice(0, 1), candidateIds, medium);
      }
      return { links: [] };
    },
  });

  const result = await linkGlobal(ctx);

  assert.equal(llm.calls, 3);
  assert.equal(result.linked, 2);
  assert.equal(
    db.get<{ n: number }>("select count(*) n from finding_link_status")!.n,
    2,
  );
  assert.equal(
    db.get<{ n: number }>(
      "select count(*) n from semantic_finding_link where audit_finding_id = ?",
      [omittedId],
    )!.n,
    0,
  );
});

test("chunks the candidate set so no prompt carries every canonical", async () => {
  const semantics = Array.from({ length: 40 }, (_, index) => ({
    name: `Semantic ${index}`,
    description: `description ${index} `.repeat(20),
  }));
  const { ctx, llm, db, prompts } = await seededGraph({
    findings: [{ title: "A" }],
    semantics,
    contextWindow: 30_000,
    respond: ({ findingIds, candidateIds }) =>
      linksFor(findingIds, candidateIds, medium),
  });

  await linkGlobal(ctx);

  assert.ok(llm.calls > 1, `expected multiple candidate chunks, got ${llm.calls}`);
  const seen = new Set<number>();
  for (const prompt of prompts) {
    const ids = [...prompt.matchAll(/^Candidate ID: (\d+)$/gm)].map((m) => Number(m[1]));
    assert.ok(ids.length < 40, "a prompt still contains the whole candidate set");
    for (const id of ids) seen.add(id);
  }
  assert.equal(seen.size, 40);
  assert.equal(
    db.get<{ n: number }>("select count(*) n from finding_link_status")!.n,
    1,
  );
});

test("keeps partial links but withholds status until every candidate chunk ran", async () => {
  const semantics = Array.from({ length: 40 }, (_, index) => ({
    name: `Semantic ${index}`,
    description: `description ${index} `.repeat(20),
  }));
  let failChunk = true;
  const { ctx, db } = await seededGraph({
    findings: [{ title: "A" }],
    semantics,
    contextWindow: 30_000,
    respond: ({ index, findingIds, candidateIds }) => {
      if (failChunk && index > 1) {
        return new Error("Free usage limit reached. Free models work in OpenCode.");
      }
      return linksFor(findingIds, candidateIds, medium);
    },
  });

  await assert.rejects(() => linkGlobal(ctx), /global link failed|model limit/i);

  assert.equal(db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, 0);
  assert.ok(db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n >= 1);

  failChunk = false;
  await linkGlobal(ctx);

  assert.equal(db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, 1);
});

test("upgrades an existing weaker link to the stronger global decision", async () => {
  const { ctx, db } = await seededGraph({
    findings: [{ title: "A" }],
    semantics: [{ name: "Only semantic" }],
    contextWindow: 20_000,
    respond: ({ findingIds, candidateIds }) =>
      linksFor(findingIds, candidateIds, (findingId) => medium(`upgrade ${findingId}`)),
  });
  const findingId = db.get<{ id: number }>("select id from audit_finding limit 1")!.id;
  const semanticId = db.get<{ id: number }>("select id from semantic_node limit 1")!.id;
  db.run(
    `insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence)
     values (?, ?, 'Low', 'old evidence')`,
    [semanticId, findingId],
  );

  await linkGlobal(ctx);

  const row = db.get<{ strength: string; evidence: string }>(
    "select strength, evidence from semantic_finding_link where semantic_node_id = ? and audit_finding_id = ?",
    [semanticId, findingId],
  )!;
  assert.equal(row.strength, "Medium");
  assert.match(row.evidence, /upgrade/);
});

test("renders folded raw children for candidates and findings", async () => {
  const { ctx, prompts } = await seededGraph({
    findings: [
      {
        title: "A",
        children: [
          {
            title: "Raw finding",
            rootCause: "child root cause",
            description: "FINDING-CHILD-SENTINEL description",
          },
        ],
      },
    ],
    semantics: [
      {
        name: "Only semantic",
        children: [
          {
            name: "Foldable Child",
            definition: "child definition",
            description: "CHILD-SENTINEL description",
          },
        ],
      },
    ],
    contextWindow: 20_000,
    respond: ({ findingIds, candidateIds }) =>
      linksFor(findingIds, candidateIds, medium),
  });

  await linkGlobal(ctx);

  assert.match(prompts[0], /additional context \(from raw "Foldable Child"\): CHILD-SENTINEL/);
  assert.match(
    prompts[0],
    /additional context \(from raw "Raw finding"\): FINDING-CHILD-SENTINEL/,
  );
});

test("resolves a folded raw finding's links onto its canonical finding", async () => {
  const { ctx, db } = await seededGraph({
    findings: [
      {
        title: "Canonical",
        children: [{ title: "Raw child", rootCause: "child rc", description: "child desc" }],
      },
    ],
    semantics: [{ name: "First" }, { name: "Second" }],
    contextWindow: 20_000,
    respond: ({ findingIds, candidateIds }) => ({
      links: findingIds.map((findingId, index) => ({
        finding_id: findingId,
        reasoning: "target resolution",
        semantic_evidence: [
          {
            semantic_id: candidateIds[Math.min(index, candidateIds.length - 1)],
            strength: "Medium",
            why_finding_can_fire: medium(`target ${findingId}`),
          },
        ],
      })),
    }),
  });

  await linkGlobal(ctx);

  const canonical = db.get<{ id: number }>(
    "select id from audit_finding where title = 'Canonical'",
  )!.id;
  const child = db.get<{ id: number }>(
    "select id from audit_finding where title = 'Raw child'",
  )!.id;
  const semanticIds = db
    .all<{ id: number }>("select id from semantic_node order by id")
    .map((row) => row.id);

  assert.deepEqual(
    db
      .all<{ semantic_node_id: number }>(
        "select semantic_node_id from semantic_finding_link where audit_finding_id = ? order by semantic_node_id",
        [canonical],
      )
      .map((row) => row.semantic_node_id),
    semanticIds,
  );
  assert.equal(
    db.get<{ n: number }>(
      "select count(*) n from semantic_finding_link where audit_finding_id = ?",
      [child],
    )!.n,
    0,
  );
  assert.deepEqual(
    db
      .all<{ audit_finding_id: number }>(
        "select audit_finding_id from finding_link_status order by audit_finding_id",
      )
      .map((row) => row.audit_finding_id),
    [canonical, child],
  );
});

test("rejects a decision for a finding id that is not in the prompt", async () => {
  const { ctx, db } = await seededGraph({
    findings: [{ title: "A" }],
    semantics: [{ name: "Only semantic" }],
    contextWindow: 20_000,
    respond: ({ candidateIds }) => ({
      links: [
        {
          finding_id: "F-999",
          reasoning: "wrong finding",
          semantic_evidence: [
            {
              semantic_id: candidateIds[0],
              strength: "Medium",
              why_finding_can_fire: medium("wrong id"),
            },
          ],
        },
      ],
    }),
  });

  await assert.rejects(() => linkGlobal(ctx), /not in this prompt|unknown finding/i);
  assert.equal(db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, 0);
});

test("normalizes quotes, case, and whitespace like the reference", () => {
  assert.equal(
    normalizeForQuoteMatch('He said \u201CShArEs\n\n are\tminted\u201D twice'),
    'he said "shares are minted" twice',
  );
});

test("uses the reference evidence floors and quote length", () => {
  assert.equal(MIN_HIGH_MEDIUM_BYTES, 40);
  assert.equal(MIN_LOW_BYTES, 15);
  assert.equal(HIGH_QUOTE_MIN_CHARS, 25);
});

test("keeps every accepted link instead of truncating at two", async () => {
  const { ctx } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Medium", evidence: medium("first") },
    { semanticIndex: 1, strength: "Medium", evidence: medium("second") },
    { semanticIndex: 2, strength: "Medium", evidence: medium("third") },
    { semanticIndex: 3, strength: "Medium", evidence: medium("fourth") },
    { semanticIndex: 4, strength: "Medium", evidence: medium("fifth") },
  ]);
  const result = await linkGlobal(ctx);
  assert.equal(result.linked, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 5);
});

test("retries a High link without a verbatim quote and accepts the corrected response", async () => {
  const { ctx, llm } = await seededGlobalCtx(
    [{ semanticIndex: 0, strength: "High", evidence: "the loop lets an attacker mint unlimited shares" }],
    {
      retryLinks: [
        {
          semanticIndex: 0,
          strength: "High",
          evidence: `The root cause says "${QUOTE}" which matches this pool semantic.`,
        },
      ],
    },
  );
  const r = await linkGlobal(ctx);
  assert.equal(r.linked, 1);
  assert.equal(llm.calls, 2);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link where strength = 'High'")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, 1);
});

test("rejects High evidence whose quote is under 25 chars even when grounded", async () => {
  const { ctx } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "High", evidence: `It says "shares are minted twice" in the root cause.` },
  ]);
  await assert.rejects(() => linkGlobal(ctx), /VERBATIM fragment|verbatim fragment/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 0);
});

test("rejects High evidence quoting another finding's text", async () => {
  const { ctx } = await seededGlobalCtx([
    {
      semanticIndex: 0,
      strength: "High",
      evidence: 'It says "attacker reenters the vault during the withdraw callback" in the body.',
    },
  ]);
  await assert.rejects(() => linkGlobal(ctx), /MIXED UP finding ids|appear in that finding/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 0);
});

test("accepts High evidence with curly quotes and line wrapping", async () => {
  const { ctx } = await seededGlobalCtx([
    {
      semanticIndex: 0,
      strength: "High",
      evidence: `The root cause says \u201CSHARES ARE MINTED\nTWICE IN A LOOP\u201D in the pool code.`,
    },
  ]);
  const r = await linkGlobal(ctx);
  assert.equal(r.linked, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link where strength = 'High'")!.n, 1);
});

test("rejects Medium evidence under the 40-byte floor", async () => {
  const { ctx } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Medium", evidence: "x".repeat(MIN_HIGH_MEDIUM_BYTES - 1) },
  ]);
  await assert.rejects(() => linkGlobal(ctx), /at least 40 chars/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 0);
});

test("accepts Medium evidence at exactly the 40-byte floor", async () => {
  const { ctx } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Medium", evidence: "m".repeat(MIN_HIGH_MEDIUM_BYTES) },
  ]);
  await linkGlobal(ctx);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link where strength = 'Medium'")!.n, 1);
});

test("enforces the 15-byte floor on Low evidence", async () => {
  const tooShort = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Low", evidence: "l".repeat(MIN_LOW_BYTES - 1) },
  ]);
  await assert.rejects(() => linkGlobal(tooShort.ctx), /at least 15 chars/i);

  const accepted = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Low", evidence: "l".repeat(MIN_LOW_BYTES) },
  ]);
  await linkGlobal(accepted.ctx);
  assert.equal(accepted.db.get<{ n: number }>("select count(*) n from semantic_finding_link where strength = 'Low'")!.n, 1);
});

test("measures the floors in UTF-8 bytes like the reference", async () => {
  // 14 chars but 42 bytes: a forgiving UTF-16 length check would reject it.
  const { ctx } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Medium", evidence: "\u00e9".repeat(21) },
  ]);
  await linkGlobal(ctx);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 1);
});

test("rejects empty evidence even at Low strength", async () => {
  const { ctx } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Low", evidence: "   " },
  ]);
  await assert.rejects(() => linkGlobal(ctx), /empty/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 0);
});

test("drains pending semantics that the retry pass already covers", async () => {
  const { ctx } = await seededGlobalCtx(
    [{ semanticIndex: 0, strength: "Medium", evidence: medium("pending") }],
    { pending: true },
  );
  const r = await linkGlobal(ctx);
  assert.equal(r.pendingDrained, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from pending_semantic")!.n, 0);
});

test("fails the global unit on a model limit and resumes only unlinked findings", async () => {
  const { ctx } = await seededGlobalCtx(
    [{ semanticIndex: 0, strength: "Medium", evidence: medium("limit") }],
    { failFirstCall: true },
  );

  await assert.rejects(() => linkGlobal(ctx), /global link failed.*model limit|global link failed/i);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, 0);
  assert.equal(
    ctx.journal.list(229).find((unit) => unit.stage === "link_global")!.status,
    "failed",
  );

  const resumed = await linkGlobal(ctx);

  assert.equal(resumed.linked, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, 1);
  assert.equal(
    ctx.journal.list(229).find((unit) => unit.stage === "link_global")!.status,
    "done",
  );
});

test("never overwrites an existing in-project link with a global one", async () => {
  const { ctx, db } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Medium", evidence: medium("global") },
  ]);
  const findingId = db.get<{ id: number }>("select id from audit_finding limit 1")!.id;
  const semanticId = db.get<{ id: number }>("select id from semantic_node order by id limit 1")!.id;
  db.run(
    `insert into semantic_finding_link (semantic_node_id, audit_finding_id, strength, evidence)
     values (?, ?, 'High', ?)`,
    [semanticId, findingId, inProjectEvidence()],
  );

  await linkGlobal(ctx);

  const row = db.get<{ strength: string; evidence: string }>(
    "select strength, evidence from semantic_finding_link where semantic_node_id = ? and audit_finding_id = ?",
    [semanticId, findingId],
  )!;
  assert.equal(row.strength, "High");
  assert.equal(row.evidence, inProjectEvidence());
});
