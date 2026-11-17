import type { KgDb } from "../db/client.ts";
import type { Journal } from "../journal.ts";
import { isModelLimitError } from "../llm/caller.ts";
import type { LlmCaller } from "../llm/types.ts";
import { buildFindingLinkEntry, buildGlobalLinkPrompt } from "../prompts/index.ts";

export const HIGH_EVIDENCE_MIN_WORDS = 6;
export const MAX_LINKS_PER_FINDING = 2;
export const MAX_LINK_ATTEMPTS = 3;

type Strength = "High" | "Medium" | "Low";

type FindingRow = {
  id: number;
  title: string;
  severity: string;
  root_cause: string;
  description: string;
  patterns: string;
  exploits: string;
  category: string;
  subcategory: string;
  platform_id: string | null;
};

type CandidateRow = {
  id: number;
  name: string;
  category: string;
  definition: string;
  description: string;
};

type ResolvedLink = {
  semanticId: number;
  strength: Strength;
  evidence: string;
};

/**
 * Longest run of consecutive words from `evidence` that appears verbatim in
 * `findingText`. Case-insensitive; punctuation is dropped.
 */
export function countVerbatimWords(findingText: string, evidence: string): number {
  const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const finding = words(findingText);
  const probe = words(evidence);
  if (finding.length === 0 || probe.length === 0) return 0;

  let best = 0;
  let previous = new Array<number>(finding.length + 1).fill(0);
  for (let i = 1; i <= probe.length; i++) {
    const current = new Array<number>(finding.length + 1).fill(0);
    for (let j = 1; j <= finding.length; j++) {
      if (probe[i - 1] === finding[j - 1]) {
        current[j] = previous[j - 1] + 1;
        if (current[j] > best) best = current[j];
      }
    }
    previous = current;
  }
  return best;
}

function parseStrength(value: unknown): Strength {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "high") return "High";
  if (normalized === "medium") return "Medium";
  if (normalized === "low") return "Low";
  throw new Error(`unknown link strength '${String(value)}'`);
}

function findingText(finding: FindingRow): string {
  return [
    finding.title,
    finding.root_cause,
    finding.description,
    finding.patterns,
    finding.exploits,
  ].join("\n");
}

function validateDecision(
  finding: FindingRow,
  findingId: string,
  candidateIds: ReadonlySet<number>,
): (value: unknown) => ResolvedLink[] {
  return (value: unknown): ResolvedLink[] => {
    const links = (value as { links?: unknown } | null)?.links;
    if (!Array.isArray(links)) throw new Error("expected a links array");

    const entry = links.find(
      (raw) => (raw as { finding_id?: unknown } | null)?.finding_id === findingId,
    ) as { semantic_evidence?: unknown } | undefined;
    if (!entry) return [];
    if (!Array.isArray(entry.semantic_evidence)) {
      throw new Error(`finding '${findingId}' is missing semantic_evidence`);
    }

    const resolved: ResolvedLink[] = [];
    for (const raw of entry.semantic_evidence) {
      const evidence = raw as {
        semantic_id?: unknown;
        strength?: unknown;
        why_finding_can_fire?: unknown;
      } | null;

      const semanticId = Number(evidence?.semantic_id);
      if (!Number.isInteger(semanticId) || !candidateIds.has(semanticId)) {
        throw new Error(
          `evidence references semantic_id '${String(evidence?.semantic_id)}' which is not a candidate`,
        );
      }

      const strength = parseStrength(evidence?.strength);
      const why = String(evidence?.why_finding_can_fire ?? "").trim();
      if (!why) {
        throw new Error(`evidence for semantic '${semanticId}' is empty`);
      }

      if (strength === "High") {
        const run = countVerbatimWords(findingText(finding), why);
        if (run < HIGH_EVIDENCE_MIN_WORDS) {
          throw new Error(
            `High evidence for semantic '${semanticId}' must contain at least ` +
              `${HIGH_EVIDENCE_MIN_WORDS} consecutive verbatim words copied from the finding text ` +
              `(found ${run}). Re-emit with a real fragment or demote the entry.`,
          );
        }
      }

      resolved.push({ semanticId, strength, evidence: why });
    }

    return resolved.slice(0, MAX_LINKS_PER_FINDING);
  };
}

function renderCandidate(row: CandidateRow): string {
  return (
    `ID: ${row.id}\nCategory: ${row.category}\nName: ${row.name}\n` +
    `Definition: ${row.definition}\nDescription: ${row.description}\n\n`
  );
}

