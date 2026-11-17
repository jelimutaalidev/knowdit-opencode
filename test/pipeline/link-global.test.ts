import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countVerbatimWords, linkGlobal } from "../../.opencode/plugins/knowdit/src/pipeline/link-global.ts";
import { openJournal } from "../../.opencode/plugins/knowdit/src/journal.ts";
import { tempDb } from "../helpers/db.ts";

type LinkSpec = { semanticIndex: number; strength: "High" | "Medium" | "Low"; evidence: string };

async function seededGlobalCtx(
  links: LinkSpec[],
  opts: { retryLinks?: LinkSpec[]; pending?: boolean } = {},
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

test("counts the longest run of verbatim words", () => {
  assert.equal(countVerbatimWords("the pool drains because shares are minted twice", "shares are minted twice in a loop"), 4);
  assert.equal(countVerbatimWords("completely different words here", "nothing matches at all"), 0);
});

test("retries a High link with paraphrased evidence and accepts the corrected response", async () => {
  const { ctx, llm } = await seededGlobalCtx(
    [{ semanticIndex: 0, strength: "High", evidence: "paraphrase without the words" }],
    { retryLinks: [{ semanticIndex: 0, strength: "High", evidence: "shares are minted twice in a loop" }] },
  );
  const r = await linkGlobal(ctx);
  assert.equal(r.linked, 1);
  assert.equal(llm.calls, 2);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link where strength = 'High'")!.n, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from finding_link_status")!.n, 1);
});

test("caps links at two per finding", async () => {
  const { ctx } = await seededGlobalCtx([
    { semanticIndex: 0, strength: "Medium", evidence: "a" },
    { semanticIndex: 1, strength: "Medium", evidence: "b" },
    { semanticIndex: 2, strength: "Medium", evidence: "c" },
  ]);
  await linkGlobal(ctx);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 2);
});

test("drains pending semantics that the retry pass already covers", async () => {
  const { ctx } = await seededGlobalCtx(
    [{ semanticIndex: 0, strength: "Medium", evidence: "a" }],
    { pending: true },
  );
  const r = await linkGlobal(ctx);
  assert.equal(r.pendingDrained, 1);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from pending_semantic")!.n, 0);
});
