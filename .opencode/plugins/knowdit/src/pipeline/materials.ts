import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StageContext } from "./types.ts";

const MAX_FILES = 50;
const MAX_CHARS_PER_FILE = 2_000;

/**
 * Render the project's In-scope Solidity snapshot the way the reference
 * `build_project_prompt_body` does: a `## Source Files` section with one
 * fenced block per file.
 */
export function buildProjectMaterials(ctx: StageContext): string {
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
