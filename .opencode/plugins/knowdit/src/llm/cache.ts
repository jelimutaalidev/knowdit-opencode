import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmCache, ModelRef } from "./types.ts";
import { PIPELINE_VERSION } from "../version.ts";

const SAFE_KEY = /^[A-Za-z0-9_.-]+$/;

/**
 * Bump whenever prompt text, prompt construction, or response validation
 * changes. It is part of the default cache key, so a rebuild cannot silently
 * reuse a response produced under an older contract.
 */
export const CACHE_VERSION = PIPELINE_VERSION;

function safeKey(key: string): string {
  return SAFE_KEY.test(key)
    ? key
    : createHash("sha256").update(key).digest("hex");
}

export function cacheKey(input: {
  prompt: string;
  model?: ModelRef;
  version?: string;
}): string {
  const hash = createHash("sha256");
  hash.update(input.version ?? CACHE_VERSION);
  hash.update("\u0000");
  hash.update(input.prompt);
  if (input.model) {
    hash.update("\u0000");
    hash.update(`${input.model.providerID}/${input.model.id}`);
    hash.update("\u0000");
    hash.update(input.model.variant ?? "");
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
