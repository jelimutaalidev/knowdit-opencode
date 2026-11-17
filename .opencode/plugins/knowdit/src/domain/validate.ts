import { DEFI_CATEGORIES } from "./categories.ts";
import { FINDING_TAXONOMY } from "./taxonomy.ts";

export type Severity = "High" | "Medium" | "Low";

const SEVERITIES: readonly Severity[] = ["High", "Medium", "Low"];

export function validateTaxonomyPair(category: string, subcategory: string): string | null {
  const trimmed = subcategory.trim();
  const match = FINDING_TAXONOMY.find(
    (entry) => entry.category === category && entry.subcategory === trimmed,
  );
  if (match) return null;
  return `unknown subcategory '${trimmed}' for category '${category}'`;
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
