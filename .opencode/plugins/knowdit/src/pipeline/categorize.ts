import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFI_CATEGORIES } from "../domain/categories.ts";
import { isDefiCategory } from "../domain/validate.ts";
import { buildCategorizePrompt } from "../prompts/index.ts";
import type { StageContext } from "./types.ts";

const MAX_FILES = 50;
const MAX_CHARS_PER_FILE = 2_000;

function canonicalCategory(value: string): string {
  const normalize = (input: string) =>
    input
      .trim()
      .toLowerCase()
      .replace(/[_-]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
  const target = normalize(value);
  return DEFI_CATEGORIES.find((category) => normalize(category) === target)!;
}

function buildMaterials(ctx: StageContext): string {
  let content = "## Source Files\n\n";
  for (const file of ctx.contest.sourceFiles.slice(0, MAX_FILES)) {
    let source = "";
    try {
      source = readFileSync(
        join(ctx.datasetDir, "contracts", String(ctx.contest.c4Id), file),
        "utf8",
      ).slice(0, MAX_CHARS_PER_FILE);
    } catch {
      continue;
    }
    content += `### ${file}\n\`\`\`solidity\n${source}\n\`\`\`\n\n`;
  }
  return content;
}

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
    if (!isDefiCategory(item)) throw new Error(`unknown DeFi category '${item}'`);
    categories.push(canonicalCategory(item));
  }
  return dedupe(categories);
}

export async function categorizeProject(
  ctx: StageContext,
): Promise<{ projectId: number; categories: string[] }> {
  const { value: categories } = await ctx.llm.json({
    prompt: buildCategorizePrompt(buildMaterials(ctx)),
    validate: validateCategories,
  });

  const platformId = `c4-${ctx.contest.c4Id}`;

  const projectId = ctx.db.tx(() => {
    const existing = ctx.db.get<{ id: number }>(
      `select p.id as id
         from project p
         join project_platform pp on pp.project_id = p.id
        where pp.platform_id = ?`,
      [platformId],
    );

    let id: number;
    if (existing) {
      id = existing.id;
      ctx.db.run("update project set status = 'completed' where id = ?", [id]);
    } else {
      id = ctx.db.run("insert into project (name, status) values (?, 'completed')", [
        ctx.contest.slug,
      ]).lastInsertRowid;
    }

    const platform = ctx.db.get<{ n: number }>(
      "select count(*) n from project_platform where project_id = ?",
      [id],
    );
    if (!platform || platform.n === 0) {
      ctx.db.run(
        "insert into project_platform (project_id, platform_id) values (?, ?)",
        [id, platformId],
      );
    }

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
