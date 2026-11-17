import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GENERAL_ROLE_SYSTEM, buildExtractFindingsPrompt } from "../../.opencode/plugins/knowdit/src/prompts/index.ts";

test("role system prompt is the Rust text", () => {
  assert.equal(GENERAL_ROLE_SYSTEM, "You are an expert DeFi knowledge engineer and senior smart contract analyst.\nFollow the user's instructions exactly.\nUse canonical, project-agnostic DeFi terminology.\nWhen the user requests JSON, return strict JSON only.");
});

test("finding prompt carries chunk, schema hint, and JSON-only rule", () => {
  const p = buildExtractFindingsPrompt({ chunk: "REPORT-BODY", schemaHint: "SCHEMA", categories: ["Lending"] });
  assert.ok(p.includes("REPORT-BODY"));
  assert.ok(p.includes("SCHEMA"));
  assert.ok(p.includes("Lending"));
  assert.match(p, /strict JSON/i);
});

test("golden prompt matches", () => {
  const golden = readFileSync("test/fixtures/prompts/findings.golden.txt", "utf8");
  assert.equal(buildExtractFindingsPrompt({ chunk: "CHUNK", schemaHint: "SCHEMA", categories: ["Lending"] }), golden);
});
