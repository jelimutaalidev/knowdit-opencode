import type { ManifestContest } from "../dataset/snapshot.ts";
import type { KgDb } from "../db/client.ts";
import type { Journal } from "../journal.ts";
import type { LlmCaller } from "../llm/types.ts";
import type { Severity } from "../domain/validate.ts";

export type ProgressFn = (update: Record<string, unknown>) => void | Promise<void>;

export type StageContext = {
  db: KgDb;
  llm: LlmCaller;
  journal: Journal;
  contest: ManifestContest;
  datasetDir: string;
  /** Nested stage progress (for example, one event per report chunk). */
  onProgress?: ProgressFn;
  /** Model input window in tokens; drives the per-chunk budget like the reference. */
  contextWindow?: number;
};

export type SemanticFunctionItem = {
  name: string;
  contract: string;
  signature?: string;
};

export type SemanticItem = {
  name: string;
  category: string;
  definition: string;
  description: string;
  functions: SemanticFunctionItem[];
};

export type FindingItem = {
  title: string;
  severity: Severity;
  category: string;
  subcategory: string;
  root_cause: string;
  description: string;
  patterns: string;
  exploits: string;
};
