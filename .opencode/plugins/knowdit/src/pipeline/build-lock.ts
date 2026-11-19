import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname } from "node:path";

/**
 * A build mutates the KG and the journal across many transactions and awaits
 * model calls in between. Two builds sharing those files interleave their
 * writes: the second one re-extracts rows the first has not inserted yet, so
 * both sets land and the KG ends up with duplicate findings and semantics.
 *
 * The lock is advisory but checked before any mutation. It records the owner
 * so a resume can distinguish an active writer from a crashed one.
 */
export type BuildLockInfo = {
  pid: number;
  hostname: string;
  runId: string;
  startedAt: string;
};

export type BuildLock = {
  path: string;
  info: BuildLockInfo;
  /** Remove the file only when this run still owns it. */
  release(): void;
};

export class BuildLockError extends Error {
  readonly path: string;
  readonly holder: BuildLockInfo | null;

  constructor(message: string, path: string, holder: BuildLockInfo | null) {
    super(message);
    this.name = "BuildLockError";
    this.path = path;
    this.holder = holder;
  }
}

type AcquireOptions = {
  pid?: number;
  hostname?: string;
  runId?: string;
  now?: () => Date;
  /** Test hook: overrides liveness detection for a pid on this host. */
  isAlive?: (pid: number) => boolean;
};

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 checks existence and permission without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readBuildLock(path: string): BuildLockInfo | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const info = parsed as Partial<BuildLockInfo> | null;
  if (
    !info ||
    !Number.isInteger(info.pid) ||
    (info.pid as number) <= 0 ||
    typeof info.hostname !== "string" ||
    info.hostname.length === 0 ||
    typeof info.runId !== "string" ||
    info.runId.length === 0 ||
    typeof info.startedAt !== "string"
  ) {
    return null;
  }

  return {
    pid: info.pid as number,
    hostname: info.hostname,
    runId: info.runId,
    startedAt: info.startedAt,
  };
}

function describe(holder: BuildLockInfo): string {
  return `pid ${holder.pid} on ${holder.hostname} (run ${holder.runId}, started ${holder.startedAt})`;
}

/**
 * Take the single-writer build lock.
 *
 * - A live writer on this host is refused.
 * - A writer on another host is refused: its liveness cannot be checked here.
 * - A dead writer on this host (crash or SIGKILL) is recovered.
 *
 * An unreadable lock fails closed; it may be a partially written file, so the
 * operator is told which path to inspect rather than guessing.
 */
export function acquireBuildLock(path: string, opts: AcquireOptions = {}): BuildLock {
  const owner: BuildLockInfo = {
    pid: opts.pid ?? process.pid,
    hostname: opts.hostname ?? hostname(),
    runId: opts.runId ?? randomUUID(),
    startedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  const isAlive = opts.isAlive ?? isProcessAlive;

  mkdirSync(dirname(path), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
      return {
        path,
        info: owner,
        release() {
          const current = readBuildLock(path);
          if (current === null || current.runId !== owner.runId) return;
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const holder = readBuildLock(path);
    if (holder === null) {
      throw new BuildLockError(
        `build lock at ${path} exists but is unreadable. ` +
          "If no knowdit build is running, remove that file and retry.",
        path,
        null,
      );
    }

    if (holder.hostname !== owner.hostname) {
      throw new BuildLockError(
        `build lock is held by another host: ${describe(holder)}. ` +
          `Stop that build or remove ${path} once it is safe.`,
        path,
        holder,
      );
    }

    if (isAlive(holder.pid)) {
      throw new BuildLockError(
        `another knowdit build is already running: ${describe(holder)}. ` +
          "Wait for it to finish (or fail) before resuming; do not start a second writer.",
        path,
        holder,
      );
    }

    // The pid is dead on this host, so the writer crashed without releasing.
    rmSync(path, { force: true });
  }

  throw new BuildLockError(
    `could not acquire the build lock at ${path} after recovering a stale owner`,
    path,
    readBuildLock(path),
  );
}
