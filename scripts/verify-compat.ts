import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { openKg } from "../.opencode/plugins/knowdit/src/db/client.ts";
import { readStats, type KgStatsSubset } from "../.opencode/plugins/knowdit/src/stats.ts";
import { backupSqlite } from "./state.ts";

type Expectation = {
  field: keyof KgStatsSubset;
  pattern: RegExp;
  group: number;
  label: string;
};

const EXPECTATIONS: Expectation[] = [
  { field: "projectsTotal", pattern: /^projects: (\d+) \(/m, group: 1, label: "projects" },
  {
    field: "semanticsTotal",
    pattern: /^semantics: (\d+) raw = (\d+) canonical \+ \d+ folded/m,
    group: 1,
    label: "semantics raw",
  },
  {
    field: "semanticsCanonical",
    pattern: /^semantics: \d+ raw = (\d+) canonical \+ \d+ folded/m,
    group: 1,
    label: "semantics canonical",
  },
  {
    field: "findingsTotal",
    pattern: /^findings:\s+(\d+) raw = (\d+) canonical \+ \d+ folded/m,
    group: 1,
    label: "findings raw",
  },
  {
    field: "findingsCanonical",
    pattern: /^findings:\s+\d+ raw = (\d+) canonical \+ \d+ folded/m,
    group: 1,
    label: "findings canonical",
  },
  {
    field: "linkProcessedFindings",
    pattern: /^pipeline: link-processed findings (\d+)\/\d+ \| pending semantics \d+/m,
    group: 1,
    label: "link-processed findings",
  },
  {
    field: "pendingSemantics",
    pattern: /^pipeline: link-processed findings \d+\/\d+ \| pending semantics (\d+)/m,
    group: 1,
    label: "pending semantics",
  },
  {
    field: "linksTotal",
    pattern: /^links: (\d+) total = \d+ in-project \+ \d+ cross-project/m,
    group: 1,
    label: "links total",
  },
  {
    field: "linksInProject",
    pattern: /^links: \d+ total = (\d+) in-project \+ \d+ cross-project/m,
    group: 1,
    label: "links in-project",
  },
  {
    field: "linksCross",
    pattern: /^links: \d+ total = \d+ in-project \+ (\d+) cross-project/m,
    group: 1,
    label: "links cross-project",
  },
];

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): never {
  process.stderr.write(`compat FAIL: ${message}\n`);
  process.exit(1);
}

function run(binary: string, args: string[]): string {
  try {
    return execFileSync(binary, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    if (failure.stdout) process.stderr.write(failure.stdout);
    if (failure.stderr) process.stderr.write(failure.stderr);
    fail(`command failed with exit ${failure.status ?? "?"}: ${args.join(" ")}`);
  }
}

const dbArg = flag("db");
if (!dbArg) fail("usage: node scripts/verify-compat.ts --db <path> [--binary <path>]");

const dbPath = isAbsolute(dbArg) ? dbArg : resolve(process.cwd(), dbArg);
if (!existsSync(dbPath)) fail(`database not found at ${dbPath}`);

const binary =
  flag("binary") ??
  process.env.KNOWDIT_BINARY ??
  join(homedir(), "Dev", "knowdit", "target", "release", "knowdit");
if (!existsSync(binary)) {
  fail(`reference binary not found at ${binary}; pass --binary or set KNOWDIT_BINARY`);
}

// The reference validator opens the database read-write (WAL mode + header
// rewrite), and openKg applies the schema. Both mutate the file without
// changing any row, so validating the caller's file directly would corrupt a
// snapshot bundle's identity hashes. Work on a consistent copy instead.
const scratchDir = mkdtempSync(join(tmpdir(), "knowdit-compat-"));
process.on("exit", () => rmSync(scratchDir, { recursive: true, force: true }));
const copyPath = join(scratchDir, "kg.sqlite");
backupSqlite(dbPath, copyPath);

const databaseUrl = `sqlite://${copyPath}?mode=rwc`;

const validateOutput = run(binary, [
  "learn",
  "--database-url",
  databaseUrl,
  "validate-db",
]);

const snapshotPath = join(scratchDir, "snapshot.json");

try {
  run(binary, [
    "db",
    "snapshot",
    "--database-url",
    databaseUrl,
    "--format",
    "json",
    "--output",
    snapshotPath,
  ]);

  if (!existsSync(snapshotPath)) fail("db snapshot did not write its output file");
  try {
    JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch {
    fail("db snapshot output is not valid JSON");
  }
} finally {
  // Keep the database copy: readStats still needs it. The exit handler above
  // removes the whole scratch directory.
  rmSync(snapshotPath, { force: true });
}

const db = await openKg(copyPath);
let actual: KgStatsSubset;
try {
  actual = readStats(db);
} finally {
  db.close();
}

const mismatches: string[] = [];

for (const expectation of EXPECTATIONS) {
  const match = expectation.pattern.exec(validateOutput);
  if (!match) {
    mismatches.push(`${expectation.label}: line not found in validate-db output`);
    continue;
  }
  const expected = Number(match[expectation.group]);
  if (expected !== actual[expectation.field]) {
    mismatches.push(
      `${expectation.label}: reference ${expected} != readStats ${actual[expectation.field]}`,
    );
  }
}

if (mismatches.length > 0) {
  for (const mismatch of mismatches) process.stderr.write(`${mismatch}\n`);
  fail(`${mismatches.length} mismatch(es)`);
}

process.stdout.write("compat OK\n");
