import { canonicalDefiCategory } from "../domain/validate.ts";
import { buildCategorizePrompt } from "../prompts/index.ts";
import { buildProjectMaterials } from "./materials.ts";
import { ensureProject } from "./project.ts";
import type { StageContext } from "./types.ts";

function dedupe(categories: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const category of categories) {
    if (seen.has(category)) continue;
    seen.add(category);
    out.push(category);
  }
  return out;
}

function validateCategories(value: unknown): string[] {
  const candidate = (value as { categories?: unknown } | null)?.categories;
  if (!Array.isArray(candidate) || candidate.length === 0) {
    throw new Error("expected a non-empty categories array");
  }
  const categories: string[] = [];
  for (const item of candidate) {
    if (typeof item !== "string") throw new Error("categories must be strings");
    const canonical = canonicalDefiCategory(item);
    if (!canonical) throw new Error(`unknown DeFi category '${item}'`);
    categories.push(canonical);
  }
  return dedupe(categories);
}

export async function categorizeProject(
  ctx: StageContext,
): Promise<{ projectId: number; categories: string[] }> {
  const { value: categories } = await ctx.llm.json({
    prompt: buildCategorizePrompt(buildProjectMaterials(ctx)),
    validate: validateCategories,
  });

  const projectId = ctx.db.tx(() => {
    const id = ensureProject(ctx);
    ctx.db.run("update project set status = 'completed' where id = ?", [id]);

    ctx.db.run("delete from project_category where project_id = ?", [id]);
    for (const name of categories) {
      const category = ctx.db.get<{ id: number }>(
        "select id from category where name = ?",
        [name],
      );
      if (!category) throw new Error(`category '${name}' is missing from the seed table`);
      ctx.db.run(
        "insert into project_category (project_id, category_id) values (?, ?)",
        [id, category.id],
      );
    }

    return id;
  });

  return { projectId, categories };
}
