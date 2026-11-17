import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KgDb } from "../db/client.ts";
import type { Manifest } from "../dataset/snapshot.ts";
import type { IntegrityReport } from "../integrity.ts";
import type { Journal } from "../journal.ts";
import type { LlmCaller } from "../llm/types.ts";
import { categorizeProject } from "./categorize.ts";
import { extractFindings } from "./extract-findings.ts";
import { extractSemantics } from "./extract-semantics.ts";
import { finalizeBuild } from "./finalize.ts";
import { linkGlobal } from "./link-global.ts";
import { linkInProject } from "./link-in-project.ts";
import { mergeContest } from "./merge.ts";
import type { StageContext } from "./types.ts";

export type BuildOptions = {
  dataDir: string;
  c4Ids?: number[];
  concurrency?: 1;
  force?: boolean;
  resetAll?: boolean;
};

export type BuildResult = {
  contests: number;
  integrity: IntegrityReport;
  semanticEdges: number;
  findingEdges: number;
};

type BuildDeps = BuildOptions & {
  db: KgDb;
  llm: LlmCaller;
  journal: Journal;
};

function hasMergeRows(db: KgDb): boolean {
  return (
    (db.get<{ n: number }>("select count(*) n from semantic_merge")?.n ?? 0) > 0 ||
    (db.get<{ n: number }>("select count(*) n from finding_merge")?.n ?? 0) > 0
  );
}

export function resetKg(db: KgDb): void {
  db.tx(() => {
    const tables = [
      "semantic_finding_link",
      "finding_link_status",
      "finding_merge",
      "semantic_merge",
      "project_semantic",
      "project_finding",
      "audit_finding_category",
      "semantic_function",
      "pending_semantic",
      "operation_history",
      "merge_status",
      "project_category",
      "project_platform",
      "audit_finding",
      "semantic_node",
      "project",
    ];
    for (const table of tables) db.run(`delete from ${table}`);
  });
}

export function resetContest(db: KgDb, c4Id: number): void {
  const platformId = `c4-${c4Id}`;
  const project = db.get<{ id: number }>(
    `select p.id as id
       from project p
       join project_platform pp on pp.project_id = p.id
      where pp.platform_id = ?`,
    [platformId],
  );
  if (!project) return;

  const projectId = project.id;
  const semanticIds = db
    .all<{ id: number }>("select semantic_node_id as id from project_semantic where project_id = ?", [
      projectId,
    ])
    .map((row) => row.id);
  const findingIds = db
    .all<{ id: number }>("select audit_finding_id as id from project_finding where project_id = ?", [
      projectId,
    ])
    .map((row) => row.id);

  const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");

  db.tx(() => {
    if (findingIds.length > 0) {
      db.run(
        `delete from finding_link_status where audit_finding_id in (${placeholders(findingIds.length)})`,
        findingIds,
      );
    }
    if (semanticIds.length > 0 || findingIds.length > 0) {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (semanticIds.length > 0) {
        clauses.push(`semantic_node_id in (${placeholders(semanticIds.length)})`);
        params.push(...semanticIds);
      }
      if (findingIds.length > 0) {
        clauses.push(`audit_finding_id in (${placeholders(findingIds.length)})`);
        params.push(...findingIds);
      }
      db.run(`delete from semantic_finding_link where ${clauses.join(" or ")}`, params);
    }

    db.run("delete from project_semantic where project_id = ?", [projectId]);
    db.run("delete from project_finding where project_id = ?", [projectId]);
    db.run("delete from project_category where project_id = ?", [projectId]);
    db.run("delete from project_platform where project_id = ?", [projectId]);
    db.run("delete from project where id = ?", [projectId]);

    // Rows already folded into a canonical are shared history; deleting them
    // would violate the merge FKs. Leave those behind.
    const ownedFindings = db.all<{ id: number }>(
      `select af.id as id from audit_finding af
        where af.id in (${findingIds.length > 0 ? placeholders(findingIds.length) : "null"})
          and not exists (select 1 from finding_merge fm where fm.from_finding_id = af.id or fm.to_finding_id = af.id)`,
      findingIds,
    );
    for (const row of ownedFindings) {
      db.run("delete from audit_finding_category where audit_finding_id = ?", [row.id]);
      db.run("delete from audit_finding where id = ?", [row.id]);
    }

    const ownedSemantics = db.all<{ id: number }>(
      `select sn.id as id from semantic_node sn
        where sn.id in (${semanticIds.length > 0 ? placeholders(semanticIds.length) : "null"})
          and not exists (select 1 from semantic_merge sm where sm.from_semantic_id = sn.id or sm.to_semantic_id = sn.id)`,
      semanticIds,
    );
    for (const row of ownedSemantics) {
      db.run("delete from semantic_function where semantic_node_id = ?", [row.id]);
      db.run("delete from semantic_node where id = ?", [row.id]);
    }
  });
}

