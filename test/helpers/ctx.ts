import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDb } from "./db.ts";
import { openJournal } from "../../.opencode/plugins/knowdit/src/journal.ts";
import type { LlmCaller } from "../../.opencode/plugins/knowdit/src/llm/types.ts";
import type {
  FindingItem,
  SemanticItem,
  StageContext,
} from "../../.opencode/plugins/knowdit/src/pipeline/types.ts";
import type { Severity } from "../../.opencode/plugins/knowdit/src/domain/validate.ts";

export type FakeScript = {
  categories?: string[];
  semantics?: SemanticItem[];
  findings?: FindingItem[];
  links?: { findingIndex: number; semanticIndices: number[] }[];
  globalLinks?: { semanticIndex: number; strength: Severity; evidence: string }[];
};

function scriptedValue(prompt: string, script: FakeScript): unknown {
  if (prompt.includes('"project_name"')) {
    return {
      reasoning: "fake categorization",
      project_name: "fake project",
      categories: script.categories ?? [],
    };
  }
  if (prompt.includes('"pairs"')) {
    return {
      pairs: (script.links ?? []).map((link) => ({
        finding_index: link.findingIndex,
        semantic_indices: link.semanticIndices,
      })),
    };
  }
  if (prompt.includes('"semantic_evidence"') || prompt.includes('"finding_id"')) {
    return {
      links: (script.globalLinks ?? []).map((link) => ({
        finding_id: "F-1",
        reasoning: "fake global link",
        semantic_evidence: [
          {
            semantic_id: link.semanticIndex + 1,
            strength: link.strength,
            why_finding_can_fire: link.evidence,
          },
        ],
      })),
    };
  }
  if (prompt.includes('"semantics"')) {
    return { semantics: script.semantics ?? [] };
  }
  if (prompt.includes('"findings"')) {
    return { findings: script.findings ?? [] };
  }
  throw new Error("fakeCtx: no scripted response for this prompt");
}

export type FakeCtx = {
  ctx: StageContext;
  llm: LlmCaller & { calls: number };
  prompts: string[];
  cleanup: () => void;
};

export async function fakeCtx(script: FakeScript): Promise<FakeCtx> {
  const root = mkdtempSync(join(tmpdir(), "fake-ctx-"));
  const datasetDir = join(root, "dataset");
  mkdirSync(join(datasetDir, "reports"), { recursive: true });
  mkdirSync(join(datasetDir, "contracts", "229", "src"), { recursive: true });
  writeFileSync(join(datasetDir, "reports", "229.md"), "REPORT-BODY");
  writeFileSync(join(datasetDir, "contracts", "229", "src", "A.sol"), "SOURCE-SENTINEL");

  const { db } = await tempDb();
  const journal = await openJournal(join(root, "runs.sqlite"));
  const prompts: string[] = [];

  const llm = {
    calls: 0,
    async json<T>(input: {
      prompt: string;
      validate: (value: unknown) => T;
      key?: string;
    }): Promise<{ value: T; tokensEst: number; costEst: number }> {
      prompts.push(input.prompt);
      llm.calls += 1;
      const value = input.validate(scriptedValue(input.prompt, script));
      return { value, tokensEst: Math.ceil(input.prompt.length / 4), costEst: 0 };
    },
  } as LlmCaller & { calls: number };

  return {
    ctx: {
      db,
      llm,
      journal,
      datasetDir,
      contest: {
        localId: 1,
        c4Id: 229,
        slug: "2022-01-insure",
        title: "Insure",
        coreLoc: 1,
        sourceFiles: ["src/A.sol"],
        report: null,
        expected: { high: 0, medium: 0 },
      },
    },
    llm,
    prompts,
    cleanup: () => {
      journal.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
