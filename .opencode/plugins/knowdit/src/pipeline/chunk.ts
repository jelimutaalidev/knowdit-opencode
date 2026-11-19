/** Conservative per-chunk budget used when the model window is unknown. */
export const DEFAULT_CHUNK_TOKENS = 8_000;

/**
 * Fraction of a model's input window a single prompt may fill. Mirrors the
 * reference `DEFAULT_CONTEXT_WINDOW_UTILIZATION` (0.2): deliberately well
 * below 1.0 so prompts stay focused and agent growth fits smaller windows.
 */
export const DEFAULT_CONTEXT_WINDOW_UTILIZATION = 0.2;

/**
 * Token budget for one prompt: `utilization × contextWindow − overhead`,
 * clamped to the same sane band as the reference (0.05..1.0) and never below
 * one token. Falls back to {@link DEFAULT_CHUNK_TOKENS} when the model window
 * is unknown.
 */
export function resolveChunkTokens(opts: {
  contextWindow?: number;
  utilization?: number;
  overheadTokens?: number;
  fallback?: number;
}): number {
  const { contextWindow, overheadTokens = 0 } = opts;
  if (!contextWindow || contextWindow <= 0) {
    return opts.fallback ?? DEFAULT_CHUNK_TOKENS;
  }
  const utilization = Math.min(1, Math.max(0.05, opts.utilization ?? DEFAULT_CONTEXT_WINDOW_UTILIZATION));
  const budget = Math.floor(contextWindow * utilization) - overheadTokens;
  return Math.max(1, budget);
}

/**
 * Split text into chunks of at most `budgetTokens` estimated tokens.
 *
 * Chunks break on line boundaries and never split a line, mirroring the
 * reference TokenCursor behaviour closely enough for prompt budgeting.
 */
export function chunkByBudget(text: string, budgetTokens: number): string[] {
  if (text.length === 0) return [];
  const budgetChars = Math.max(1, budgetTokens) * 4;
  if (text.length <= budgetChars) return [text];

  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? [text];
  const chunks: string[] = [];
  let current = "";

  for (const line of lines) {
    if (current.length > 0 && current.length + line.length > budgetChars) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
