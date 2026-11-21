import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openKg, seedReferenceTables } from "../../.opencode/plugins/knowdit/src/db/client.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("verify-compat validates a copy and leaves the input database untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "compat-input-"));
  const dbPath = join(dir, "kg.sqlite");
  const db = await openKg(dbPath);
  seedReferenceTables(db);
  db.close();

  const calls = join(dir, "calls.log");
  const fake = join(dir, "fake-knowdit");
  writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, args.join(" ") + "\\n");
const url = args[args.indexOf("--database-url") + 1];
const path = url.replace(/^sqlite:\\/\\//, "").replace(/\\?.*$/, "");
if (args.includes("validate-db")) {
  // Mimic the reference binary opening the database read-write: the journal
  // mode and header change counter are rewritten even with no row changes.
  const { DatabaseSync } = require("node:sqlite");
  const target = new DatabaseSync(path);
  target.exec("PRAGMA journal_mode = WAL");
  target.exec("PRAGMA user_version = 42");
  target.close();
  process.stdout.write("projects: 0 (\\n");
  process.stdout.write("semantics: 0 raw = 0 canonical + 0 folded\\n");
  process.stdout.write("findings: 0 raw = 0 canonical + 0 folded\\n");
  process.stdout.write("pipeline: link-processed findings 0/0 | pending semantics 0\\n");
  process.stdout.write("links: 0 total = 0 in-project + 0 cross-project\\n");
} else if (args.includes("snapshot")) {
  fs.writeFileSync(args[args.indexOf("--output") + 1], "{}");
}
`,
  );
  chmodSync(fake, 0o755);

  const before = sha256(dbPath);
  const output = execFileSync(
    process.execPath,
    ["scripts/verify-compat.ts", "--db", dbPath, "--binary", fake],
    { cwd: repoRoot, encoding: "utf8" },
  );

  assert.equal(output.trim(), "compat OK");
  assert.equal(sha256(dbPath), before, "input database bytes must not change");

  const log = readFileSync(calls, "utf8");
  assert.ok(log.includes("validate-db"), "the reference validator must run");
  assert.ok(!log.includes(dbPath), "the reference binary must run against a copy, not the input");
});
