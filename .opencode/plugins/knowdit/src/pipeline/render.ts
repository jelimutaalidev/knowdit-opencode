/** Render a string capped to `maxChars` Unicode code points. */
export function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return text;
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, maxChars).join("")} …[truncated]`;
}

/**
 * Prefix a folded raw's text with its source name, matching the reference
 * `label_variant`: the line is subordinate context, not another mechanism.
 */
export function labelVariant(name: string, text: string): string {
  const trimmedName = name.trim();
  const trimmedText = text.trim();
  return trimmedName
    ? `additional context (from raw "${trimmedName}"): ${trimmedText}`
    : `additional context: ${trimmedText}`;
}

/**
 * Canonical text followed by up to `cap` folded-raw notes, each optionally
 * capped per entry, plus an overflow disclosure. Mirrors the reference
 * `render_with_variants_capped`.
 */
export function renderWithVariants(
  canonical: string,
  notes: readonly string[],
  cap: number,
  perEntryChars: number,
): string {
  let out = canonical.trim();
  const variants = notes.map((note) => note.trim()).filter((note) => note.length > 0);
  if (variants.length === 0) return out;

  for (const note of variants.slice(0, Math.max(0, cap))) {
    out += `\n— ${truncateChars(note, perEntryChars)}`;
  }
  const shown = Math.min(variants.length, Math.max(0, cap));
  if (variants.length > shown) {
    out += `\n— (+${variants.length - shown} more folded raws not shown)`;
  }
  return out;
}