async function runStage<T>(
  journal: Journal,
  unit: { stage: string; c4Id: number; unitIndex: number },
  fn: () => Promise<T>,
): Promise<T | undefined> {
  if (journal.isDone(unit)) return undefined;
  journal.start(unit);
  try {
    const result = await fn();
    journal.done(unit);
    return result;
  } catch (error) {
    journal.fail(unit, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

export async function buildKg(opts: BuildDeps): Promise<BuildResult> {
  const { db, llm, journal } = opts;
  const manifestPath = join(opts.dataDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      `dataset manifest not found at ${manifestPath}; run dataset_prepare first`,
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const c4Ids = opts.c4Ids ?? manifest.contests.map((contest) => contest.c4Id);

  if (opts.force && hasMergeRows(db)) {
    throw new Error(
      "force after merge is unsafe because raws are folded into canonicals; use reset_all",
    );
  }

  if (opts.resetAll) {
    resetKg(db);
    journal.resetAll();
  } else if (opts.force) {
    for (const c4Id of c4Ids) {
      resetContest(db, c4Id);
      journal.resetContest(c4Id);
    }
  }

  const active = c4Ids.filter((c4Id) => !journal.isSkipped(c4Id));

  for (const c4Id of active) {
    const failed = journal
      .list(c4Id)
      .filter((unit) => unit.status === "failed")
      .map((unit) => unit.stage);
    if (failed.length > 0) {
      throw new Error(
        `contest ${c4Id} has failed units (${failed.join(", ")}); rerun it or skip it before merge/global linking`,
      );
    }
  }

  let semanticEdges = 0;
  let findingEdges = 0;

  for (const c4Id of active) {
    const contest = manifest.contests.find((entry) => entry.c4Id === c4Id);
    if (!contest) throw new Error(`contest ${c4Id} is not in the dataset manifest`);

    const ctx: StageContext = {
      db,
      llm,
      journal,
      contest,
      datasetDir: opts.dataDir,
    };
    const unit = (stage: string) => ({ stage, c4Id, unitIndex: 0 });

    await runStage(journal, unit("categorize"), () => categorizeProject(ctx));
    await runStage(journal, unit("semantics"), () => extractSemantics(ctx));
    await runStage(journal, unit("findings"), () => extractFindings(ctx));
    await runStage(journal, unit("link"), () => linkInProject(ctx));
    const merge = await runStage(journal, unit("merge"), () => mergeContest(ctx));
    if (merge) {
      semanticEdges += merge.semanticEdges;
      findingEdges += merge.findingEdges;
    }
  }

  await runStage(journal, { stage: "global", c4Id: 0, unitIndex: 0 }, () =>
    linkGlobal({ db, llm, journal, c4Ids: active }),
  );

  const integrity = await runStage(
    journal,
    { stage: "finalize", c4Id: 0, unitIndex: 0 },
    async () => {
      const report = finalizeBuild(db, { c4Ids: active });
      if (!report.ok) {
        throw new Error(
          `integrity gate failed: ${report.checks
            .filter((entry) => !entry.passed)
            .map((entry) => entry.name)
            .join(", ")}`,
        );
      }
      return report;
    },
  );

  return {
    contests: active.length,
    integrity: integrity ?? finalizeBuild(db, { c4Ids: active }),
    semanticEdges,
    findingEdges,
  };
}
