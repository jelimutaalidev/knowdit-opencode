import { DEFI_CATEGORIES } from "./categories.ts";
import { FINDING_TAXONOMY, type FindingTaxonomyEntry } from "./taxonomy.ts";

export type Severity = "High" | "Medium" | "Low";

const SEVERITIES: readonly Severity[] = ["High", "Medium", "Low"];

/**
 * Mirror the reference key: ASCII alphanumerics lowercased, every other run
 * collapsed to a single space.
 */
export function normalizeTaxonomyKey(text: string): string {
  let out = "";
  let previousWasSeparator = false;
  for (const char of text) {
    if (/[A-Za-z0-9]/.test(char)) {
      out += char.toLowerCase();
      previousWasSeparator = false;
    } else if (!previousWasSeparator) {
      out += " ";
      previousWasSeparator = true;
    }
  }
  return out.trim().split(/\s+/).join(" ");
}

export function resolveTaxonomyEntry(
  category: string,
  subcategory: string,
): FindingTaxonomyEntry | null {
  const categoryKey = normalizeTaxonomyKey(category);
  const subcategoryKey = normalizeTaxonomyKey(subcategory);
  return (
    FINDING_TAXONOMY.find(
      (entry) =>
        normalizeTaxonomyKey(entry.category) === categoryKey &&
        normalizeTaxonomyKey(entry.subcategory) === subcategoryKey,
    ) ?? null
  );
}

export function validateTaxonomyPair(category: string, subcategory: string): string | null {
  if (resolveTaxonomyEntry(category, subcategory)) return null;
  return `unknown subcategory '${subcategory.trim()}' for category '${category}'`;
}

function normalizeCategory(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}

/**
 * Return the seeded spelling of a DeFi category, or null when it is not in
 * the enum. Mirrors the reference parser's case/separator tolerance.
 */
export function canonicalDefiCategory(value: string): string | null {
  const target = normalizeCategory(value);
  return DEFI_CATEGORIES.find((category) => normalizeCategory(category) === target) ?? null;
}


export function isDefiCategory(value: string): boolean {
  const target = normalizeCategory(value);
  return DEFI_CATEGORIES.some((category) => normalizeCategory(category) === target);
}

export function isSeverity(value: string): value is Severity {
  return (SEVERITIES as readonly string[]).includes(value);
}

const RANK: Record<Severity, number> = { High: 3, Medium: 2, Low: 1 };

export function maxSeverity(a: Severity, b: Severity): Severity {
  return RANK[a] >= RANK[b] ? a : b;
}
