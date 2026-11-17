import { buildInProjectLinkPrompt } from "../prompts/index.ts";
import { inProjectEvidence } from "./evidence.ts";
import { findProject, projectCategories } from "./project.ts";
import type { StageContext } from "./types.ts";

export { IN_PROJECT_LINK_EVIDENCE_PREFIX, inProjectEvidence } from "./evidence.ts";

export const MAX_LINK_ATTEMPTS = 3;

type SemanticRow = {
  id: number;
  name: string;
  category: string;
  definition: string;
  description: string;
};

type FindingRow = {
  id: number;
  title: string;
  severity: string;
  category: string;
  subcategory: string;
  root_cause: string;
  description: string;
  patterns: string;
};

function renderSemantics(semantics: readonly SemanticRow[]): string {
  return semantics
    .map(
      (semantic, index) =>
        `S${index}\nname: ${semantic.name}\ncategory: ${semantic.category}\n` +
        `definition: ${semantic.definition.trim()}\n` +
        `description: ${semantic.description.trim()}\n\n`,
    )
    .join("");
}

function renderFindings(findings: readonly FindingRow[]): string {
  return findings
    .map(
      (finding, index) =>
        `F${index}\ntitle: ${finding.title}\nseverity: ${finding.severity}\n` +
        `category: ${finding.category}\nsubcategory: ${finding.subcategory}\n` +
        `root_cause: ${finding.root_cause.trim()}\n` +
        `description: ${finding.description.trim()}\n` +
        `patterns: ${finding.patterns.trim()}\n\n`,
    )
    .join("");
}

function validateLinks(
  findingCount: number,
  semanticCount: number,
): (value: unknown) => [number, number][] {
  return (value: unknown): [number, number][] => {
    const entries = (value as { links?: unknown } | null)?.links;
    if (!Array.isArray(entries)) throw new Error("expected a links array");

    const edges: [number, number][] = [];
    const seen = new Set<string>();
    const covered = new Set<number>();

    for (const raw of entries) {
      const entry = raw as { finding_index?: unknown; semantic_indices?: unknown } | null;
      const findingIndex = entry?.finding_index;
      if (
        typeof findingIndex !== "number" ||
        !Number.isInteger(findingIndex) ||
        findingIndex < 0 ||
        findingIndex >= findingCount
      ) {
        throw new Error(
          `in-project link response references unknown finding_index ${String(findingIndex)}`,
        );
      }

      const semanticIndices = entry?.semantic_indices;
      if (!Array.isArray(semanticIndices) || semanticIndices.length === 0) {
        throw new Error(
          `in-project link response left finding_index ${findingIndex} unlinked (rule violation)`,
        );
      }

      for (const semanticIndex of semanticIndices) {
        if (
          typeof semanticIndex !== "number" ||
          !Number.isInteger(semanticIndex) ||
          semanticIndex < 0 ||
          semanticIndex >= semanticCount
        ) {
          throw new Error(
            `in-project link response references unknown semantic_index ${String(semanticIndex)} for finding ${findingIndex}`,
          );
        }
        const key = `${findingIndex}:${semanticIndex}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push([findingIndex, semanticIndex]);
        }
      }

      covered.add(findingIndex);
    }

    const missing = Array.from({ length: findingCount }, (_, index) => index).filter(
      (index) => !covered.has(index),
    );
    if (missing.length > 0) {
      throw new Error(`in-project link response left finding(s) unlinked: [${missing.join(", ")}]`);
    }

    return edges;
  };
}

export async function linkInProject(
  ctx: StageContext,
): Promise<{ edges: number }> {
  const projectId = findProject(ctx);
  if (projectId === null) return { edges: 0 };

  const semantics = ctx.db.all<SemanticRow>(
    `select sn.id, sn.name, sn.category, sn.definition, sn.description
       from semantic_node sn
       join project_semantic ps on ps.semantic_node_id = sn.id
      where ps.project_id = ?
      order by sn.id`,
    [projectId],
  );
  const findings = ctx.db.all<FindingRow>(
    `select af.id, af.title, af.severity, af.root_cause, af.description, af.patterns,
            fc.category, fc.name as subcategory
       from audit_finding af
       join project_finding pf on pf.audit_finding_id = af.id
       join audit_finding_category afc on afc.audit_finding_id = af.id
       join finding_category fc on fc.id = afc.finding_category_id
      where pf.project_id = ?
      order by af.id`,
    [projectId],
  );

  if (semantics.length === 0 || findings.length === 0) return { edges: 0 };

  const prompt = buildInProjectLinkPrompt({
    categories: projectCategories(ctx, projectId),
    semantics: renderSemantics(semantics),
    findings: renderFindings(findings),
  });

  let lastError: unknown = new Error("in-project linking made no attempts");
  for (let attempt = 0; attempt < MAX_LINK_ATTEMPTS; attempt++) {
    try {
      const { value: edges } = await ctx.llm.json({
        prompt,
        validate: validateLinks(findings.length, semantics.length),
      });

      const evidence = inProjectEvidence();
      ctx.db.tx(() => {
        for (const [findingIndex, semanticIndex] of edges) {
          ctx.db.run(
            `insert or ignore into semantic_finding_link
               (semantic_node_id, audit_finding_id, strength, evidence)
             values (?, ?, 'High', ?)`,
            [semantics[semanticIndex].id, findings[findingIndex].id, evidence],
          );
        }
      });

      return { edges: edges.length };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}
