import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Snapshot discovery for `kg_status`.
 *
 * Bundles are written by `npm run state:snapshot` under
 * `~/knowdit-state/<group>/<timestamp>`. There is no pointer file: a pointer
 * can go stale after a restore, a manual move, or a crash, so status reports
 * the newest bundle it can actually read instead.
 *
 * The scan is intentionally bounded. It walks at most `maxDepth` levels, skips
 * hidden directories and symlinks, and stops after `maxCandidates` readable
 * bundles. When it stops early we say so (`truncated`) rather than silently
 * reporting an older bundle as the latest.
 */

export const SNAPSHOT_VERSION = 1;

export type SnapshotUnits = {
  total: number;
  done: number;
  failed: number;
  running: number;
};

export type SnapshotSummary = {
  path: string;
  createdAt: string;
  ageSeconds: number;
  commit: string | null;
  pipelineVersion: string | null;
  fingerprint: string | null;
  units: SnapshotUnits;
};

export type LatestSnapshot = {
  found: boolean;
  root: string;
  truncated: boolean;
  latest: SnapshotSummary | null;
};

export type FindLatestSnapshotOptions = {
  root: string;
  /** Levels below the root to inspect; the root itself is depth 0. */
  maxDepth?: number;
  maxCandidates?: number;
  now?: Date;
};

const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_CANDIDATES = 200;

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

type FoundSnapshot = { summary: SnapshotSummary; createdMs: number };

function readSnapshot(directory: string, nowMs: number): FoundSnapshot | null {
  const identityPath = join(directory, "identity.json");

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(identityPath, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;

  const identity = parsed as Record<string, unknown>;
  if (identity.snapshotVersion !== SNAPSHOT_VERSION) return null;

  const journal = identity.journal;
  if (journal === null || typeof journal !== "object") return null;
  const journalRecord = journal as Record<string, unknown>;

  const unitsValue = journalRecord.units;
  const units =
    unitsValue !== null && typeof unitsValue === "object"
      ? (unitsValue as Record<string, unknown>)
      : {};

  const createdAtRaw =
    typeof identity.createdAt === "string" ? identity.createdAt : null;

  let createdMs = createdAtRaw === null ? Number.NaN : Date.parse(createdAtRaw);
  let createdAt = createdAtRaw;
  if (!Number.isFinite(createdMs) || createdAt === null) {
    try {
      createdMs = statSync(identityPath).mtimeMs;
    } catch {
      return null;
    }
    createdAt = new Date(createdMs).toISOString();
  }

  return {
    createdMs,
    summary: {
      path: directory,
      createdAt,
      ageSeconds: Math.max(0, Math.floor((nowMs - createdMs) / 1000)),
      commit: typeof identity.commit === "string" ? identity.commit : null,
      pipelineVersion:
        typeof identity.pipelineVersion === "string"
          ? identity.pipelineVersion
          : null,
      fingerprint:
        typeof journalRecord.fingerprint === "string"
          ? journalRecord.fingerprint
          : null,
      units: {
        total: asCount(units.total),
        done: asCount(units.done),
        failed: asCount(units.failed),
        running: asCount(units.running),
      },
    },
  };
}

export function findLatestSnapshot(
  options: FindLatestSnapshotOptions,
): LatestSnapshot {
  const root = resolve(options.root);
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxCandidates = options.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const nowMs = (options.now ?? new Date()).getTime();

  const found: FoundSnapshot[] = [];
  let truncated = false;
  let stop = false;

  const walk = (directory: string, depth: number): void => {
    if (stop) return;

    const snapshot = readSnapshot(directory, nowMs);
    if (snapshot !== null) {
      if (found.length >= maxCandidates) {
        // There is at least one more bundle than we agreed to inspect.
        truncated = true;
        stop = true;
        return;
      }
      found.push(snapshot);
    }

    if (depth >= maxDepth) return;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );

    for (const entry of entries) {
      if (stop) return;
      // Hidden directories hold partial writes and scratch bundles.
      if (entry.name.startsWith(".")) continue;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      walk(join(directory, entry.name), depth + 1);
    }
  };

  walk(root, 0);

  const latest =
    found.length === 0
      ? null
      : found.sort(
          (left, right) =>
            right.createdMs - left.createdMs ||
            (left.summary.path < right.summary.path
              ? -1
              : left.summary.path > right.summary.path
                ? 1
                : 0),
        )[0].summary;

  return { found: latest !== null, root, truncated, latest };
}
