import { mkdirSync } from "node:fs";

export type ModelRef = { providerID: string; id: string };

export type SessionTransportCtx = {
  session: {
    create(input: {
      title: string;
      location: { directory: string };
      model: ModelRef;
    }): Promise<{ id: string }>;
    generate(input: { sessionID: string; prompt: string }): Promise<{ text: string }>;
    remove(input: { sessionID: string }): Promise<void>;
  };
};

export type SessionGenerate = (input: {
  prompt: string;
  model?: ModelRef;
}) => Promise<{ text: string }>;

export function createSessionGenerate(
  ctx: SessionTransportCtx,
  opts: { scratchDir: string; model: ModelRef },
): SessionGenerate {
  mkdirSync(opts.scratchDir, { recursive: true });
  return async (input) => {
    const model = input.model ?? opts.model;
    const session = await ctx.session.create({
      title: "knowdit-llm",
      location: { directory: opts.scratchDir },
      model,
    });
    try {
      const r = await ctx.session.generate({ sessionID: session.id, prompt: input.prompt });
      return { text: r.text };
    } finally {
      await ctx.session.remove({ sessionID: session.id }).catch(() => {});
    }
  };
}
