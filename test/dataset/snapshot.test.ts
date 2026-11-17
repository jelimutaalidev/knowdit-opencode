import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VENDORED_EXCLUDES, isExcluded, writeSnapshot } from "../../.opencode/plugins/knowdit/src/dataset/snapshot.ts";

test("has the 42 vendored exclude patterns", () => {
  assert.equal(VENDORED_EXCLUDES.length, 42);
  assert.equal(isExcluded("lib/forge-std/src/Test.sol"), true);
  assert.equal(isExcluded("node_modules/pkg/A.sol"), true);
  assert.equal(isExcluded("src/vendor/A.sol"), true);
  assert.equal(isExcluded("test/ATest.sol"), true);
  assert.equal(isExcluded("src/A.sol"), false);
});

test("copies only core solidity files and records hashes", async () => {
  const src = mkdtempSync(join(tmpdir(), "repo-"));
  mkdirSync(join(src, "src"), { recursive: true });
  mkdirSync(join(src, "lib", "dep"), { recursive: true });
  writeFileSync(join(src, "src", "A.sol"), "contract A {}\n");
  writeFileSync(join(src, "lib", "dep", "B.sol"), "contract B {}\n");
  const out = mkdtempSync(join(tmpdir(), "snap-"));
  const r = await writeSnapshot(
    { localId: 7, c4Id: 229, slug: "s", title: "t", repoDir: src, reportPath: null },
    out,
  );
  assert.deepEqual(r.files.map((f) => f.path), ["src/A.sol"]);
  assert.equal(r.coreLoc, 1);
  assert.equal(r.files[0].bytes, 14);
  assert.equal(r.files[0].origin, "src/A.sol");
  assert.equal(readFileSync(join(out, "src", "A.sol"), "utf8"), "contract A {}\n");
  assert.equal(r.files[0].sha256.length, 64);
});
