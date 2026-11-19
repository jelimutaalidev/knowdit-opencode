import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../.opencode/plugins/knowdit/index.ts";

type ModelList = () => Promise<{
  location: { directory: string };
  data: {
    id: string;
    modelID: string;
    providerID: string;
    limit: { context: number; input?: number; output: number };
  }[];
}>;

function fakeContext(list: ModelList) {
  const tools: string[] = [];
  const namespaces: string[] = [];
  let listCalls = 0;

  const ctx = {
    options: {},
    model: {
      // OpenCode 2.2.x exposes list/default on the domain; get() is editor-only.
      list: async () => {
        listCalls++;
        return list();
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          namespace: (namespace: { name: string }) =>
            namespaces.push(namespace.name),
          add: (tool: { name: string }) => tools.push(tool.name),
        });
        return { dispose: async () => {} };
      },
    },
    session: {
      create: async () => ({ id: "ses_test" }),
      generate: async () => ({ text: "{}" }),
      remove: async () => {},
    },
  };

  const calls = () => listCalls;
  return { ctx, tools, namespaces, calls };
}

const okList: ModelList = async () => ({
  location: { directory: process.cwd() },
  data: [
    {
      id: "deepseek-v4.1-flash-free",
      modelID: "deepseek-v4.1-flash-free",
      providerID: "opencode",
      limit: { context: 128_000, input: 64_000, output: 8_192 },
    },
  ],
});

test("plugin setup resolves the model window through the list API", async () => {
  const { ctx, tools, namespaces, calls } = fakeContext(okList);

  await plugin.setup(ctx as never);

  assert.equal(calls(), 1);
  assert.deepEqual(namespaces, ["knowdit"]);
  assert.equal(tools.length, 5);
});

test("plugin setup still registers tools when the model list fails", async () => {
  const { ctx, tools } = fakeContext(async () => {
    throw new Error("provider unavailable");
  });

  await plugin.setup(ctx as never);

  assert.equal(tools.length, 5);
});
