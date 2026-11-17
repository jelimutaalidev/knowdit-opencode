import test from "node:test";
import assert from "node:assert/strict";
import { validateTaxonomyPair, isDefiCategory, isSeverity, maxSeverity } from "../../.opencode/plugins/knowdit/src/domain/validate.ts";
import { FINDING_TAXONOMY, DEFI_CATEGORIES, VULN_CATEGORIES } from "../../.opencode/plugins/knowdit/src/domain/taxonomy.ts";

test("taxonomy has 14 / 7 / 45 entries", () => {
  assert.equal(DEFI_CATEGORIES.length, 14);
  assert.equal(VULN_CATEGORIES.length, 7);
  assert.equal(FINDING_TAXONOMY.length, 45);
  assert.equal(new Set(FINDING_TAXONOMY.map((e) => `${e.category}\u0000${e.subcategory}`)).size, 45);
});

test("accepts a known pair and rejects an invented one", () => {
  assert.equal(validateTaxonomyPair("Arithmetic", FINDING_TAXONOMY.find((e) => e.category === "Arithmetic")!.subcategory), null);
  assert.match(validateTaxonomyPair("Arithmetic", "Not A Real Subcategory")!, /unknown subcategory/i);
});

test("severity helpers", () => {
  assert.equal(isSeverity("High"), true);
  assert.equal(isSeverity("Critical"), false);
  assert.equal(maxSeverity("Low", "High"), "High");
  assert.equal(isDefiCategory("Dexes"), true);
  assert.equal(isDefiCategory("Gaming"), false);
});
