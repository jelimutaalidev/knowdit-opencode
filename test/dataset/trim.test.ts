import test from "node:test";
import assert from "node:assert/strict";
import { trimReport } from "../../.opencode/plugins/knowdit/src/dataset/trim.ts";

const doc = `---
slug: "x"
contest: 1
---
# Overview
ov
# Scope
sc
# High Risk Findings (1)
## [H-01] bad
h
# Medium Risk Findings (1)
## [M-01] meh
m
# Low Risk and Non-Critical Issues
## [L-01] low
l
# Gas Optimizations
gas
# Disclosures
disc
`;

test("keeps overview, scope, H/M, and the combined low section", () => {
  const r = trimReport(doc);
  assert.equal(r.fallback, false);
  for (const s of ["# Overview", "# Scope", "# High Risk Findings (1)", "# Medium Risk Findings (1)", "# Low Risk and Non-Critical Issues"]) assert.ok(r.text.includes(s));
  assert.ok(!r.text.includes("# Gas Optimizations"));
  assert.deepEqual(r.droppedSections, ["Gas Optimizations", "Disclosures"]);
  assert.ok(r.text.startsWith("---"));
});

test("keeps split low and non-critical sections", () => {
  const split = doc.replace("# Low Risk and Non-Critical Issues", "# Low Risk Findings (2)").concat("\n# Non-Critical Findings (1)\nnc\n");
  const r = trimReport(split);
  assert.ok(r.text.includes("# Low Risk Findings (2)"));
  assert.ok(r.text.includes("# Non-Critical Findings (1)"));
});

test("falls back to the full report when no High/Medium section exists", () => {
  const r = trimReport("# Overview\nx\n# Gas Optimizations\ny\n");
  assert.equal(r.fallback, true);
  assert.equal(r.text.trim(), "# Overview\nx\n# Gas Optimizations\ny".trim());
});

test("is idempotent", () => {
  const once = trimReport(doc).text;
  assert.equal(trimReport(once).text, once);
});
