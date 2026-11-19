import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { LlmCaller } from "../../.opencode/plugins/knowdit/src/llm/types.ts";
import {
  acquireBuildLock,
  readBuildLock,
} from "../../.opencode/plugins/knowdit/src/pipeline/build-lock.ts";
import { buildKg } from "../../.opencode/plugins/knowdit/src/pipeline/build.ts";
import { fakeBuild } from "../helpers/build.ts";

async function withTempDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "build-lock-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("acquires a free lock and releases it", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ".build.lock");

    const lock = acquireBuildLock(path);

    const info = readBuildLock(path);
    assert.equal(info?.pid, process.pid);
    assert.equal(info?.hostname, hostname());
    assert.equal(info?.runId, lock.info.runId);
    assert.match(info?.startedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

    lock.release();
    assert.equal(existsSync(path), false);
  });
});

test("refuses a lock held by a live process on this host", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ".build.lock");
    const first = acquireBuildLock(path);

    assert.throws(() => acquireBuildLock(path), /already running|build lock/i);

    first.release();
  });
});

test("recovers a lock left behind by a dead process on this host", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ".build.lock");
    const child = spawnSync(process.execPath, ["-e", ""]);
    assert.ok(child.pid, "child process should have a pid");

    writeFileSync(
      path,
      JSON.stringify({
        pid: child.pid,
        hostname: hostname(),
        runId: "dead-run",
        startedAt: new Date().toISOString(),
      }),
    );

    const lock = acquireBuildLock(path);

    assert.notEqual(lock.info.runId, "dead-run");
    assert.equal(readBuildLock(path)?.runId, lock.info.runId);
    lock.release();
  });
});

test("refuses a lock held by another host even when its pid is unknown here", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ".build.lock");
    writeFileSync(
      path,
      JSON.stringify({
        pid: 1,
        hostname: "another-machine",
        runId: "remote-run",
        startedAt: new Date().toISOString(),
      }),
    );

    assert.throws(() => acquireBuildLock(path), /another host|build lock/i);
  });
});

test("does not delete a lock that was replaced by another run", async () => {
  await withTempDir((dir) => {
    const path = join(dir, ".build.lock");
    const lock = acquireBuildLock(path);

    writeFileSync(
      path,
      JSON.stringify({
        pid: process.pid,
        hostname: hostname(),
        runId: "replacement-run",
        startedAt: new Date().toISOString(),
      }),
    );
    lock.release();

    assert.equal(readBuildLock(path)?.runId, "replacement-run");
  });
});

test("a second build is refused while the first holds the lock", async () => {
  const { deps } = await fakeBuild({ contests: [229] });
  const base = deps.llm;
  let entered!: () => void;
  const enteredFirstCall = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let held = false;
  const blocking = {
    async json<T>(input: {
      prompt: string;
      validate: (value: unknown) => T;
      key?: string;
    }): Promise<{ value: T; tokensEst: number; costEst: number }> {
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return base.json(input);
    },
  } as LlmCaller;

  const first = buildKg({ ...deps, llm: blocking });
  await enteredFirstCall;

  await assert.rejects(() => buildKg({ ...deps }), /already running|build lock/i);

  unblock();
  const result = await first;
  assert.equal(result.integrity.ok, true);
});

test("a failed build releases the lock so a retry can start", async () => {
  const { deps } = await fakeBuild({ contests: [229] });
  const failing = {
    async json(): Promise<never> {
      throw new Error("model exploded");
    },
  } as LlmCaller;

  await assert.rejects(() => buildKg({ ...deps, llm: failing }), /model exploded/);
  assert.equal(existsSync(join(deps.dataDir, ".build.lock")), false);

  const result = await buildKg({ ...deps });
  assert.equal(result.integrity.ok, true);
});

test("a resumed build reuses rows from an interrupted unit instead of duplicating", async () => {
  const { deps } = await fakeBuild({ contests: [229] });
  await buildKg({ ...deps });

  const counts = () => ({
    semantics: deps.db.get<{ n: number }>("select count(*) n from semantic_node")!.n,
    findings: deps.db.get<{ n: number }>("select count(*) n from audit_finding")!.n,
    projectSemantics: deps.db.get<{ n: number }>("select count(*) n from project_semantic")!.n,
    projectFindings: deps.db.get<{ n: number }>("select count(*) n from project_finding")!.n,
  });
  const before = counts();

  // Simulate a crash after the rows landed but before the journal recorded the
  // unit as done: the next run retries the unit in place.
  deps.journal.start({ stage: "semantics", c4Id: 229, unitIndex: 0 });
  deps.journal.start({ stage: "findings", c4Id: 229, unitIndex: 0 });

  const result = await buildKg({ ...deps });

  assert.equal(result.integrity.ok, true);
  assert.deepEqual(counts(), before);
});

test("leaves a readable lock file behind for the status tool", async () => {
  const { deps } = await fakeBuild({ contests: [229] });
  const lockPath = join(deps.dataDir, ".build.lock");

  const base = deps.llm;
  let entered!: () => void;
  const enteredFirstCall = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let held = false;
  const blocking = {
    async json<T>(input: {
      prompt: string;
      validate: (value: unknown) => T;
      key?: string;
    }): Promise<{ value: T; tokensEst: number; costEst: number }> {
      if (!held) {
        held = true;
        entered();
        await gate;
      }
      return base.json(input);
    },
  } as LlmCaller;

  const first = buildKg({ ...deps, llm: blocking });
  await enteredFirstCall;

  const onDisk = JSON.parse(readFileSync(lockPath, "utf8")) as {
    pid: number;
    hostname: string;
    runId: string;
  };
  assert.equal(onDisk.pid, process.pid);
  assert.equal(onDisk.hostname, hostname());
  assert.ok(onDisk.runId.length > 0);

  unblock();
  await first;
  assert.equal(existsSync(lockPath), false);
});
