import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmCache, ModelRef } from "./types.ts";

const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;

function safeKey(key: string): string {
  return SAFE_KEY.test(key)
    ? key
    : createHash("sha256").update(key).digest("hex");
}

export function cacheKey(input: { prompt: string; model?: ModelRef }): string {
  const hash = createHash("sha256");
  hash.update(input.prompt);
  if (input.model) {
    hash.update("\u0000");
    hash.update(`${input.model.providerID}/${input.model.id}`);
  }
  return hash.digest("hex");
}

export function fileCache(dir: string): LlmCache {
  const pathFor = (key: string) => join(dir, `${safeKey(key)}.json`);
  return {
    get(key) {
      try {
        return readFileSync(pathFor(key), "utf8");
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(pathFor(key), value);
    },
  };
}
