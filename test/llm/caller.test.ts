import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLlmCaller } from "../../.opencode/plugins/knowdit/src/llm/caller.ts";
import { cacheKey, fileCache } from "../../.opencode/plugins/knowdit/src/llm/cache.ts";
import { extractJson, JsonTruncatedError } from "../../.opencode/plugins/knowdit/src/llm/json.ts";

const ok = <T extends object>(expected: T) => (v: unknown): T => {
  if (typeof v !== "object" || v === null) throw new Error("bad shape");
  for (const key of Object.keys(expected)) {
    if (!(key in v)) throw new Error("bad shape");
  }
  return v as T;
};
const reject = (_v: unknown): never => {
  throw new Error("bad shape");
};

test("extracts fenced and bare json", () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
});

test("reports truncation distinctly", () => {
  assert.throws(() => extractJson('{"a": [1, 2'), JsonTruncatedError);
});

test("retries validation failures and then succeeds", async () => {
  let calls = 0;
  const caller = createLlmCaller({
    generate: async () => ({ text: ++calls === 1 ? '{"bad":true}' : '{"a":1}' }),
    cache: new Map(),
    maxAttempts: 3,
  });
  const r = await caller.json({ key: "k", prompt: "p", validate: ok({ a: 1 }) });
  assert.deepEqual(r.value, { a: 1 });
  assert.equal(calls, 2);
});

test("fails after maxAttempts with the last error", async () => {
  const caller = createLlmCaller({
    generate: async () => ({ text: '{"bad":true}' }),
    cache: new Map(),
    maxAttempts: 3,
  });
  await assert.rejects(() => caller.json({ key: "k", prompt: "p", validate: reject }), /bad shape/);
});

test("cache hit avoids a second model call", async () => {
  let calls = 0;
  const cache = new Map<string, string>();
  const caller = createLlmCaller({
    generate: async () => { calls += 1; return { text: '{"a":1}' }; },
    cache,
    maxAttempts: 3,
  });
  await caller.json({ key: "same", prompt: "p", validate: ok({ a: 1 }) });
  await caller.json({ key: "same", prompt: "p", validate: ok({ a: 1 }) });
  assert.equal(calls, 1);
});

test("a failed response is never cached", async () => {
  let calls = 0;
  const cache = new Map<string, string>();
  const caller = createLlmCaller({
    generate: async () => { calls += 1; return { text: '{"bad":true}' }; },
    cache,
    maxAttempts: 2,
  });
  await assert.rejects(() => caller.json({ key: "k", prompt: "p", validate: reject }));
  await assert.rejects(() => caller.json({ key: "k", prompt: "p", validate: reject }));
  assert.equal(calls, 4);
  assert.equal(cache.size, 0);
});

test("cache key is a stable sha256 over prompt and model", () => {
  assert.equal(cacheKey({ prompt: "p" }).length, 64);
  assert.equal(cacheKey({ prompt: "p" }), cacheKey({ prompt: "p" }));
  assert.notEqual(cacheKey({ prompt: "p" }), cacheKey({ prompt: "p", model: { providerID: "a", id: "b" } }));
});

test("file cache round-trips through disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-"));
  fileCache(dir).set("k", "v");
  assert.equal(fileCache(dir).get("k"), "v");
});

test("cost is an estimate based on characters", async () => {
  const caller = createLlmCaller({
    generate: async () => ({ text: '{"a":1}' }),
    cache: new Map(),
    maxAttempts: 3,
    cost: { input: 3, output: 15 },
  });
  const r = await caller.json({ key: "k", prompt: "123456789012345", validate: ok({ a: 1 }) });
  assert.equal(r.tokensEst, 4);
  assert.equal(r.costEst, 4 * 3 + 2 * 15);
});
