import { Plugin } from "@opencode/plugin";
import { registerKnowditTools } from "./src/register.ts";
import { buildHandlers } from "./src/tools/handlers.ts";
import { createSessionGenerate, type ModelRef } from "./src/llm/session-transport.ts";

const DEFAULT_MODEL: ModelRef = {
  providerID: "opencode",
  id: "deepseek-v4.1-flash-free",
};

export default Plugin.define({
  id: "knowdit",
  async setup(ctx) {
    const model = (ctx.options as { model?: ModelRef } | undefined)?.model ?? DEFAULT_MODEL;
    const dataDir = new URL("../data/", import.meta.url).pathname;

    await ctx.tool.transform((editor) => {
      registerKnowditTools(
        editor,
        buildHandlers({
          dataDir,
          model,
          generate: createSessionGenerate(ctx, {
            scratchDir: `${dataDir}llm-scratch/`,
            model,
          }),
        }),
      );
    });
  },
});
