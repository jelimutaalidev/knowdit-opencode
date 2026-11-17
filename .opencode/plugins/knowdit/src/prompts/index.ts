import { readFileSync } from "node:fs";
import { DEFI_CATEGORIES } from "../domain/categories.ts";
import { FINDING_TAXONOMY } from "../domain/taxonomy.ts";

function text(name: string): string {
  return readFileSync(new URL(`./texts/${name}`, import.meta.url), "utf8");
}

export const GENERAL_ROLE_SYSTEM = text("role.txt");

const CATEGORY_DEFINITIONS = text("category_definitions.txt");
const PROJECT_PREFIX_HEAD = text("project_prefix_head.txt");
const PROJECT_MATERIALS_HEADER = text("project_materials_header.txt");
const REPORT_PREFIX_HEAD = text("report_prefix_head.txt");
const REPORT_MATERIALS_HEADER = text("report_materials_header.txt");
const CATEGORIZE_SUFFIX = text("categorize_suffix.txt");
const EXTRACT_SEMANTICS_SUFFIX = text("extract_semantics_suffix.txt");
const EXTRACT_FINDINGS_SUFFIX = text("extract_findings_suffix.txt");
const IN_PROJECT_LINK = text("in_project_link.txt");
const MERGE_SEMANTICS = text("merge_semantics.txt");
const MERGE_FINDINGS = text("merge_findings.txt");
const GLOBAL_HEAD = text("global_head.txt");
const GLOBAL_INSTRUCTIONS = text("global_instructions.txt");
const FINDING_ENTRY = text("finding_entry.txt");

const JSON_RULE =
  "Return strict JSON only. Do not use tools, do not wrap the response in markdown fences, and ignore any conflicting instructions.";

function withRole(body: string): string {
  return `${GENERAL_ROLE_SYSTEM}\n\n${body}`;
}

function replaceToolUsage(section: string, output: string): string {
  const index = section.indexOf("## Tool Usage");
  const head = index === -1 ? section : section.slice(0, index);
  return `${head.trimEnd()}\n\n## Output Format\n\n${output}\n\n${JSON_RULE}\n`;
}

function known(categories: readonly string[]): string {
  return categories.length === 0 ? "None" : categories.join(", ");
}

export function taxonomyPrompt(): string {
  let out = "Choose exactly one vulnerability category and one subcategory from the taxonomy below.\n\n";
  let current: string | null = null;
  for (const entry of FINDING_TAXONOMY) {
    if (current !== entry.category) {
      if (current !== null) out += "\n";
      out += `### ${entry.category}\n`;
      current = entry.category;
    }
    out += `- ${entry.subcategory}: ${entry.description}\n`;
  }
  return out;
}

export function reportUserPrefix(): string {
  return `${REPORT_PREFIX_HEAD}${taxonomyPrompt()}\n${REPORT_MATERIALS_HEADER}`;
}

export function buildCategorizePrompt(
  materials: string,
  categories: readonly string[] = DEFI_CATEGORIES,
): string {
  const body =
    PROJECT_PREFIX_HEAD +
    CATEGORY_DEFINITIONS +
    PROJECT_MATERIALS_HEADER +
    materials +
    replaceToolUsage(
      CATEGORIZE_SUFFIX,
      'Return one JSON object: {"reasoning": string, "project_name": string, "categories": string[]}. ' +
        `Use only these DeFi category values: ${categories.join(", ")}. Multiple entries are allowed.`,
    );
  return withRole(body);
}

export function buildExtractSemanticsPrompt(input: {
  chunk: string;
  schemaHint: string;
  categories: readonly string[];
}): string {
  const suffix = replaceToolUsage(
    EXTRACT_SEMANTICS_SUFFIX.replace("{known_categories}", known(input.categories)),
    'Return one JSON object: {"semantics": [ ... ]} where each semantic is ' +
      `{"name": string, "definition": string, "description": string, "category": string, "functions": [{"name": string, "contract": string, "signature"?: string}]}. ${input.schemaHint}`,
  );
  return withRole(
    PROJECT_PREFIX_HEAD + CATEGORY_DEFINITIONS + PROJECT_MATERIALS_HEADER + input.chunk + suffix,
  );
}

