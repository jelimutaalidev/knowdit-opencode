import { canonicalDefiCategory } from "../domain/validate.ts";
import { buildExtractSemanticsPrompt } from "../prompts/index.ts";
import { chunkByBudget, resolveChunkTokens } from "./chunk.ts";
import { buildProjectMaterials } from "./materials.ts";
import { ensureProject, findProject, projectCategories } from "./project.ts";
import type { SemanticItem, StageContext } from "./types.ts";

export type { SemanticItem } from "./types.ts";

/** Conservative per-chunk budget for the free OpenCode model. */
export const DEFAULT_CHUNK_TOKENS = 8_000;

function normalizeContract(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

export function dedupSemantics(items: SemanticItem[]): SemanticItem[] {
  const byName = new Map<string, SemanticItem>();

  for (const item of items) {
    const key = item.name.toLowerCase().trim();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, { ...item, functions: [...item.functions] });
      continue;
    }

    for (const fn of item.functions) {
      const alreadyHas = existing.functions.some(
        (candidate) => candidate.name === fn.name && candidate.contract === fn.contract,
      );
      if (!alreadyHas) existing.functions.push(fn);
    }

    if (item.description.length > existing.description.length) {
      existing.description = item.description;
      existing.definition = item.definition;
    }
  }

  return [...byName.values()];
}

function validateSemantics(
  sourceFiles: readonly string[],
): (value: unknown) => SemanticItem[] {
  return (value: unknown): SemanticItem[] => {
    const candidate = (value as { semantics?: unknown } | null)?.semantics;
    if (!Array.isArray(candidate)) throw new Error("expected a semantics array");

    return candidate.map((raw, index): SemanticItem => {
      const item = raw as Partial<SemanticItem> | null;
      const name = typeof item?.name === "string" ? item.name.trim() : "";
      if (!name) throw new Error(`semantic #${index} has an empty name`);

      const category =
        typeof item?.category === "string" ? canonicalDefiCategory(item.category) : null;
      if (!category) {
        throw new Error(`semantic '${name}' has an unknown DeFi category`);
      }

      if (typeof item?.definition !== "string" || typeof item?.description !== "string") {
        throw new Error(`semantic '${name}' is missing definition or description`);
      }

      if (!Array.isArray(item.functions) || item.functions.length === 0) {
        throw new Error(`semantic '${name}' must have at least one function`);
      }

      const functions = item.functions.map((rawFn, fnIndex) => {
        const fn = rawFn as { name?: unknown; contract?: unknown; signature?: unknown } | null;
        const fnName = typeof fn?.name === "string" ? fn.name.trim() : "";
        const contract = typeof fn?.contract === "string" ? normalizeContract(fn.contract) : "";
        if (!fnName) {
          throw new Error(`semantic '${name}' function #${fnIndex} has an empty name`);
        }
        if (!contract || !sourceFiles.includes(contract)) {
          throw new Error(
            `semantic '${name}' references '${contract}', which is not in the snapshot`,
          );
        }
        const signature =
          typeof fn?.signature === "string" && fn.signature.trim()
            ? fn.signature.trim()
            : undefined;
        return { name: fnName, contract, ...(signature ? { signature } : {}) };
      });

      return {
        name,
        category,
        definition: item.definition,
        description: item.description,
        functions,
      };
    });
  };
}

export async function extractSemantics(
  ctx: StageContext,
): Promise<{ rawIds: number[] }> {
  const projectId = findProject(ctx);

  // A crash between the insert transaction and the journal update makes the
  // stage look unfinished on resume. Reuse what the project already owns
  // instead of asking the model again and inserting duplicate rows.
  if (projectId !== null) {
    const existing = ctx.db.all<{ id: number }>(
      `select semantic_node_id as id
         from project_semantic
        where project_id = ?
        order by semantic_node_id`,
      [projectId],
    );
    if (existing.length > 0) {
      return { rawIds: existing.map((row) => row.id) };
    }
  }

  const categories = projectId === null ? [] : projectCategories(ctx, projectId);
  const materials = buildProjectMaterials(ctx);
  const overhead = Math.ceil(
    buildExtractSemanticsPrompt({ chunk: "", schemaHint: "", categories }).length / 4,
  );
  const chunkTokens = resolveChunkTokens({
    contextWindow: ctx.contextWindow,
    overheadTokens: overhead,
  });
  const chunks = chunkByBudget(materials, chunkTokens);
  const collected: SemanticItem[] = [];

  for (let index = 0; index < chunks.length; index++) {
    await ctx.onProgress?.({
      title: "KNOWDIT build",
      stage: "semantics",
      contest: ctx.contest.c4Id,
      detail: `Extracting semantics · chunk ${index + 1}/${chunks.length} · C4 ${ctx.contest.c4Id}`,
      completed: index,
      total: chunks.length,
    });

    const { value } = await ctx.llm.json({
      prompt: buildExtractSemanticsPrompt({ chunk: chunks[index], schemaHint: "", categories }),
      validate: validateSemantics(ctx.contest.sourceFiles),
    });
    collected.push(...value);
  }

  const deduped = dedupSemantics(collected);
  if (deduped.length === 0) return { rawIds: [] };

  const ownerId = projectId ?? ensureProject(ctx);
  const rawIds = ctx.db.tx(() => {
    const ids: number[] = [];
    for (const item of deduped) {
      const id = ctx.db.run(
        "insert into semantic_node (name, definition, description, category) values (?, ?, ?, ?)",
        [item.name, item.definition, item.description, item.category],
      ).lastInsertRowid;

      for (const fn of item.functions) {
        ctx.db.run(
          "insert into semantic_function (semantic_node_id, function_name, contract_path) values (?, ?, ?)",
          [id, fn.name, fn.contract],
        );
      }

      ctx.db.run(
        "insert into project_semantic (project_id, semantic_node_id) values (?, ?)",
        [ownerId, id],
      );
      ids.push(id);
    }
    return ids;
  });

  return { rawIds };
}
