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
    // OpenCode 2.2.x exposes list/default on the model domain; get() exists only
    // on the editor passed to ctx.model.transform. Model inventory may also be
    // unavailable at startup, so a failed lookup must not block tool registration.
    let contextWindow: number | undefined;
    try {
      const models = await ctx.model.list();
      const info = models.data.find(
        (candidate) =>
          candidate.providerID === model.providerID &&
          (candidate.modelID === model.id || candidate.id === model.id),
      );
      contextWindow = info?.limit?.input ?? info?.limit?.context;
    } catch {
      contextWindow = undefined;
    }

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
