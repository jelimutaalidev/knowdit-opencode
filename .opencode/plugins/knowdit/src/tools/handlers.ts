import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openKg, seedReferenceTables } from "../db/client.ts";
import { BATCH_LOCAL_IDS } from "../dataset/select.ts";
import { prepareDataset } from "../dataset/prepare.ts";
import type { Manifest } from "../dataset/snapshot.ts";
import { openJournal } from "../journal.ts";
import { fileCache } from "../llm/cache.ts";
import { createLlmCaller, isModelLimitError } from "../llm/caller.ts";
import type { GenerateFn, ModelRef } from "../llm/types.ts";
import { buildKg } from "../pipeline/build.ts";
import { queryFindings, queryLinks, querySemantics } from "../query.ts";
import type { ToolHandler } from "../register.ts";
import { readStats } from "../stats.ts";

export type HandlerDeps = {
  dataDir: string;
  generate: GenerateFn;
  model?: ModelRef;
  cost?: { input: number; output: number };
};

type JournalUnitRow = {
  c4_id: number;
  stage: string;
  unit_index: number;
  status: string;
  attempts: number;
  tokens_est: number | null;
  cost_est: number | null;
  error: string | null;
};

function paths(dataDir: string) {
  return {
    datasetDir: join(dataDir, "dataset"),
    manifestPath: join(dataDir, "dataset", "manifest.json"),
    kgPath: join(dataDir, "kg.sqlite"),
    journalPath: join(dataDir, "runs.sqlite"),
    cacheDir: join(dataDir, "cache"),
  };
}

function readManifest(path: string): Manifest | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    return null;
  }
}

