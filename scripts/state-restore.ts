#!/usr/bin/env node
/**
 * Restore a verified snapshot of the KNOWDIT build state.
 *
 * Usage:
 *   node scripts/state-restore.ts --from <dir> [--data <dir>] [--repo <dir>]
 *                                 [--force] [--allow-dirty]
 */
import { resolve } from "node:path";
import { parseFlags, restoreState } from "./state.ts";

const KNOWN = new Set([
  "from",
  "data",
  "repo",
  "force",
  "allow-dirty",
  "help",
]);

function usage(): string {
  return [
    "Restore a verified KNOWDIT build-state snapshot.",
    "",
    "Options:",
    "  --from <dir>   snapshot directory containing identity.json (required)",
    "  --data <dir>   target data directory (default: ./data)",
    "  --repo <dir>   repository root (default: current directory)",
    "  --force        replace existing build state after backing it up",
    "  --allow-dirty  allow a dirty worktree or a bundle captured from one",
    "  --help         show this message",
    "",
    "Every digest and the build identity are verified before the target is",
    "touched. Existing state is moved to data/.restore-backup-<timestamp>-<pid>,",
    "never deleted. Scratch files (tmp/, llm-scratch/, progress.log) are kept.",
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

const from = stringFlag(flags, "from");
if (!from) {
  console.error("--from is required");
  console.error(usage());
  process.exit(2);
}

try {
  const result = restoreState({
    fromDir: resolve(from),
    dataDir: resolve(stringFlag(flags, "data") ?? "data"),
    repoDir: resolve(stringFlag(flags, "repo") ?? process.cwd()),
    force: flags.force === true,
    allowDirty: flags["allow-dirty"] === true,
  });

  console.log(`restored: ${resolve(stringFlag(flags, "data") ?? "data")}`);
  console.log(`commit: ${result.identity.commit ?? "unknown"}`);
  console.log(`pipeline: ${result.identity.pipelineVersion}`);
  console.log(`fingerprint: ${result.identity.journal.fingerprint ?? "none"}`);
  console.log(
    `units: ${result.identity.journal.units.done}/${result.identity.journal.units.total} done, ` +
      `${result.identity.journal.units.failed} failed`,
  );
  if (result.backupDir) console.log(`previous state: ${result.backupDir}`);
  console.log("next: restart OpenCode, then run knowdit_kg_status and resume the build.");
} catch (error) {
  console.error(`restore failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
