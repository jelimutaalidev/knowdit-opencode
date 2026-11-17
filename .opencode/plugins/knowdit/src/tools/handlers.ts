import type { ModelRef } from "../llm/session-transport.ts";
import type { ToolHandler } from "../register.ts";

export type HandlerDeps = {
  dataDir: string;
  model?: ModelRef;
  generate: (input: { prompt: string; model?: ModelRef }) => Promise<{ text: string }>;
};

export function buildHandlers(_deps: HandlerDeps): Record<string, ToolHandler> {
  return {
    dataset_prepare: async () => ({ content: "not implemented" }),
  };
}
