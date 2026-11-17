import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDataset } from "../../.opencode/plugins/knowdit/src/dataset/prepare.ts";

test("writes manifest, snapshot, id map, and trimmed report", async () => {
  const src = mkdtempSync(join(tmpdir(), "src-"));
  mkdirSync(join(src, "audits"), { recursive: true });
  mkdirSync(join(src, "reports"), { recursive: true });
  mkdirSync(join(src, "contracts", "1", "src"), { recursive: true });
  writeFileSync(join(src, "audits", "1.json"), JSON.stringify({ contestId: 1, title: "2022-01-insure" }));
  writeFileSync(join(src, "reports", "1.md"), '---\ncontest: 71\nslug: "2022-01-insure"\n---\n# Overview\no\n# High Risk Findings (1)\n## [H-01] x\n# Gas Optimizations\ng\n');
  writeFileSync(join(src, "contracts", "1", "src", "A.sol"), "contract A {}\n");
  const data = mkdtempSync(join(tmpdir(), "data-"));
  const m = await prepareDataset({ sourceRoot: src, dataDir: data, localIds: [1] });
  assert.equal(m.contests.length, 1);
  assert.equal(m.contests[0].c4Id, 71);
  assert.equal(m.contests[0].expected.high, 1);
  assert.equal(m.contests[0].report.trimFallback, false);
  assert.ok(!readFileSync(join(data, "dataset", "reports", "71.md"), "utf8").includes("# Gas Optimizations"));
  assert.ok(readFileSync(join(data, "dataset", "manifest.json"), "utf8").includes('"c4Id": 71'));
  assert.ok(readFileSync(join(data, "dataset", "id_map.json"), "utf8").includes('"71"'));
});
