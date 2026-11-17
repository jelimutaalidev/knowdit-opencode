import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readContests, selectContests, BATCH_LOCAL_IDS } from "../../.opencode/plugins/knowdit/src/dataset/select.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ds-"));
  mkdirSync(join(root, "audits"), { recursive: true });
  writeFileSync(join(root, "audits", "1.json"), JSON.stringify({ contestId: 1, title: "2022-01-insure" }));
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports", "1.md"), '---\nslug: "2022-01-insure"\ncontest: 71\n---\n# Overview\nx\n# High Risk Findings (1)\n## [H-01] h\n');
  mkdirSync(join(root, "contracts", "1", "src"), { recursive: true });
  writeFileSync(join(root, "contracts", "1", "src", "A.sol"), "contract A {}\n");
  return root;
}

test("maps local id to the real C4 contest id from report frontmatter", () => {
  const all = readContests(fixture());
  assert.equal(all[0].c4Id, 71);
  assert.equal(selectContests(all, [1]).selected[0].slug, "2022-01-insure");
});

test("excludes a contest without report and explains why", () => {
  const root = fixture();
  writeFileSync(join(root, "audits", "2.json"), JSON.stringify({ contestId: 2, title: "x" }));
  const sel = selectContests(readContests(root), [1, 2]);
  assert.deepEqual(sel.excluded, [{ localId: 2, reason: "no report" }]);
});

test("excludes a contest whose report has no High finding", () => {
  const root = fixture();
  writeFileSync(join(root, "reports", "1.md"), '---\ncontest: 71\nslug: "2022-01-insure"\n---\n# Overview\nx\n# Medium Risk Findings (1)\n## [M-01] y\n');
  assert.deepEqual(selectContests(readContests(root), [1]).excluded, [{ localId: 1, reason: "no high finding" }]);
});

test("batch is the 12 approved contests", () => {
  assert.deepEqual([...BATCH_LOCAL_IDS], [110, 33, 40, 32, 23, 12, 65, 54, 34, 57, 96, 64]);
});
