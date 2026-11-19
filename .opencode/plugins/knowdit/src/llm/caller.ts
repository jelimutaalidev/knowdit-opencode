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

const MODEL_LIMIT_PATTERN =
  /free usage limit|rate limit|too many requests|\b429\b|quota exceeded/i;

/**
 * The provider refused the request because the model quota/rate limit is
 * exhausted. Retrying the same prompt immediately cannot help, so the caller
 * stops after the first such error and tells the operator how to resume.
 */
export class ModelLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelLimitError";
  }
}

export function isModelLimitError(error: unknown): boolean {
  if (error instanceof ModelLimitError) return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return MODEL_LIMIT_PATTERN.test(message);
}

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
        try {
          // A cached response that no longer satisfies the current validator
          // is stale, not fatal: fall through and regenerate it. Validation
          // rules (evidence floors, taxonomy, guards) get stricter over time,
          // so a hard error here would permanently poison resume.
          return result(input.validate(extractJson(cached)), input.prompt, cached);
        } catch {
          // Regenerate below.
        }
      }

      let lastError: unknown = new Error("llm caller made no attempts");
      let prompt = input.prompt;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let text: string;
        try {
          text = (await opts.generate({ prompt, model: opts.model })).text;
        } catch (error) {
          if (isModelLimitError(error)) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new ModelLimitError(
              `model limit reached: ${reason}. Completed units are journaled and cached; ` +
                "rerun kg_build after the limit resets to continue without redoing them.",
            );
          }
          throw error;
        }
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
