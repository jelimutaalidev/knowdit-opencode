import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PIPELINE_VERSION } from "../.opencode/plugins/knowdit/src/version.ts";

export const SNAPSHOT_VERSION = 1;

export type FileDigest = { sha256: string; bytes: number };
export type TreeDigest = { sha256: string; files: number; bytes: number };

export type JournalInfo = {
  fingerprint: string | null;
  units: { total: number; done: number; failed: number; running: number };
  contests: { total: number; done: number; failed: number; skipped: number };
};

export type Identity = {
  snapshotVersion: typeof SNAPSHOT_VERSION;
  createdAt: string;
  commit: string | null;
  dirty: boolean | null;
  pipelineVersion: string;
  dataset: {
    manifestSha256: string;
    treeSha256: string;
    files: number;
    bytes: number;
    contests: number;
    generatedAt: string | null;
  };
  journal: JournalInfo;
  artifacts: {
    kg: FileDigest;
    runs: FileDigest;
    cache: TreeDigest | null;
  };
};

export type SnapshotOptions = {
  dataDir: string;
  outDir: string;
  repoDir?: string;
  force?: boolean;
  allowRunning?: boolean;
  allowDirty?: boolean;
  includeCache?: boolean;
};

export type RestoreOptions = {
  fromDir: string;
  dataDir: string;
  repoDir?: string;
  force?: boolean;
  allowDirty?: boolean;
};

export type RestoreResult = {
  identity: Identity;
  backupDir: string | null;
};

const CACHE_NAME = "cache";
const DATASET_NAME = "dataset";
const KG_NAME = "kg.sqlite";
const RUNS_NAME = "runs.sqlite";

function fail(message: string): never {
  throw new Error(message);
}

export function timestampForPath(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function fileDigest(path: string): FileDigest {
  return { sha256: sha256File(path), bytes: statSync(path).size };
}

/**
 * Deterministic digest of every file below `root`: relative path, content
 * hash, and size. Directory order does not affect the result.
 */
export function sha256Tree(root: string): TreeDigest {
  if (!existsSync(root)) fail(`tree not found: ${root}`);
  const files: { path: string; digest: string; bytes: number }[] = [];

  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(root, full).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        const target = readlinkSync(full);
        files.push({
          path: rel,
          digest: createHash("sha256").update(`link\0${target}`).digest("hex"),
          bytes: Buffer.byteLength(target),
        });
        continue;
      }
      const content = readFileSync(full);
      files.push({
        path: rel,
        digest: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
      });
    }
  };

  walk(root);
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path).update("\0").update(file.digest).update("\n");
  }
  return {
    sha256: hash.digest("hex"),
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
  };
}

export function copyTree(source: string, destination: string): void {
  if (!existsSync(source)) fail(`tree not found: ${source}`);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, preserveTimestamps: true });
}

/**
 * Consistent single-file backup for a SQLite database, including WAL content.
 * The source is opened read-only; the destination is a normal database file.
 */
