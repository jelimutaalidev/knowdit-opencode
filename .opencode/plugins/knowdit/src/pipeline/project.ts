import type { StageContext } from "./types.ts";

export function findProject(ctx: StageContext): number | null {
  const platformId = `c4-${ctx.contest.c4Id}`;
  const existing = ctx.db.get<{ id: number }>(
    `select p.id as id
       from project p
       join project_platform pp on pp.project_id = p.id
      where pp.platform_id = ?`,
    [platformId],
  );
  return existing?.id ?? null;
}

/**
 * Find (or create) the project row for this contest.
 *
 * Stages are runnable on their own, so each stage must be able to bootstrap
 * the project. `categorizeProject` promotes the row to `completed`.
 */
export function ensureProject(ctx: StageContext, status = "running"): number {
  const existing = findProject(ctx);
  if (existing !== null) return existing;

  const id = ctx.db.run("insert into project (name, status) values (?, ?)", [
    ctx.contest.slug,
    status,
  ]).lastInsertRowid;
  ctx.db.run("insert into project_platform (project_id, platform_id) values (?, ?)", [
    id,
    `c4-${ctx.contest.c4Id}`,
  ]);
  return id;
}

export function projectCategories(ctx: StageContext, projectId: number): string[] {
  return ctx.db
    .all<{ name: string }>(
      `select c.name as name
         from category c
         join project_category pc on pc.category_id = c.id
        where pc.project_id = ?
        order by c.id`,
      [projectId],
    )
    .map((row) => row.name);
}
