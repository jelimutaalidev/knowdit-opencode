import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openKg, seedReferenceTables, type KgDb } from "../../.opencode/plugins/knowdit/src/db/client.ts";
import { writeManifest, type Manifest } from "../../.opencode/plugins/knowdit/src/dataset/snapshot.ts";
import { openJournal, type Journal } from "../../.opencode/plugins/knowdit/src/journal.ts";
import type { LlmCaller } from "../../.opencode/plugins/knowdit/src/llm/types.ts";

export type FakeBuildOptions = {
  contests: number[];
  alreadyDone?: boolean;
  merged?: boolean;
  failContest?: number;
  canned?: boolean;
  dbPath?: string;
};

export type FakeBuild = {
  deps: {
    db: KgDb;
    llm: LlmCaller;
    journal: Journal;
    dataDir: string;
    c4Ids: number[];
  };
  journal: Journal;
  order: string[];
};

const CONTEST_STAGES = ["categorize", "semantics", "findings", "link", "merge"] as const;

function semanticName(canned: boolean, c4Id: number): string {
  return canned ? "Canned Semantic" : `Fake Semantic ${c4Id}`;
}

function findingTitle(canned: boolean, c4Id: number): string {
  return canned ? "Canned Finding" : `Fake Finding ${c4Id}`;
}

function semantic(canned: boolean, c4Id: number) {
  return {
    name: semanticName(canned, c4Id),
    definition: "fake definition",
    description: "fake description",
    category: "Dexes",
    functions: [{ name: "swap", contract: "src/A.sol" }],
  };
}

function finding(canned: boolean, c4Id: number) {
  return {
    title: findingTitle(canned, c4Id),
    severity: "Medium",
    category: "Arithmetic",
    subcategory: "Integer Overflow",
    root_cause: "fake root cause",
    description: "fake description",
    patterns: "fake patterns",
    exploits: "fake exploits",
  };
}

/**
 * Answer the prompt by matching the output schema each builder appends.
 * The pipeline runs contests sequentially, so `currentC4` (set from the
 * wrapped journal) provides stable, contest-specific identity in the fake
 * rows while keeping the prompts themselves unchanged.
 */
function scriptedValue(
  prompt: string,
  opts: { canned: boolean; currentC4: number },
): unknown {
  const { canned, currentC4 } = opts;

  if (prompt.includes('"new_semantic_name"')) {
    return {
      decisions: [
        {
          reason: "fake new semantic",
          new_semantic_name: semanticName(canned, currentC4),
          merge_target_ids: [],
        },
      ],
    };
  }

  if (prompt.includes('"new_finding_title"')) {
    return {
      decisions: [
        {
          reason: "fake new finding",
          new_finding_title: findingTitle(canned, currentC4),
          merge_target_ids: [],
        },
      ],
    };
  }

  if (prompt.includes('"semantic_indices"')) {
    return {
      links: [
        {
          finding_index: 0,
          reasoning: "fake in-project link",
          semantic_indices: [0],
        },
      ],
    };
  }

  if (prompt.includes('"semantic_evidence"')) {
    const findingId = /^### (F-\d+)$/m.exec(prompt)?.[1];
    const candidateId = /^ID: (\d+)$/m.exec(prompt)?.[1];
    if (!findingId || !candidateId) {
      throw new Error("fakeBuild: global link prompt lacks a finding id or candidate id");
    }
    return {
      links: [
        {
          finding_id: findingId,
          reasoning: "fake global link",
          semantic_evidence: [
            {
              semantic_id: Number(candidateId),
              strength: "Medium",
              why_finding_can_fire: "fake tangential relation",
            },
          ],
        },
      ],
    };
  }

  if (prompt.includes('"project_name"')) {
    return {
      reasoning: "fake categorization",
      project_name: "fake project",
      categories: ["Dexes"],
    };
  }

  if (prompt.includes('"semantics"')) {
    return { semantics: [semantic(canned, currentC4)] };
  }

  if (prompt.includes('"findings"')) {
    return { findings: [finding(canned, currentC4)] };
  }

  throw new Error("fakeBuild: no scripted response for this prompt");
}

