import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSeverity,
  maxSeverity,
  resolveTaxonomyEntry,
  validateTaxonomyPair,
} from "../domain/validate.ts";
import { buildExtractFindingsPrompt, buildFindingRepairPrompt } from "../prompts/index.ts";
import { chunkByBudget, resolveChunkTokens } from "./chunk.ts";
import { ensureProject, findProject, projectCategories } from "./project.ts";
import type { FindingItem, StageContext } from "./types.ts";

export type { FindingItem } from "./types.ts";

export const DEFAULT_CHUNK_TOKENS = 8_000;
/** Bounded repair passes per report chunk; still-invalid items are dropped. */
export const MAX_FINDING_REPAIR_ATTEMPTS = 2;

export type RejectedFinding = {
  index: number;
  title: string;
  reason: string;
  item: unknown;
};

export type ParsedFindings = {
  valid: FindingItem[];
  rejected: RejectedFinding[];
};

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

/**
 * Validate a chunk response per item. A structurally wrong response (no
 * `findings` array) is fatal, but one malformed item must not discard the
 * other valid findings in the same model response: it is returned with the
 * reason that the repair prompt will carry.
 */
export function parseFindings(value: unknown): ParsedFindings {
  const candidate = (value as { findings?: unknown } | null)?.findings;
  if (!Array.isArray(candidate)) throw new Error("expected a findings array");

  const valid: FindingItem[] = [];
  const rejected: RejectedFinding[] = [];

  candidate.forEach((raw, index) => {
    const item = raw as Partial<FindingItem> | null;
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    const reject = (reason: string): void => {
      rejected.push({ index, title, reason, item: raw });
    };
    if (!title) return reject(`finding #${index} has an empty title`);

    const severity = item?.severity;
    if (typeof severity !== "string" || !isSeverity(severity)) {
      return reject(`finding '${title}' has invalid severity '${String(severity)}'`);
    }

    const category = typeof item?.category === "string" ? item.category.trim() : "";
    const subcategory =
      typeof item?.subcategory === "string" ? item.subcategory.trim() : "";
    const pairError = validateTaxonomyPair(category, subcategory);
    if (pairError) return reject(pairError);

    for (const field of ["root_cause", "description", "patterns", "exploits"] as const) {
      if (typeof item?.[field] !== "string") {
        return reject(`finding '${title}' is missing '${field}'`);
      }
    }

    const entry = resolveTaxonomyEntry(category, subcategory)!;
    valid.push({
      title,
      severity,
      category: entry.category,
      subcategory: entry.subcategory,
      root_cause: item.root_cause!.trim(),
      description: item.description!.trim(),
      patterns: item.patterns!.trim(),
      exploits: item.exploits!.trim(),
    });
  });

  return { valid, rejected };
}

function normalizeTitle(title: string): string {
  return title.trim().toLowerCase();
}

function findingIdentity(title: string, rootCause: string): string {
  return `${normalizeTitle(title)}\u0000${rootCause}`;
}

/**
 * Fold one repair response back into the outstanding rejections.
 *
 * An outstanding item is resolved when its title now validates, replaced by
 * the model's updated rejection when it is still invalid, and counted as
 * dropped when the model omitted it (the repair prompt explicitly allows
 * omitting items the report does not support).
 */
function advanceRejected(
  outstanding: readonly RejectedFinding[],
  repaired: ParsedFindings,
  acceptedFindings: readonly { title: string; rootCause: string }[],
): { remaining: RejectedFinding[]; dropped: number } {
  // Outcomes are matched to outstanding items as occurrence queues, not as
  // title sets: two distinct findings can share a title, so one repaired item
  // must not resolve both of them. An echo of an already-accepted finding is
  // not an outcome for any outstanding rejection.
  const acceptedIdentities = new Set(
    acceptedFindings.map((entry) => findingIdentity(entry.title, entry.rootCause)),
  );
  const accepted = new Map<string, number>();
  for (const item of repaired.valid) {
    if (acceptedIdentities.has(findingIdentity(item.title, item.root_cause))) continue;
    const key = normalizeTitle(item.title);
    accepted.set(key, (accepted.get(key) ?? 0) + 1);
  }
  const stillInvalid = new Map<string, RejectedFinding[]>();
  for (const item of repaired.rejected) {
    const key = normalizeTitle(item.title);
    const queue = stillInvalid.get(key) ?? [];
    queue.push(item);
    stillInvalid.set(key, queue);
  }
  const remaining: RejectedFinding[] = [];
  let dropped = 0;

  for (const item of outstanding) {
    const key = normalizeTitle(item.title);
    const acceptedCount = accepted.get(key) ?? 0;
    if (acceptedCount > 0) {
      accepted.set(key, acceptedCount - 1);
      continue;
    }
    const replacements = stillInvalid.get(key);
    if (replacements && replacements.length > 0) {
      remaining.push(replacements.shift()!);
    } else {
      dropped += 1;
    }
  }
  // Repair output beyond the outstanding occurrences is not a new rejection:
  // discarding it keeps a repeated response from inflating the queue.

  return { remaining, dropped };
}

export async function extractFindings(
  ctx: StageContext,
): Promise<{ rawIds: number[]; dropped: number }> {
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
      return { rawIds: existing.map((row) => row.id), dropped: 0 };
    }
  }

  const categories = projectId === null ? [] : projectCategories(ctx, projectId);
  const overhead = Math.ceil(
    buildExtractFindingsPrompt({ chunk: "", schemaHint: "", categories }).length / 4,
  );
  const chunkTokens = resolveChunkTokens({
    contextWindow: ctx.contextWindow,
    overheadTokens: overhead,
  });
  const chunks = chunkByBudget(report, chunkTokens);
  const collected: FindingItem[] = [];
  let dropped = 0;

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
      validate: parseFindings,
    });
    collected.push(...value.valid);

    const acceptedFindings: { title: string; rootCause: string }[] = value.valid.map(
      (entry) => ({ title: entry.title, rootCause: entry.root_cause }),
    );
    let outstanding = value.rejected;

    for (let attempt = 1; attempt <= MAX_FINDING_REPAIR_ATTEMPTS; attempt++) {
      if (outstanding.length === 0) break;
      await ctx.onProgress?.({
        title: "KNOWDIT build",
        stage: "findings",
        contest: ctx.contest.c4Id,
        detail:
          `Repairing findings · chunk ${index + 1}/${chunks.length}` +
          ` · attempt ${attempt}/${MAX_FINDING_REPAIR_ATTEMPTS}` +
          ` · ${outstanding.length} rejected · C4 ${ctx.contest.c4Id}`,
        completed: index,
        total: chunks.length,
      });

      const repair = await ctx.llm.json({
        prompt: buildFindingRepairPrompt({
          chunk: chunks[index],
          acceptedFindings,
          rejected: outstanding,
          schemaHint: "",
        }),
        validate: parseFindings,
      });
      const advanced = advanceRejected(outstanding, repair.value, acceptedFindings);
      collected.push(...repair.value.valid);
      for (const finding of repair.value.valid) {
        if (
          !acceptedFindings.some(
            (entry) => entry.title === finding.title && entry.rootCause === finding.root_cause,
          )
        ) {
          acceptedFindings.push({
            title: finding.title,
            rootCause: finding.root_cause,
          });
        }
      }

      outstanding = advanced.remaining;
      dropped += advanced.dropped;
    }

    // Anything still rejected after the bounded repair passes is dropped.
    dropped += outstanding.length;
  }

  const deduped = dedupFindings(collected);
  if (deduped.length === 0) return { rawIds: [], dropped };

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

  return { rawIds, dropped };
}
