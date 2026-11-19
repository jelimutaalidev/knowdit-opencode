import test from "node:test";
import assert from "node:assert/strict";
import { linkInProject, inProjectEvidence, IN_PROJECT_LINK_EVIDENCE_PREFIX } from "../../.opencode/plugins/knowdit/src/pipeline/link-in-project.ts";
import { ensureProject } from "../../.opencode/plugins/knowdit/src/pipeline/project.ts";
import { fakeCtx, type FakeCtx } from "../helpers/ctx.ts";

async function seededCtx(opts: {
  semantics: number;
  findings: number;
  links: [number, number[]][];
}): Promise<FakeCtx> {
  const fixture = await fakeCtx({
    links: opts.links.map(([findingIndex, semanticIndices]) => ({ findingIndex, semanticIndices })),
  });
  const { ctx } = fixture;
  const projectId = ensureProject(ctx);

  for (let index = 0; index < opts.semantics; index += 1) {
    const id = ctx.db.run(
      "insert into semantic_node (name, definition, description, category) values (?, ?, ?, ?)",
      [`Semantic ${index}`, "def", `description ${index}`, "Dexes"],
    ).lastInsertRowid;
    ctx.db.run(
      "insert into project_semantic (project_id, semantic_node_id) values (?, ?)",
      [projectId, id],
    );
  }

  const taxonomy = ctx.db.get<{ id: number }>(
    "select id from finding_category where category = ? and name = ?",
    ["Arithmetic", "Integer Overflow"],
  )!;

  for (let index = 0; index < opts.findings; index += 1) {
    const id = ctx.db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values (?, 'High', 'rc', 'description', 'p', 'e')`,
      [`Finding ${index}`],
    ).lastInsertRowid;
    ctx.db.run(
      "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
      [id, taxonomy.id],
    );
    ctx.db.run(
      "insert into project_finding (project_id, audit_finding_id) values (?, ?)",
      [projectId, id],
    );
  }

  return fixture;
}

test("writes one High edge per pair with the exact synthetic evidence", async () => {
  const { ctx } = await seededCtx({ semantics: 2, findings: 2, links: [[0, [0, 1]], [1, [1]]] });
  const r = await linkInProject(ctx);
  assert.equal(r.edges, 3);
  const rows = ctx.db.all<{ strength: string; evidence: string }>("select strength, evidence from semantic_finding_link");
  assert.ok(rows.every((x) => x.strength === "High"));
  assert.ok(rows.every((x) => x.evidence === inProjectEvidence()));
  assert.ok(inProjectEvidence().startsWith(IN_PROJECT_LINK_EVIDENCE_PREFIX));
});

test("ignores canonical rows that only gained provenance through a cross-project merge", async () => {
  const { ctx, llm, prompts } = await seededCtx({
    semantics: 1,
    findings: 1,
    links: [[0, [0]]],
  });
  const projectId = ctx.db.get<{ id: number }>("select id from project limit 1")!.id;
  const taxonomy = ctx.db.get<{ id: number }>(
    "select id from finding_category where category = ? and name = ?",
    ["Arithmetic", "Integer Overflow"],
  )!;

  const canonicalSemantic = ctx.db.run(
    "insert into semantic_node (name, definition, description, category) values (?, ?, ?, ?)",
    ["Canonical Semantic", "def", "desc", "Dexes"],
  ).lastInsertRowid;
  ctx.db.run(
    "insert into project_semantic (project_id, semantic_node_id) values (?, ?)",
    [projectId, canonicalSemantic],
  );
  const foreignSemantic = ctx.db.run(
    "insert into semantic_node (name, definition, description, category) values (?, ?, ?, ?)",
    ["Foreign Semantic", "def", "desc", "Dexes"],
  ).lastInsertRowid;
  ctx.db.run(
    `insert into semantic_merge (from_semantic_id, to_semantic_id, appended_description)
     values (?, ?, 'note')`,
    [foreignSemantic, canonicalSemantic],
  );

  const canonicalFinding = ctx.db.run(
    `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
     values ('Canonical Finding', 'High', 'rc', 'description', 'p', 'e')`,
  ).lastInsertRowid;
  ctx.db.run(
    "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
    [canonicalFinding, taxonomy.id],
  );
  ctx.db.run(
    "insert into project_finding (project_id, audit_finding_id) values (?, ?)",
    [projectId, canonicalFinding],
  );
  const foreignFinding = ctx.db.run(
    `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
     values ('Foreign Finding', 'High', 'rc', 'description', 'p', 'e')`,
  ).lastInsertRowid;
  ctx.db.run(
    "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
    [foreignFinding, taxonomy.id],
  );
  ctx.db.run(
    `insert into finding_merge
       (from_finding_id, to_finding_id, appended_description, appended_patterns, appended_exploits)
     values (?, ?, 'note', 'note', 'note')`,
    [foreignFinding, canonicalFinding],
  );

  const r = await linkInProject(ctx);

  assert.equal(r.edges, 1);
  assert.equal(llm.calls, 1);
  assert.ok(!prompts[0].includes("Canonical Semantic"));
  assert.ok(!prompts[0].includes("Canonical Finding"));
  assert.equal(
    ctx.db.get<{ n: number }>(
      "select count(*) n from semantic_finding_link where audit_finding_id = ?",
      [canonicalFinding],
    )!.n,
    0,
  );
});

test("retries when a finding is omitted, and persists nothing on final failure", async () => {
  const { ctx, llm } = await seededCtx({ semantics: 2, findings: 2, links: [[0, [0]]] });
  await assert.rejects(() => linkInProject(ctx), /left finding/i);
  assert.equal(llm.calls, 3);
  assert.equal(ctx.db.get<{ n: number }>("select count(*) n from semantic_finding_link")!.n, 0);
});
