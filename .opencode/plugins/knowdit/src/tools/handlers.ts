import { homedir } from "node:os";
import { join } from "node:path";
import { BATCH_LOCAL_IDS } from "../dataset/select.ts";
import { prepareDataset } from "../dataset/prepare.ts";
import type { ModelRef } from "../llm/session-transport.ts";
import type { ToolHandler } from "../register.ts";

export type HandlerDeps = {
  dataDir: string;
  model?: ModelRef;
  generate: (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>;
};

export function buildHandlers(deps: HandlerDeps): Record<string, ToolHandler> {
  return {
    dataset_prepare: async (input) => {
      const options = (input ?? {}) as { sourceRoot?: string; localIds?: number[] };
      const sourceRoot = options.sourceRoot ?? join(homedir(), "c4-data", "out_train");
      const localIds = options.localIds ?? BATCH_LOCAL_IDS;
      const manifest = await prepareDataset({
        sourceRoot,
        dataDir: deps.dataDir,
        localIds,
      });
      const coreLoc = manifest.contests.reduce((sum, contest) => sum + contest.coreLoc, 0);
      const tokensEst = manifest.contests.reduce(
        (sum, contest) => sum + (contest.report?.tokensEst ?? 0),
        0,
      );
      return {
        content: JSON.stringify(
          {
            datasetDir: join(deps.dataDir, "dataset"),
            contests: manifest.contests.length,
            coreLoc,
            tokensEst,
            excluded: manifest.excluded,
          },
          null,
          2,
        ),
      };
    },
  };
}
