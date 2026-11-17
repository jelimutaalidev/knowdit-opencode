import { cacheKey } from "./cache.ts";
import { extractJson } from "./json.ts";
import type { GenerateFn, LlmCache, LlmCaller, LlmResult, ModelRef } from "./types.ts";

export type LlmCallerOptions = {
  generate: GenerateFn;
  cache: LlmCache;
  model?: ModelRef;
  maxAttempts: number;
  cost?: { input: number; output: number };
};

const DEFAULT_COST = { input: 0, output: 0 };

function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function retryPrompt(prompt: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `${prompt}\n\nYour previous response was rejected: ${reason}\nRespond with valid JSON only.`;
}

export function createLlmCaller(opts: LlmCallerOptions): LlmCaller {
  const cost = opts.cost ?? DEFAULT_COST;
  const maxAttempts = Math.max(1, opts.maxAttempts);

  function result<T>(value: T, prompt: string, responseText: string): LlmResult<T> {
    const tokensEst = estimateTokens(prompt.length);
    return {
      value,
      tokensEst,
      costEst: tokensEst * cost.input + estimateTokens(responseText.length) * cost.output,
    };
  }

  return {
    async json<T>(input: {
      prompt: string;
      validate: (value: unknown) => T;
      key?: string;
    }): Promise<LlmResult<T>> {
      const key = input.key ?? cacheKey({ prompt: input.prompt, model: opts.model });

      const cached = opts.cache.get(key);
      if (cached !== undefined) {
        return result(input.validate(extractJson(cached)), input.prompt, cached);
      }

      let lastError: unknown = new Error("llm caller made no attempts");
      let prompt = input.prompt;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const text = (await opts.generate({ prompt, model: opts.model })).text;
        try {
          const value = input.validate(extractJson(text));
          opts.cache.set(key, text);
          return result(value, input.prompt, text);
        } catch (error) {
          lastError = error;
          prompt = retryPrompt(input.prompt, error);
        }
      }

      throw lastError;
    },
  };
}
