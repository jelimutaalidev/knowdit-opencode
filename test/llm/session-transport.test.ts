import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionGenerate } from "../../.opencode/plugins/knowdit/src/llm/session-transport.ts";

type Call = { op: string; input: any };

function fakeCtx(generate?: (input: any) => Promise<any>) {
  const calls: Call[] = [];
  let n = 0;
  const ctx = {
    session: {
      create: async (input: any) => {
        calls.push({ op: "create", input });
        return { id: `s${++n}` };
      },
      generate: async (input: any) => {
        calls.push({ op: "generate", input });
        if (generate) return generate(input);
        return { text: "ok" };
      },
      remove: async (input: any) => {
        calls.push({ op: "remove", input });
      },
    },
  };
  return { ctx, calls };
}

const scratch = () => mkdtempSync(join(tmpdir(), "llm-scratch-"));
const model = { providerID: "opencode", id: "m" };

test("creates a scratch session, generates, and removes it", async () => {
  const { ctx, calls } = fakeCtx();
  const dir = scratch();
  const generate = createSessionGenerate(ctx, { scratchDir: dir, model });
  const r = await generate({ prompt: "P" });
  assert.deepEqual(r, { text: "ok" });
  assert.equal(calls[0].op, "create");
  assert.deepEqual(calls[0].input.location, { directory: dir });
  assert.deepEqual(calls[0].input.model, model);
  assert.deepEqual(calls[1], { op: "generate", input: { sessionID: "s1", prompt: "P" } });
  assert.deepEqual(calls[2], { op: "remove", input: { sessionID: "s1" } });
});

test("removes the session when generation fails", async () => {
  const { ctx, calls } = fakeCtx(async () => {
    throw new Error("boom");
  });
  const generate = createSessionGenerate(ctx, { scratchDir: scratch(), model });
  await assert.rejects(() => generate({ prompt: "P" }), /boom/);
  assert.deepEqual(calls.map((c) => c.op), ["create", "generate", "remove"]);
});

test("per-call model overrides the default", async () => {
  const { ctx, calls } = fakeCtx();
  const generate = createSessionGenerate(ctx, { scratchDir: scratch(), model });
  await generate({ prompt: "P", model: { providerID: "opencode", id: "override" } });
  assert.deepEqual(calls[0].input.model, { providerID: "opencode", id: "override" });
});
