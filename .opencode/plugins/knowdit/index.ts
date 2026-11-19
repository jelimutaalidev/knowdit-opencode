import { Plugin } from "@opencode/plugin";
import { fileURLToPath } from "node:url";
import { registerKnowditTools } from "./src/register.ts";
import { buildHandlers } from "./src/tools/handlers.ts";
import { createSessionGenerate, type ModelRef } from "./src/llm/session-transport.ts";

const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  id: "deepseek-v4.1-flash-free",
  // Reasoning effort: low | high | max. Keep at least "high" for extraction quality.
  variant: "high",
};

export default Plugin.define({
  id: "knowdit",
  async setup(ctx) {
    const model = (ctx.options as { model?: ModelRef } | undefined)?.model ?? DEFAULT_MODEL;
    const dataDir = fileURLToPath(new URL("../../../data/", import.meta.url));
    const info = ctx.model.get(model.providerID, model.id);
    const contextWindow = info?.limit?.input ?? info?.limit?.context;

    await ctx.tool.transform((editor) => {
      registerKnowditTools(
        editor,
        buildHandlers({
          dataDir,
          model,
          contextWindow,
          generate: createSessionGenerate(ctx, {
            scratchDir: `${dataDir}llm-scratch/`,
            model,
          }),
        }),
      );
    });
  },
});
