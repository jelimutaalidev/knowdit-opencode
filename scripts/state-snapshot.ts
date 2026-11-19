#!/usr/bin/env node
/**
 * Capture a verified, self-contained snapshot of the current build state.
 *
 * Usage:
 *   node scripts/state-snapshot.ts [--data <dir>] [--out <dir>] [--repo <dir>]
 *                                  [--force] [--allow-running] [--allow-dirty]
 *                                  [--no-cache]
 */
import { resolve, join } from "node:path";
import {
  defaultSnapshotDir,
  parseFlags,
  readJournalInfo,
  snapshotState,
} from "./state.ts";

const KNOWN = new Set([
  "data",
  "out",
  "repo",
  "force",
  "allow-running",
  "allow-dirty",
  "no-cache",
  "help",
]);

function usage(): string {
  return [
    "Capture a verified snapshot of the KNOWDIT build state.",
    "",
    "Options:",
    "  --data <dir>     data directory (default: ./data)",
    "  --out <dir>      snapshot directory (default: ~/knowdit-state/fp-<id>/<timestamp>)",
    "  --repo <dir>     repository root (default: current directory)",
    "  --force          replace an existing snapshot directory",
    "  --allow-running  allow snapshotting a journal with running units (crash recovery)",
    "  --allow-dirty    allow snapshotting an uncommitted worktree",
    "  --no-cache       omit data/cache from the bundle",
    "  --help           show this message",
    "",
    "The bundle contains kg.sqlite, runs.sqlite, dataset/, cache/, and identity.json.",
    "Transfer it with rsync or rclone; never commit build state.",
  ].join("\n");
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

const flags: Record<string, string | boolean> = (() => {
  try {
    return parseFlags(process.argv.slice(2), KNOWN);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(usage());
    process.exit(2);
  }
})();

if (flags.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const dataDir = resolve(stringFlag(flags, "data") ?? "data");
  const explicitOut = stringFlag(flags, "out");
  let outDir: string;
  if (explicitOut) {
    outDir = resolve(explicitOut);
  } else {
    let fingerprint: string | null = null;
    try {
      fingerprint = readJournalInfo(join(dataDir, "runs.sqlite")).fingerprint;
    } catch {
      fingerprint = null;
    }
    outDir = defaultSnapshotDir(new Date(), fingerprint);
  }
  const repoDir = resolve(stringFlag(flags, "repo") ?? process.cwd());

  const identity = snapshotState({
    dataDir,
    outDir,
    repoDir,
    force: flags.force === true,
    allowRunning: flags["allow-running"] === true,
    allowDirty: flags["allow-dirty"] === true,
    includeCache: flags["no-cache"] !== true,
  });

  console.log(`snapshot: ${outDir}`);
  console.log(`commit: ${identity.commit ?? "unknown"}${identity.dirty ? " (dirty)" : ""}`);
  console.log(`pipeline: ${identity.pipelineVersion}`);
  console.log(`fingerprint: ${identity.journal.fingerprint ?? "none"}`);
  console.log(
    `units: ${identity.journal.units.done}/${identity.journal.units.total} done, ` +
      `${identity.journal.units.failed} failed, ${identity.journal.units.running} running`,
  );
  console.log(
    `dataset: ${identity.dataset.contests} contest(s), manifest ${identity.dataset.manifestSha256.slice(0, 12)}`,
  );
  console.log(
    `bundle: kg ${identity.artifacts.kg.sha256.slice(0, 12)}, ` +
      `runs ${identity.artifacts.runs.sha256.slice(0, 12)}`,
  );
} catch (error) {
  console.error(`snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
