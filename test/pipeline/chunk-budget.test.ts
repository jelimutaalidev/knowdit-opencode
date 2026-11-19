import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHUNK_TOKENS,
  DEFAULT_CONTEXT_WINDOW_UTILIZATION,
  resolveChunkTokens,
} from "../../.opencode/plugins/knowdit/src/pipeline/chunk.ts";

test("uses the reference 20% context-window utilization", () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW_UTILIZATION, 0.2);
});

test("derives the chunk budget from the model window minus prompt overhead", () => {
  assert.equal(
    resolveChunkTokens({ contextWindow: 128_000, overheadTokens: 2_000 }),
    23_600,
  );
});

test("falls back to the conservative default when the window is unknown", () => {
  assert.equal(resolveChunkTokens({}), DEFAULT_CHUNK_TOKENS);
});

test("never returns a non-positive budget", () => {
  const budget = resolveChunkTokens({ contextWindow: 1_000, overheadTokens: 5_000 });
  assert.ok(budget >= 1, `expected >= 1, got ${budget}`);
});