function asRecord(input: unknown): Record<string, unknown> {
  return (input ?? {}) as Record<string, unknown>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function buildHandlers(deps: HandlerDeps): Record<string, ToolHandler> {
  const p = paths(deps.dataDir);

  return {
    dataset_prepare: async (input) => {
      const options = asRecord(input);
      const sourceRoot =
        typeof options.sourceRoot === "string"
          ? options.sourceRoot
          : join(homedir(), "c4-data", "out_train");
      const localIds = Array.isArray(options.localIds)
        ? (options.localIds as number[])
        : BATCH_LOCAL_IDS;
      const manifest = await prepareDataset({
        sourceRoot,
        dataDir: deps.dataDir,
        localIds,
      });
      const coreLoc = manifest.contests.reduce((sum, contest) => sum + contest.coreLoc, 0);
      const tokensEst = manifest.contests.reduce(
        (sum, contest) => sum + (contest.report?.tokensEst ?? 0),
        0,
      );
      return {
        content: JSON.stringify(
          {
            datasetDir: p.datasetDir,
            contests: manifest.contests.length,
            coreLoc,
            tokensEst,
            excluded: manifest.excluded,
          },
          null,
          2,
        ),
      };
    },

    kg_build: async (input, ctx) => {
      const options = asRecord(input);
      const c4Ids = Array.isArray(options.c4Ids)
        ? (options.c4Ids as unknown[])
            .filter((value): value is number => Number.isInteger(value))
            .map((value) => value as number)
        : undefined;

      const db = await openKg(p.kgPath);
      seedReferenceTables(db);
      const journal = await openJournal(p.journalPath);

      try {
        const llm = createLlmCaller({
          generate: deps.generate,
          model: deps.model,
          cache: fileCache(p.cacheDir),
          maxAttempts: 3,
          cost: deps.cost,
        });

        const result = await buildKg({
          dataDir: p.datasetDir,
          c4Ids,
          concurrency: 1,
          force: asBoolean(options.force),
          resetAll: asBoolean(options.resetAll),
          onProgress: ctx.progress,
          db,
          llm,
          journal,
        });

        return {
          content: JSON.stringify(
            {
              ...result,
              kgPath: p.kgPath,
              journalPath: p.journalPath,
            },
            null,
            2,
          ),
        };
      } catch (error) {
        if (isModelLimitError(error)) throw error;

        const message = error instanceof Error ? error.message : String(error);
        if (/\bresume\b|\brerun\b/i.test(message)) throw error;
        throw new Error(
          `${message}\nResume: rerun knowdit_kg_build with the same c4Ids. ` +
            "Finished stages are skipped, unfinished ones are retried, and cached model responses are reused.",
        );
      } finally {
        journal.close();
        db.close();
      }
    },

    kg_status: async () => {
      const manifest = readManifest(p.manifestPath);
      const dataset = manifest
        ? {
            ready: true,
            contests: manifest.contests.length,
            generatedAt: manifest.generatedAt,
            expected: {
              high: manifest.contests.reduce((sum, c) => sum + c.expected.high, 0),
              medium: manifest.contests.reduce((sum, c) => sum + c.expected.medium, 0),
            },
          }
        : { ready: false };

      const journal = {
        exists: existsSync(p.journalPath),
        tokensEst: 0,
        costEst: 0,
        units: [] as unknown[],
        failedUnits: [] as unknown[],
        skippedContests: [] as number[],
      };

      if (journal.exists) {
        const jdb = await openKg(p.journalPath);
        try {
          const units = jdb.all<JournalUnitRow>(
            `select c4_id, stage, unit_index, status, attempts, tokens_est, cost_est, error
               from unit_status
              order by c4_id, stage, unit_index`,
          );
          journal.tokensEst = units.reduce((sum, unit) => sum + (unit.tokens_est ?? 0), 0);
          journal.costEst = units.reduce((sum, unit) => sum + (unit.cost_est ?? 0), 0);
          journal.units = units.map((unit) => ({
            c4Id: unit.c4_id,
            stage: unit.stage,
            unitIndex: unit.unit_index,
            status: unit.status,
            attempts: unit.attempts,
            tokensEst: unit.tokens_est,
            costEst: unit.cost_est,
            error: unit.error,
          }));
          journal.failedUnits = units
            .filter((unit) => unit.status === "failed")
            .map((unit) => ({
              c4Id: unit.c4_id,
              stage: unit.stage,
              unitIndex: unit.unit_index,
              error: unit.error,
            }));
          journal.skippedContests = jdb
            .all<{ c4_id: number }>(
              "select c4_id from contest_status where status = 'skipped' order by c4_id",
            )
            .map((row) => row.c4_id);
        } finally {
          jdb.close();
        }
      }

      let stats = null;
      if (existsSync(p.kgPath)) {
        const kdb = await openKg(p.kgPath);
        try {
          stats = readStats(kdb);
        } finally {
          kdb.close();
        }
      }

      return {
        content: JSON.stringify({ dataset, journal, stats }, null, 2),
      };
    },

    kg_query: async (input) => {
      const options = asRecord(input);
      const kind = asString(options.kind);
      const limit = asNumber(options.limit);
      const db = await openKg(p.kgPath);

      try {
        if (kind === "semantic") {
          const rows = querySemantics(db, {
            q: asString(options.q),
            category: asString(options.category),
            canonicalOnly: asBoolean(options.canonicalOnly),
            unlinkedOnly: asBoolean(options.unlinkedOnly),
            limit,
          });
          return { content: JSON.stringify({ kind, count: rows.length, results: rows }, null, 2) };
        }

        if (kind === "finding") {
          const rows = queryFindings(db, {
            q: asString(options.q),
            severity: asString(options.severity),
            category: asString(options.category),
            canonicalOnly: asBoolean(options.canonicalOnly),
            limit,
          });
          return { content: JSON.stringify({ kind, count: rows.length, results: rows }, null, 2) };
        }

        if (kind === "link") {
          const rows = queryLinks(db, {
            findingId: asNumber(options.findingId),
            semanticId: asNumber(options.semanticId),
            strength: asString(options.strength),
            findingSeverity: asString(options.findingSeverity),
            limit,
          });
          return { content: JSON.stringify({ kind, count: rows.length, results: rows }, null, 2) };
        }

        throw new Error("kg_query kind must be one of: semantic, finding, link");
      } finally {
        db.close();
      }
    },

    kg_stats: async () => {
      const db = await openKg(p.kgPath);
      try {
        return { content: JSON.stringify(readStats(db), null, 2) };
      } finally {
        db.close();
      }
    },
  };
}
