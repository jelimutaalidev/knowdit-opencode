import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StageContext } from "./types.ts";

const README_NAMES = ["README.md", "readme.md", "Readme.md"] as const;

/** Read the project README the same way the reference loader does. */
function readReadme(root: string): string | null {
  for (const name of README_NAMES) {
    try {
      return readFileSync(join(root, name), "utf8");
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Render the project's In-scope Solidity snapshot the way the reference
 * `build_project_prompt_body` does: every in-scope file in full, plus the
 * project README, then let the chunker fit it to the model's context budget.
 */
export function buildProjectMaterials(ctx: StageContext): string {
  const root = join(ctx.datasetDir, "contracts", String(ctx.contest.c4Id));
  let content = "## Source Files\n\n";
  for (const file of ctx.contest.sourceFiles) {
    let source = "";
    try {
      source = readFileSync(join(root, file), "utf8");
    } catch {
      continue;
    }
    content += `### ${file}\n\`\`\`solidity\n${source}\n\`\`\`\n\n`;
  }

  const readme = readReadme(root);
  if (readme !== null) {
    content += `## README\n\n${readme}\n\n`;
  }
  return content;
}
