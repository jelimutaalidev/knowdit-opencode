/**
 * Approximate token count used for prompt packing. Mirrors the reference's
 * lossy counter closely enough for chunk sizing: 4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Greedy token + count partition. A batch closes when adding the next item
 * would exceed EITHER the token budget or the count cap. An item that is
 * larger than a whole budget still gets a batch of its own, so packing never
 * drops input.
 */
export function partitionByBudget<T>(
  items: readonly T[],
  budgetTokens: number,
  countCap: number,
  cost: (item: T) => number,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentTokens = 0;
  const cap = Math.max(1, countCap);

  for (const item of items) {
    const itemTokens = cost(item);
    if (
      current.length > 0 &&
      (current.length >= cap || currentTokens + itemTokens > budgetTokens)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(item);
    currentTokens += itemTokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
