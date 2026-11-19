import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildProjectMaterials } from "../../.opencode/plugins/knowdit/src/pipeline/materials.ts";
import type { StageContext } from "../../.opencode/plugins/knowdit/src/pipeline/types.ts";

function makeCtx(files: Record<string, string>, readme?: string): StageContext {
  const datasetDir = mkdtempSync(join(tmpdir(), "materials-"));
  const c4Id = 305;
  for (const [relative, body] of Object.entries(files)) {
    const target = join(datasetDir, "contracts", String(c4Id), relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  if (readme !== undefined) {
    writeFileSync(join(datasetDir, "contracts", String(c4Id), "README.md"), readme);
  }
  return {
    datasetDir,
    contest: { c4Id, sourceFiles: Object.keys(files) },
  } as unknown as StageContext;
}

test("includes the full source of a file with no per-file truncation", () => {
  const body = `contract Big {\n${"// padding line\n".repeat(800)}}\n`;
  assert.ok(body.length > 2_000);

  const materials = buildProjectMaterials(makeCtx({ "src/Big.sol": body }));

  assert.ok(
    materials.includes(body),
    `expected full ${body.length}-char source in the prompt, got ${materials.length} chars`,
  );
});

test("includes every in-scope file with no file-count cap", () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 60; i++) {
    files[`src/C${String(i).padStart(2, "0")}.sol`] = `contract C${i} { uint256 v${i}; }\n`;
  }

  const materials = buildProjectMaterials(makeCtx(files));

  for (const relative of Object.keys(files)) {
    assert.ok(materials.includes(`### ${relative}`), `missing ${relative}`);
  }
});

test("includes the project README like the reference loader", () => {
  const materials = buildProjectMaterials(
    makeCtx({ "src/A.sol": "contract A {}\n" }, "# Project\n\nOnly fee-on-transfer tokens are out of scope.\n"),
  );

  assert.ok(materials.includes("## README"), "expected a README section");
  assert.ok(materials.includes("fee-on-transfer tokens are out of scope"));
});
