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
