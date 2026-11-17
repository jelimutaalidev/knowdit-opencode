export type ModelRef = { providerID: string; id: string };

export type GenerateFn = (input: {
  prompt: string;
  model?: ModelRef;
}) => Promise<{ text: string }>;

export type LlmCache = {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
};

export type LlmResult<T> = {
  value: T;
  tokensEst: number;
  costEst: number;
};

export type LlmCaller = {
  json<T>(input: {
    prompt: string;
    validate: (value: unknown) => T;
    key?: string;
  }): Promise<LlmResult<T>>;
};