export async function fakeBuild(opts: FakeBuildOptions): Promise<FakeBuild> {
  const root = mkdtempSync(join(tmpdir(), "fake-build-"));
  const dataDir = join(root, "dataset");
  const defaultDbPath = join(root, "kg.sqlite");
  const dbPath = opts.dbPath ?? defaultDbPath;

  // `dbPath` is an explicit output location, so replace any previous run
  // (including WAL sidecars) instead of reusing stale state.
  if (opts.dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }

  for (const c4Id of opts.contests) {
    mkdirSync(join(dataDir, "reports"), { recursive: true });
    mkdirSync(join(dataDir, "contracts", String(c4Id), "src"), { recursive: true });
    writeFileSync(
      join(dataDir, "reports", `${c4Id}.md`),
      `# Audit ${c4Id}\n\n## High Risk\n\n- fake finding\n`,
    );
    writeFileSync(join(dataDir, "contracts", String(c4Id), "src", "A.sol"), "// SOURCE\n");
  }

  const manifest: Manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: root,
    contests: opts.contests.map((c4Id, index) => ({
      localId: index,
      c4Id,
      slug: `contest-${c4Id}`,
      title: `Contest ${c4Id}`,
      coreLoc: 1,
      sourceFiles: ["src/A.sol"],
      report: null,
      expected: { high: 0, medium: 0 },
    })),
    excluded: [],
  };
  writeManifest(join(dataDir, "manifest.json"), manifest);

  const db = await openKg(dbPath);
  seedReferenceTables(db);

  const baseJournal = await openJournal(join(root, "runs.sqlite"));
  const order: string[] = [];
  let currentC4 = opts.contests[0] ?? 0;

  const originalStart = baseJournal.start.bind(baseJournal);
  baseJournal.start = (unit) => {
    currentC4 = unit.c4Id;
    if (unit.stage !== "link_global") {
      order.push(
        unit.stage === "global" || unit.stage === "finalize"
          ? unit.stage
          : `${unit.stage}:${unit.c4Id}`,
      );
    }
    originalStart(unit);
  };

  if (opts.alreadyDone) {
    for (const c4Id of opts.contests) {
      for (const stage of CONTEST_STAGES) {
        baseJournal.done({ stage, c4Id, unitIndex: 0 });
      }
    }
    baseJournal.done({ stage: "global", c4Id: 0, unitIndex: 0 });
    baseJournal.done({ stage: "finalize", c4Id: 0, unitIndex: 0 });
  }

  if (opts.merged) {
    const from = db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values ('Merged from', 'High', 'rc', 'desc', 'p', 'e')`,
    ).lastInsertRowid;
    const to = db.run(
      `insert into audit_finding (title, severity, root_cause, description, patterns, exploits)
       values ('Merged into', 'High', 'rc', 'desc', 'p', 'e')`,
    ).lastInsertRowid;
    db.run(
      `insert into finding_merge
         (from_finding_id, to_finding_id, appended_description, appended_patterns, appended_exploits)
       values (?, ?, 'note', 'note', 'note')`,
      [from, to],
    );
  }

  if (opts.failContest !== undefined) {
    baseJournal.fail(
      { stage: "merge", c4Id: opts.failContest, unitIndex: 0 },
      "fake failure",
    );
  }

  const llm = {
    async json<T>(input: {
      prompt: string;
      validate: (value: unknown) => T;
      key?: string;
    }): Promise<{ value: T; tokensEst: number; costEst: number }> {
      const value = input.validate(
        scriptedValue(input.prompt, { canned: opts.canned ?? false, currentC4 }),
      );
      return { value, tokensEst: Math.ceil(input.prompt.length / 4), costEst: 0 };
    },
  } as LlmCaller;

  return {
    deps: {
      db,
      llm,
      journal: baseJournal,
      dataDir,
      c4Ids: opts.contests,
    },
    journal: baseJournal,
    order,
  };
}