export async function linkGlobal(opts: {
  db: KgDb;
  llm: LlmCaller;
  journal: Journal;
  c4Ids?: number[];
  onProgress?: (update: Record<string, unknown>) => void | Promise<void>;
}): Promise<{ linked: number; pendingQueued: number; pendingDrained: number }> {
  const { db, llm, journal } = opts;
  const emit = async (update: Record<string, unknown>) => {
    if (opts.onProgress) await opts.onProgress(update);
  };

  const candidates = db.all<CandidateRow>(
    `select id, name, category, definition, description
       from semantic_node
      where not exists (select 1 from semantic_merge sm where sm.from_semantic_id = semantic_node.id)
      order by id`,
  );
  if (candidates.length === 0) {
    return { linked: 0, pendingQueued: 0, pendingDrained: 0 };
  }

  const candidateBlock = candidates.map(renderCandidate).join("");
  const candidateIds = new Set(candidates.map((row) => row.id));

  const pendingDrained = db.run(
    `delete from pending_semantic
      where semantic_node_id in (
        select id from semantic_node
         where not exists (select 1 from semantic_merge sm where sm.from_semantic_id = semantic_node.id)
      )`,
  ).changes;

  const filters: string[] = [
    "not exists (select 1 from finding_link_status fls where fls.audit_finding_id = af.id)",
  ];
  const params: unknown[] = [];
  if (opts.c4Ids && opts.c4Ids.length > 0) {
    filters.push(
      `exists (
         select 1 from project_finding pf
           join project_platform pp on pp.project_id = pf.project_id
          where pf.audit_finding_id = af.id
            and pp.platform_id in (${opts.c4Ids.map(() => "?").join(", ")})
       )`,
    );
    params.push(...opts.c4Ids.map((id) => `c4-${id}`));
  }

  const findings = db.all<FindingRow>(
    `select af.id, af.title, af.severity, af.root_cause, af.description, af.patterns,
            af.exploits, fc.category, fc.name as subcategory,
            (select pp.platform_id
               from project_finding pf
               join project_platform pp on pp.project_id = pf.project_id
              where pf.audit_finding_id = af.id
              limit 1) as platform_id
       from audit_finding af
       join audit_finding_category afc on afc.audit_finding_id = af.id
       join finding_category fc on fc.id = afc.finding_category_id
      where ${filters.join(" and ")}
      order by af.id`,
    params,
  );

  let linked = 0;
  const failures: { findingId: number; error: string }[] = [];
  let stoppedEarly = false;

  await emit({
    event: "global_start",
    candidates: candidates.length,
    findings: findings.length,
  });

  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index];
    const findingId = `F-${finding.id}`;
    const projectCategories = finding.platform_id
      ? db
          .all<{ name: string }>(
            `select c.name
               from category c
               join project_category pc on pc.category_id = c.id
               join project_platform pp on pp.project_id = pc.project_id
              where pp.platform_id = ?
              order by c.id`,
            [finding.platform_id],
          )
          .map((row) => row.name)
      : [];

    const basePrompt = buildGlobalLinkPrompt({
      candidateSemantics: candidateBlock,
      findings: buildFindingLinkEntry({
        findingId,
        projectCategories,
        title: finding.title,
        severity: finding.severity,
        category: finding.category,
        subcategory: finding.subcategory,
        rootCause: finding.root_cause,
        description: finding.description,
        patterns: finding.patterns,
        exploits: finding.exploits,
      }),
    });

    const c4Id = finding.platform_id?.startsWith("c4-")
      ? Number(finding.platform_id.slice(3))
      : 0;
    const unit = { stage: "link_global", c4Id, unitIndex: finding.id };

    await emit({
      event: "global_finding",
      index: index + 1,
      total: findings.length,
      c4Id,
      findingId: finding.id,
      status: "start",
    });

    let prompt = basePrompt;
    let resolved: ResolvedLink[] | null = null;
    let lastError: unknown = new Error("global linking made no attempts");

    journal.start(unit);
    for (let attempt = 0; attempt < MAX_LINK_ATTEMPTS; attempt++) {
      try {
        const { value } = await llm.json({
          prompt,
          validate: validateDecision(finding, findingId, candidateIds),
        });
        resolved = value;
        break;
      } catch (error) {
        lastError = error;
        const reason = error instanceof Error ? error.message : String(error);
        prompt = `${basePrompt}\n\nYour previous response was rejected: ${reason}\nRe-emit valid JSON for this finding only.`;
        if (isModelLimitError(error)) break;
      }
    }

    if (resolved === null) {
      const message = lastError instanceof Error ? lastError.message : String(lastError);
      journal.fail(unit, message);
      failures.push({ findingId: finding.id, error: message });
      await emit({
        event: "global_finding",
        index: index + 1,
        total: findings.length,
        c4Id,
        findingId: finding.id,
        status: "failed",
        error: message,
      });
      if (isModelLimitError(lastError)) {
        stoppedEarly = true;
        break;
      }
      continue;
    }

    db.tx(() => {
      for (const link of resolved) {
        // The reference `append_semantic_finding_links` never overwrites an
        // existing edge, so an in-project link keeps its High strength and
        // synthetic evidence even when the global pass picks the same pair.
        db.run(
          `insert or ignore into semantic_finding_link
             (semantic_node_id, audit_finding_id, strength, evidence)
           values (?, ?, ?, ?)`,
          [link.semanticId, finding.id, link.strength, link.evidence],
        );
      }
      db.run(
        "insert or replace into finding_link_status (audit_finding_id) values (?)",
        [finding.id],
      );
    });

    journal.done(unit);
    linked += 1;
    await emit({
      event: "global_finding",
      index: index + 1,
      total: findings.length,
      c4Id,
      findingId: finding.id,
      status: "done",
    });
  }

  await emit({
    event: "global_done",
    linked,
    failed: failures.length,
    pendingDrained,
    stoppedEarly,
  });

  if (failures.length > 0) {
    const remaining = findings.length - linked;
    const suffix = stoppedEarly
      ? ` Stopped early on a model limit; ${remaining} finding(s) remain unprocessed.`
      : ` ${failures.length} finding(s) failed; ${remaining - failures.length} were not attempted.`;
    throw new Error(
      `global link failed for ${failures.length} finding(s); first error: ${failures[0].error}.` +
        `${suffix} Rerun kg_build to retry only findings without a link status; ` +
        "completed decisions are cached.",
    );
  }

  return { linked, pendingQueued: 0, pendingDrained };
}
