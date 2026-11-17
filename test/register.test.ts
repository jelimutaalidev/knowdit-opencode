import test from "node:test";
import assert from "node:assert/strict";
import { registerKnowditTools } from "../.opencode/plugins/knowdit/src/register.ts";

test("registers the knowdit namespace and five tools", () => {
  const namespaces: string[] = [];
  const tools: string[] = [];
  registerKnowditTools(
    { namespace: (n) => namespaces.push(n.name), add: (t) => tools.push(t.name) },
    { dataset_prepare: async () => ({ content: "ok" }) },
  );
  assert.deepEqual(namespaces, ["knowdit"]);
  assert.deepEqual(tools, ["dataset_prepare"]);
});
