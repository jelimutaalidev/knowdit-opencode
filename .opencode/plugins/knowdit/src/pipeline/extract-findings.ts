import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSeverity,
  maxSeverity,
  resolveTaxonomyEntry,
  validateTaxonomyPair,
} from "../domain/validate.ts";
import { buildExtractFindingsPrompt } from "../prompts/index.ts";
import { chunkByBudget } from "./chunk.ts";
import { ensureProject, findProject, projectCategories } from "./project.ts";
import type { FindingItem, StageContext } from "./types.ts";

export type { FindingItem } from "./types.ts";

export const DEFAULT_CHUNK_TOKENS = 8_000;

export function dedupFindings(items: FindingItem[]): FindingItem[] {
  const byTitle = new Map<string, FindingItem>();

  for (const finding of items) {
    const key = finding.title.toLowerCase().trim();
    const existing = byTitle.get(key);
    if (!existing) {
      byTitle.set(key, { ...finding });
      continue;
    }

    existing.severity = maxSeverity(existing.severity, finding.severity);

    if (finding.description.length > existing.description.length) {
      existing.category = finding.category;
      existing.subcategory = finding.subcategory;
      existing.description = finding.description;
    }
    if (finding.root_cause.length > existing.root_cause.length) {
      existing.root_cause = finding.root_cause;
    }
    if (finding.patterns.length > existing.patterns.length) {
      existing.patterns = finding.patterns;
    }
    if (finding.exploits.length > existing.exploits.length) {
      existing.exploits = finding.exploits;
    }
  }

  return [...byTitle.values()];
}

function validateFindings(value: unknown): FindingItem[] {
  const candidate = (value as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(candidate)) throw new Error("expected a findings array");

  return candidate.map((raw, index): FindingItem => {
    const item = raw as Partial<FindingItem> | null;
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    if (!title) throw new Error(`finding #${index} has an empty title`);

    const severity = item?.severity;
    if (typeof severity !== "string" || !isSeverity(severity)) {
      throw new Error(`finding '${title}' has invalid severity '${String(severity)}'`);
    }

    const category = typeof item?.category === "string" ? item.category.trim() : "";
    const subcategory =
      typeof item?.subcategory === "string" ? item.subcategory.trim() : "";
    const pairError = validateTaxonomyPair(category, subcategory);
    if (pairError) throw new Error(pairError);

    const entry = resolveTaxonomyEntry(category, subcategory)!;
    for (const field of ["root_cause", "description", "patterns", "exploits"] as const) {
      if (typeof item?.[field] !== "string") {
        throw new Error(`finding '${title}' is missing '${field}'`);
      }
    }

    return {
      title,
      severity,
      category: entry.category,
      subcategory: entry.subcategory,
      root_cause: item.root_cause!.trim(),
      description: item.description!.trim(),
      patterns: item.patterns!.trim(),
      exploits: item.exploits!.trim(),
    };
  });
}

export async function extractFindings(
  ctx: StageContext,
): Promise<{ rawIds: number[] }> {
  const report = readFileSync(
    join(ctx.datasetDir, "reports", `${ctx.contest.c4Id}.md`),
    "utf8",
  );
  const projectId = findProject(ctx);

  // A crash between the insert transaction and the journal update makes the
  // stage look unfinished on resume. Reuse what the project already owns
  // instead of asking the model again and inserting duplicate rows.
  if (projectId !== null) {
    const existing = ctx.db.all<{ id: number }>(
      `select audit_finding_id as id
         from project_finding
        where project_id = ?
        order by audit_finding_id`,
      [projectId],
    );
    if (existing.length > 0) {
      return { rawIds: existing.map((row) => row.id) };
    }
  }

  const categories = projectId === null ? [] : projectCategories(ctx, projectId);
  const chunks = chunkByBudget(report, DEFAULT_CHUNK_TOKENS);
  const collected: FindingItem[] = [];

  for (let index = 0; index < chunks.length; index++) {
    await ctx.onProgress?.({
      title: "KNOWDIT build",
      stage: "findings",
      contest: ctx.contest.c4Id,
      detail: `Extracting findings · chunk ${index + 1}/${chunks.length} · C4 ${ctx.contest.c4Id}`,
      completed: index,
      total: chunks.length,
    });

    const { value } = await ctx.llm.json({
      prompt: buildExtractFindingsPrompt({ chunk: chunks[index], schemaHint: "", categories }),
      validate: validateFindings,
    });
    collected.push(...value);
  }

  const deduped = dedupFindings(collected);
  if (deduped.length === 0) return { rawIds: [] };

  const ownerId = projectId ?? ensureProject(ctx);
  const rawIds = ctx.db.tx(() => {
    const ids: number[] = [];
    for (const finding of deduped) {
      const id = ctx.db.run(
        `insert into audit_finding
           (title, severity, root_cause, description, patterns, exploits)
         values (?, ?, ?, ?, ?, ?)`,
        [
          finding.title,
          finding.severity,
          finding.root_cause,
          finding.description,
          finding.patterns,
          finding.exploits,
        ],
      ).lastInsertRowid;

      const taxonomy = ctx.db.get<{ id: number }>(
        "select id from finding_category where category = ? and name = ?",
        [finding.category, finding.subcategory],
      );
      if (!taxonomy) {
        throw new Error(
          `taxonomy row '${finding.category}/${finding.subcategory}' is missing from the seed table`,
        );
      }
      ctx.db.run(
        "insert into audit_finding_category (audit_finding_id, finding_category_id) values (?, ?)",
        [id, taxonomy.id],
      );
      ctx.db.run(
        "insert into project_finding (project_id, audit_finding_id) values (?, ?)",
        [ownerId, id],
      );
      ids.push(id);
    }
    return ids;
  });

  return { rawIds };
}