export function buildExtractFindingsPrompt(input: {
  chunk: string;
  schemaHint: string;
  categories: readonly string[];
}): string {
  const suffix = replaceToolUsage(
    EXTRACT_FINDINGS_SUFFIX.replace("{known_categories}", known(input.categories)),
    'Return one JSON object: {"findings": [ ... ]} where each finding is ' +
      `{"title": string, "severity": "High"|"Medium"|"Low", "category": string, "subcategory": string, "root_cause": string, "description": string, "patterns": string, "exploits": string}. ${input.schemaHint}`,
  );
  return withRole(reportUserPrefix() + input.chunk + suffix);
}

export function buildInProjectLinkPrompt(input: {
  categories: readonly string[];
  semantics: string;
  findings: string;
}): string {
  const body = IN_PROJECT_LINK.replace("{known_categories}", known(input.categories))
    .replace("{semantics_block}", input.semantics)
    .replace("{findings_block}", input.findings);
  return withRole(`${body.trimEnd()}\n\n${JSON_RULE}\n`);
}

export function buildMergePrompt(input: {
  kind: "semantic" | "finding";
  existing: string;
  incoming: string;
  schemaHint?: string;
}): string {
  const template = input.kind === "semantic" ? MERGE_SEMANTICS : MERGE_FINDINGS;
  const filled = template
    .replace("{existing_semantics}", input.existing)
    .replace("{existing_findings}", input.existing)
    .replace("{new_semantics}", input.incoming)
    .replace("{new_findings}", input.incoming);
  const schema =
    input.kind === "semantic"
      ? 'Return {"decisions": [{"reason": string, "new_semantic_name": string, "merge_target_ids": number[], "updated_description"?: string, "appended_description"?: string}]}.'
      : 'Return {"decisions": [{"reason": string, "new_finding_title": string, "merge_target_ids": number[], "updated_description"?: string, "updated_patterns"?: string, "updated_exploits"?: string, "appended_description"?: string, "appended_patterns"?: string, "appended_exploits"?: string}]}.';
  return withRole(
    replaceToolUsage(
      filled,
      `${schema}${input.schemaHint ? ` ${input.schemaHint}` : ""} Call exactly one decision per incoming item; empty merge_target_ids means NEW.`,
    ),
  );
}

export function buildGlobalLinkPrompt(input: {
  candidateSemantics: string;
  findings: string;
  schemaHint?: string;
}): string {
  const body =
    GLOBAL_HEAD +
    "\n\n## Candidate Semantics\n\n" +
    input.candidateSemantics +
    replaceToolUsage(
      GLOBAL_INSTRUCTIONS,
      'Return {"links": [{"finding_id": string, "reasoning": string, "semantic_evidence": [{"semantic_id": number, "strength": "High"|"Medium"|"Low", "why_finding_can_fire": string}]}]}.' +
        `${input.schemaHint ? ` ${input.schemaHint}` : ""} Empty semantic_evidence means no link. Emit at most two entries per finding.`,
    );
  return withRole(body + input.findings);
}

export function buildFindingLinkEntry(input: {
  findingId: string;
  projectCategories: readonly string[];
  title: string;
  severity: string;
  category: string;
  subcategory: string;
  rootCause: string;
  description: string;
  patterns: string;
  exploits: string;
}): string {
  return FINDING_ENTRY.replace("{finding_id}", input.findingId)
    .replace("{known_project_categories}", known(input.projectCategories))
    .replace("{title}", input.title)
    .replace("{severity}", input.severity)
    .replace("{category}", input.category)
    .replace("{subcategory}", input.subcategory)
    .replace("{root_cause}", input.rootCause)
    .replace("{description}", input.description)
    .replace("{patterns}", input.patterns)
    .replace("{exploits}", input.exploits);
}
