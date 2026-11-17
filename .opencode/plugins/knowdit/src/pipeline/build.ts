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
import type { ProgressFn, StageContext } from "./types.ts";

export type BuildOptions = {
  dataDir: string;
  c4Ids?: number[];
  concurrency?: 1;
  force?: boolean;
  resetAll?: boolean;
  /** Receives stage-level updates so the tool UI can show live progress. */
  onProgress?: ProgressFn;
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

const STAGE_LABELS: Record<string, string> = {
  categorize: "Categorizing project",
  semantics: "Extracting semantic nodes",
  findings: "Extracting findings",
  link: "Linking findings in project",
  merge: "Merging duplicate knowledge",
  global: "Linking findings across projects",
  finalize: "Verifying knowledge graph integrity",
};

type StageRunOptions = {
  /** Re-run even when the journal says the unit is done. */
  force?: boolean;
  /** Runs only when the unit is not skipped. */
  onStart?: () => void | Promise<void>;
  /** Flips to true whenever a unit actually executes. */
  ran?: { value: boolean };
};

async function runStage<T>(
  journal: Journal,
  unit: { stage: string; c4Id: number; unitIndex: number },
  fn: () => Promise<T>,
  opts: StageRunOptions = {},
): Promise<T | undefined> {
  if (!opts.force && journal.isDone(unit)) return undefined;
  if (opts.ran) opts.ran.value = true;
  if (opts.onStart) await opts.onStart();
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

/**
 * Findings that still have no global-link decision. A previous run can leave
 * these behind when the model quota runs out after its findings were already
 * linked in-project: the `global` unit is then marked done even though the
 * status rows never landed. Resume must repair that instead of skipping it.
 */
function countFindingsMissingGlobalStatus(db: KgDb, c4Ids: readonly number[]): number {
  const filters = [
    "not exists (select 1 from finding_link_status fls where fls.audit_finding_id = af.id)",
  ];
  const params: unknown[] = [];
  if (c4Ids.length > 0) {
    filters.push(
      `exists (
         select 1 from project_finding pf
           join project_platform pp on pp.project_id = pf.project_id
          where pf.audit_finding_id = af.id
            and pp.platform_id in (${c4Ids.map(() => "?").join(", ")})
       )`,
    );
    params.push(...c4Ids.map((id) => `c4-${id}`));
  }

  return (
    db.get<{ n: number }>(
      `select count(*) n from audit_finding af where ${filters.join(" and ")}`,
      params,
    )?.n ?? 0
  );
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

  const emit: ProgressFn = async (update) => {
    if (opts.onProgress) await opts.onProgress(update);
  };
  const ran = { value: false };

  if (active.length > 0) {
    await emit({
      title: "KNOWDIT build",
      stage: "start",
      detail: `Building ${active.length} contest(s)`,
      completed: 0,
      total: active.length,
      contestCompleted: 0,
      contestTotal: active.length,
    });
  }

  let semanticEdges = 0;
  let findingEdges = 0;

  for (let index = 0; index < active.length; index++) {
    const c4Id = active[index];
    const contest = manifest.contests.find((entry) => entry.c4Id === c4Id);
    if (!contest) throw new Error(`contest ${c4Id} is not in the dataset manifest`);

    // Every update below carries the overall contest position so a long
    // chunk-level stage still tells the operator where the build is.
    const progress: ProgressFn = async (update) => {
      await emit({ contestCompleted: index, contestTotal: active.length, ...update });
    };
    const ctx: StageContext = {
      db,
      llm,
      journal,
      contest,
      datasetDir: opts.dataDir,
      onProgress: progress,
    };
    const unit = (stage: string) => ({ stage, c4Id, unitIndex: 0 });
    const stageStart = (stage: string) => async () => {
      await progress({
        title: "KNOWDIT build",
        stage,
        contest: c4Id,
        detail: `${STAGE_LABELS[stage] ?? stage} · C4 ${c4Id} (contest ${index + 1}/${active.length})`,
        completed: index,
        total: active.length,
      });
    };

    await runStage(journal, unit("categorize"), () => categorizeProject(ctx), {
      onStart: stageStart("categorize"),
      ran,
    });
    await runStage(journal, unit("semantics"), () => extractSemantics(ctx), {
      onStart: stageStart("semantics"),
      ran,
    });
    await runStage(journal, unit("findings"), () => extractFindings(ctx), {
      onStart: stageStart("findings"),
      ran,
    });
    await runStage(journal, unit("link"), () => linkInProject(ctx), {
      onStart: stageStart("link"),
      ran,
    });
    const merge = await runStage(journal, unit("merge"), () => mergeContest(ctx), {
      onStart: stageStart("merge"),
      ran,
    });
    if (merge) {
      semanticEdges += merge.semanticEdges;
      findingEdges += merge.findingEdges;
    }

    await progress({
      title: "KNOWDIT build",
      stage: "contest_done",
      contest: c4Id,
      detail: `Contest ${index + 1}/${active.length} complete · C4 ${c4Id}`,
      completed: index + 1,
      total: active.length,
    });
  }

  const globalUnit = { stage: "global", c4Id: 0, unitIndex: 0 };
  const missingGlobalStatus = countFindingsMissingGlobalStatus(db, active);
  const repairingGlobal = journal.isDone(globalUnit) && missingGlobalStatus > 0;

  const globalProgress: ProgressFn = async (update) => {
    const event = update.event;
    if (event === "global_start") {
      await emit({
        title: "KNOWDIT global link",
        stage: "global",
        detail: `Linking ${update.findings} finding(s) against ${update.candidates} semantic(s)`,
        completed: 0,
        total: update.findings,
      });
      return;
    }

    if (event === "global_finding") {
      const position = Number(update.index);
      const total = Number(update.total);
      const status = String(update.status);
      await emit({
        title: "KNOWDIT global link",
        stage: "global",
        contest: update.c4Id,
        finding: update.findingId,
        detail:
          status === "done"
            ? `Linked finding ${position}/${total} · C4 ${update.c4Id}`
            : status === "failed"
              ? `Failed finding ${position}/${total} · C4 ${update.c4Id}: ${update.error}`
              : `Linking finding ${position}/${total} · C4 ${update.c4Id}`,
        completed: status === "done" ? position : Math.max(0, position - 1),
        total,
      });
      return;
    }

    if (event === "global_done") {
      const linked = Number(update.linked ?? 0);
      const failed = Number(update.failed ?? 0);
      await emit({
        title: "KNOWDIT global link",
        stage: "global",
        detail: `${linked} finding(s) linked, ${failed} failed`,
        completed: linked,
        total: linked + failed,
      });
    }
  };

  await runStage(
    journal,
    globalUnit,
    () => linkGlobal({ db, llm, journal, c4Ids: active, onProgress: globalProgress }),
    {
      force: repairingGlobal,
      ran,
      onStart: async () => {
        await emit({
          title: "KNOWDIT global link",
          stage: "global",
          detail: repairingGlobal
            ? `Repairing ${missingGlobalStatus} finding(s) left without a global-link decision`
            : "Starting global link pass",
        });
      },
    },
  );

  const finalizeForce = ran.value;
  const integrity = await runStage(
    journal,
    { stage: "finalize", c4Id: 0, unitIndex: 0 },
    async () => {
      const report = finalizeBuild(db, { c4Ids: active });
      if (!report.ok) {
        const failures = report.checks.filter((entry) => !entry.passed);
        throw new Error(
          `integrity gate failed: ${failures
            .map((entry) => `${entry.name}${entry.detail ? ` (${entry.detail})` : ""}`)
            .join("; ")}`,
        );
      }
      return report;
    },
    {
      force: finalizeForce,
      ran,
      onStart: async () => {
        await emit({
          title: "KNOWDIT build",
          stage: "finalize",
          detail: "Verifying knowledge graph integrity",
          completed: active.length,
          total: active.length,
        });
      },
    },
  );

  await emit({
    title: "KNOWDIT build",
    stage: "done",
    detail: `Build complete · ${active.length} contest(s) verified`,
    completed: active.length,
    total: active.length,
    contestCompleted: active.length,
    contestTotal: active.length,
  });

  return {
    contests: active.length,
    integrity: integrity ?? finalizeBuild(db, { c4Ids: active }),
    semanticEdges,
    findingEdges,
  };
}