export function backupSqlite(source: string, destination: string): void {
  if (!existsSync(source)) fail(`database not found: ${source}`);
  rmSync(destination, { force: true });
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${destination.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

function countByStatus(
  db: DatabaseSync,
  table: string,
): Record<string, number> {
  const rows = db
    .prepare(`select status, count(*) as n from ${table} group by status`)
    .all() as { status: string; n: number }[];
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = Number(row.n);
  return counts;
}

export function readJournalInfo(path: string): JournalInfo {
  if (!existsSync(path)) fail(`journal not found: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const hasJournal = db
      .prepare(
        "select 1 from sqlite_master where type = 'table' and name = 'journal_meta'",
      )
      .get();
    if (!hasJournal) {
      return {
        fingerprint: null,
        units: { total: 0, done: 0, failed: 0, running: 0 },
        contests: { total: 0, done: 0, failed: 0, skipped: 0 },
      };
    }

    const meta = db
      .prepare("select value from journal_meta where key = 'build_fingerprint'")
      .get() as { value: string } | undefined;
    const unitCounts = countByStatus(db, "unit_status");
    const contestCounts = countByStatus(db, "contest_status");

    const units = {
      total: Object.values(unitCounts).reduce((sum, n) => sum + n, 0),
      done: unitCounts.done ?? 0,
      failed: unitCounts.failed ?? 0,
      running: unitCounts.running ?? 0,
    };
    const contests = {
      total: Object.values(contestCounts).reduce((sum, n) => sum + n, 0),
      done: contestCounts.done ?? 0,
      failed: contestCounts.failed ?? 0,
      skipped: contestCounts.skipped ?? 0,
    };
    return { fingerprint: meta?.value ?? null, units, contests };
  } finally {
    db.close();
  }
}

export function readRepoInfo(repoDir: string): {
  commit: string | null;
  dirty: boolean | null;
} {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { commit, dirty: status.length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

function datasetInfo(directory: string): Identity["dataset"] {
  const manifestPath = join(directory, "manifest.json");
  if (!existsSync(manifestPath)) fail(`dataset manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    generatedAt?: unknown;
    contests?: unknown;
  };
  const tree = sha256Tree(directory);
  return {
    manifestSha256: sha256File(manifestPath),
    treeSha256: tree.sha256,
    files: tree.files,
    bytes: tree.bytes,
    contests: Array.isArray(manifest.contests) ? manifest.contests.length : 0,
    generatedAt:
      typeof manifest.generatedAt === "string" ? manifest.generatedAt : null,
  };
}

export function readIdentity(directory: string): Identity {
  const path = join(directory, "identity.json");
  if (!existsSync(path)) fail(`identity.json not found in ${directory}`);
  const identity = JSON.parse(readFileSync(path, "utf8")) as Identity;
  if (identity.snapshotVersion !== SNAPSHOT_VERSION) {
    fail(
      `unsupported snapshot version ${String(identity.snapshotVersion)}; expected ${SNAPSHOT_VERSION}`,
    );
  }
  return identity;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** True when either path is the other or one contains the other. */
function overlaps(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

/**
 * Capture a self-contained, verified bundle of the current build state.
 * The output is written atomically and the old bundle is kept until the new
 * one is complete.
 */
export function snapshotState(options: SnapshotOptions): Identity {
  const dataDir = resolve(options.dataDir);
  const outDir = resolve(options.outDir);
  const repoDir = resolve(options.repoDir ?? process.cwd());
  const includeCache = options.includeCache !== false;

  if (!existsSync(dataDir)) fail(`data directory not found: ${dataDir}`);
  if (overlaps(dataDir, outDir)) {
    fail("snapshot output must not overlap the data directory");
  }

  const kgPath = join(dataDir, KG_NAME);
  const runsPath = join(dataDir, RUNS_NAME);
  const datasetPath = join(dataDir, DATASET_NAME);
  const cachePath = join(dataDir, CACHE_NAME);
  if (!existsSync(kgPath)) fail(`knowledge graph not found: ${kgPath}`);
  if (!existsSync(runsPath)) fail(`journal not found: ${runsPath}`);
  if (!existsSync(datasetPath)) fail(`dataset not found: ${datasetPath}`);

  const repo = readRepoInfo(repoDir);
  if (repo.dirty && !options.allowDirty) {
    fail(
      "worktree is dirty; commit or stash before snapshotting, or pass --allow-dirty",
    );
  }

  const journal = readJournalInfo(runsPath);
  if (journal.units.running > 0 && !options.allowRunning) {
    fail(
      `journal has ${journal.units.running} running unit(s); stop the build, or pass --allow-running after a crash`,
    );
  }

  if (existsSync(outDir) && !options.force) {
    fail(`snapshot output already exists: ${outDir} (pass --force to replace it)`);
  }
  if (existsSync(outDir) && !existsSync(join(outDir, "identity.json"))) {
    fail(
      `refusing to replace ${outDir}: it is not a snapshot bundle (no identity.json)`,
    );
  }

  const tempDir = `${outDir}.tmp-${process.pid}`;
  let previousDir: string | null = null;
  rmSync(tempDir, { recursive: true, force: true });
  mkdirSync(tempDir, { recursive: true });

  try {
    backupSqlite(kgPath, join(tempDir, KG_NAME));
    backupSqlite(runsPath, join(tempDir, RUNS_NAME));
    copyTree(datasetPath, join(tempDir, DATASET_NAME));

    let cache: TreeDigest | null = null;
    if (includeCache && existsSync(cachePath)) {
      copyTree(cachePath, join(tempDir, CACHE_NAME));
      cache = sha256Tree(join(tempDir, CACHE_NAME));
    }

    const identity: Identity = {
      snapshotVersion: SNAPSHOT_VERSION,
      createdAt: new Date().toISOString(),
      commit: repo.commit,
      dirty: repo.dirty,
      pipelineVersion: PIPELINE_VERSION,
      dataset: datasetInfo(join(tempDir, DATASET_NAME)),
      journal,
      artifacts: {
        kg: fileDigest(join(tempDir, KG_NAME)),
        runs: fileDigest(join(tempDir, RUNS_NAME)),
        cache,
      },
    };
    writeFileSync(
      join(tempDir, "identity.json"),
      `${JSON.stringify(identity, null, 2)}\n`,
    );

    if (existsSync(outDir)) {
      previousDir = `${outDir}.old-${process.pid}`;
      rmSync(previousDir, { recursive: true, force: true });
      renameSync(outDir, previousDir);
    }
    try {
      renameSync(tempDir, outDir);
    } catch (error) {
      if (previousDir) renameSync(previousDir, outDir);
      throw error;
    }
    if (previousDir) rmSync(previousDir, { recursive: true, force: true });
    return identity;
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    if (previousDir && !existsSync(outDir)) renameSync(previousDir, outDir);
    throw error;
  }
}

function verifyBundle(directory: string, identity: Identity): void {
  const kgDigest = fileDigest(join(directory, KG_NAME));
  if (kgDigest.sha256 !== identity.artifacts.kg.sha256) {
    fail("bundle KG hash does not match identity.json");
  }
  const runsDigest = fileDigest(join(directory, RUNS_NAME));
  if (runsDigest.sha256 !== identity.artifacts.runs.sha256) {
    fail("bundle journal hash does not match identity.json");
  }

  const dataset = datasetInfo(join(directory, DATASET_NAME));
  if (
    dataset.manifestSha256 !== identity.dataset.manifestSha256 ||
    dataset.treeSha256 !== identity.dataset.treeSha256
  ) {
    fail("bundle dataset hash does not match identity.json");
  }

  if (identity.artifacts.cache) {
    const cache = sha256Tree(join(directory, CACHE_NAME));
    if (cache.sha256 !== identity.artifacts.cache.sha256) {
      fail("bundle cache hash does not match identity.json");
    }
  }
}

function sameJournal(left: JournalInfo, right: JournalInfo): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.units.total === right.units.total &&
    left.units.done === right.units.done &&
    left.units.failed === right.units.failed &&
    left.units.running === right.units.running &&
    left.contests.total === right.contests.total &&
    left.contests.done === right.contests.done &&
    left.contests.failed === right.contests.failed &&
    left.contests.skipped === right.contests.skipped
  );
}

function verifyRestored(dataDir: string, identity: Identity): void {
  const actual = readJournalInfo(join(dataDir, RUNS_NAME));
  if (!sameJournal(actual, identity.journal)) {
    fail("restored journal does not match identity.json");
  }
  const kgDigest = fileDigest(join(dataDir, KG_NAME));
  if (kgDigest.sha256 !== identity.artifacts.kg.sha256) {
    fail("restored KG hash does not match identity.json");
  }
  const dataset = datasetInfo(join(dataDir, DATASET_NAME));
  if (
    dataset.manifestSha256 !== identity.dataset.manifestSha256 ||
    dataset.treeSha256 !== identity.dataset.treeSha256
  ) {
    fail("restored dataset hash does not match identity.json");
  }
  if (identity.artifacts.cache) {
    const cache = sha256Tree(join(dataDir, CACHE_NAME));
    if (cache.sha256 !== identity.artifacts.cache.sha256) {
      fail("restored cache hash does not match identity.json");
    }
  }
}

function statePaths(dataDir: string): string[] {
  return [
    KG_NAME,
    "kg.sqlite-wal",
    "kg.sqlite-shm",
    RUNS_NAME,
    "runs.sqlite-wal",
    "runs.sqlite-shm",
    DATASET_NAME,
    CACHE_NAME,
  ].map((name) => join(dataDir, name));
}

/**
 * Restore a bundle after verifying every digest and the build identity.
 * Existing state is moved into a backup directory, not deleted; scratch files
 * such as data/tmp and data/llm-scratch are never touched.
 */
export function restoreState(options: RestoreOptions): RestoreResult {
  const fromDir = resolve(options.fromDir);
  const dataDir = resolve(options.dataDir);
  const repoDir = resolve(options.repoDir ?? process.cwd());

  if (overlaps(dataDir, fromDir)) {
    fail("bundle must not overlap the target data directory");
  }

  const identity = readIdentity(fromDir);
  verifyBundle(fromDir, identity);

  const repo = readRepoInfo(repoDir);
  if (identity.commit && repo.commit !== identity.commit) {
    fail(
      `bundle was created at commit ${identity.commit}, but this checkout is ${repo.commit ?? "not a git repository"}; check out the matching commit`,
    );
  }
  if (identity.dirty && !options.allowDirty) {
    fail("bundle was captured from a dirty worktree; pass --allow-dirty to accept it");
  }
  if (repo.dirty && !options.allowDirty) {
    fail("worktree is dirty; commit or stash before restoring, or pass --allow-dirty");
  }
  if (identity.pipelineVersion !== PIPELINE_VERSION) {
    fail(
      `bundle pipeline version ${identity.pipelineVersion} does not match ${PIPELINE_VERSION}`,
    );
  }

  const paths = statePaths(dataDir);
  const hasState = paths.some((path) => existsSync(path));
  if (hasState && !options.force) {
    fail(`target already contains build state: ${dataDir} (pass --force to replace it)`);
  }

  mkdirSync(dataDir, { recursive: true });
  let backupDir: string | null = null;
  if (hasState) {
    backupDir = join(
      dataDir,
      `.restore-backup-${timestampForPath()}-${process.pid}`,
    );
    while (existsSync(backupDir)) backupDir = `${backupDir}-x`;
    mkdirSync(backupDir, { recursive: true });
    for (const path of paths) {
      if (existsSync(path)) renameSync(path, join(backupDir, basename(path)));
    }
  }

  const restored: string[] = [];
  try {
    copyFileSync(join(fromDir, KG_NAME), join(dataDir, KG_NAME));
    restored.push(join(dataDir, KG_NAME));
    copyFileSync(join(fromDir, RUNS_NAME), join(dataDir, RUNS_NAME));
    restored.push(join(dataDir, RUNS_NAME));
    copyTree(join(fromDir, DATASET_NAME), join(dataDir, DATASET_NAME));
    restored.push(join(dataDir, DATASET_NAME));
    if (existsSync(join(fromDir, CACHE_NAME))) {
      copyTree(join(fromDir, CACHE_NAME), join(dataDir, CACHE_NAME));
      restored.push(join(dataDir, CACHE_NAME));
    }

    verifyRestored(dataDir, identity);
    return { identity, backupDir };
  } catch (error) {
    for (const path of statePaths(dataDir)) {
      rmSync(path, { recursive: true, force: true });
    }
    if (backupDir) {
      for (const name of readdirSync(backupDir)) {
        renameSync(join(backupDir, name), join(dataDir, name));
      }
      rmSync(backupDir, { recursive: true, force: true });
    }
    throw error;
  }
}

const BOOLEAN_FLAGS = new Set([
  "force",
  "allow-running",
  "allow-dirty",
  "no-cache",
  "help",
]);

export type Flags = Record<string, string | boolean>;

export function parseFlags(
  argv: readonly string[],
  known?: ReadonlySet<string>,
): Flags {
  const flags: Flags = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) fail(`unexpected argument: ${arg}`);
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (known && !known.has(name)) fail(`unknown option: --${name}`);
    if (eq >= 0) {
      flags[name] = body.slice(eq + 1);
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      fail(`--${name} requires a value`);
    }
    flags[name] = value;
  }
  return flags;
}

export function defaultSnapshotDir(
  date = new Date(),
  fingerprint?: string | null,
): string {
  const group = fingerprint ? `fp-${fingerprint.slice(0, 12)}` : "nofp";
  return join(homedir(), "knowdit-state", group, timestampForPath(date));
}
