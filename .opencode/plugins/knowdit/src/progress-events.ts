/**
 * Shared shape of the progress updates KNOWDIT emits from its server tools and
 * the TUI part consumes. Keeping it here lets both sides agree on the marker
 * and the one-line formatting without importing either runtime.
 */

const KNOWDIT_SOURCE = "knowdit";

export interface ProgressEntry {
  readonly toolID: string;
  readonly sessionID: string;
  readonly metadata: Record<string, unknown>;
  readonly seq: number;
}

export interface ProgressLine {
  readonly detail: string;
  readonly percent: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tags an update so the TUI only renders progress that KNOWDIT produced. */
export function markKnowditProgress(update: Record<string, unknown>): Record<string, unknown> {
  return { ...update, source: KNOWDIT_SOURCE };
}

export function isKnowditProgress(metadata: unknown): boolean {
  return isRecord(metadata) && metadata.source === KNOWDIT_SOURCE;
}

export function formatProgressLine(metadata: Record<string, unknown>): ProgressLine | null {
  const detail = typeof metadata.detail === "string" ? metadata.detail.trim() : "";
  if (detail.length === 0) return null;

  const completed = numberValue(metadata.completed);
  const total = numberValue(metadata.total);
  const percent =
    completed !== null && total !== null && total > 0
      ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
      : null;

  return { detail, percent };
}

export function upsertProgress(
  entries: readonly ProgressEntry[],
  entry: ProgressEntry,
): ProgressEntry[] {
  return [...entries.filter((value) => value.toolID !== entry.toolID), entry];
}

export function removeProgress(
  entries: readonly ProgressEntry[],
  toolID: string,
): ProgressEntry[] {
  return entries.filter((value) => value.toolID !== toolID);
}

export function latestProgress(
  entries: readonly ProgressEntry[],
  sessionID: string,
): ProgressEntry | undefined {
  let latest: ProgressEntry | undefined;
  for (const entry of entries) {
    if (entry.sessionID !== sessionID) continue;
    if (!latest || entry.seq > latest.seq) latest = entry;
  }
  return latest;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
