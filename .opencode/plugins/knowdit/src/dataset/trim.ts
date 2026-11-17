export const KEPT_SECTIONS: readonly string[] = [
  "Overview",
  "Scope",
  "High Risk Findings",
  "Medium Risk Findings",
  "Low Risk Findings",
  "Low Risk and Non-Critical Issues",
  "Non-Critical Findings",
];

export type TrimResult = {
  text: string;
  keptSections: string[];
  droppedSections: string[];
  fallback: boolean;
};

const FRONTMATTER = /^---\n[\s\S]*?\n---\n?/;
const SECTION_HEADING = /^# .*$/gm;

function normalize(name: string): string {
  return name.replace(/\s*\(\d+\)\s*$/, "").trim();
}

export function trimReport(markdown: string): TrimResult {
  const frontmatter = FRONTMATTER.exec(markdown)?.[0] ?? "";
  const body = markdown.slice(frontmatter.length);

  const headings = [...body.matchAll(SECTION_HEADING)].map((match) => ({
    name: normalize(match[0].slice(2)),
    index: match.index ?? 0,
  }));

  if (headings.length === 0) {
    return { text: markdown, keptSections: [], droppedSections: [], fallback: true };
  }

  const preamble = body.slice(0, headings[0].index);
  const sections = headings.map((heading, i) => ({
    name: heading.name,
    raw: body.slice(heading.index, i + 1 < headings.length ? headings[i + 1].index : body.length),
  }));

  const hasAuditable = sections.some(
    (section) =>
      section.name.startsWith("High Risk Findings") ||
      section.name.startsWith("Medium Risk Findings"),
  );
  if (!hasAuditable) {
    return { text: markdown, keptSections: [], droppedSections: [], fallback: true };
  }

  const keptSections: string[] = [];
  const droppedSections: string[] = [];
  let text = frontmatter + preamble;

  for (const section of sections) {
    if (KEPT_SECTIONS.includes(section.name)) {
      keptSections.push(section.name);
      text += section.raw;
    } else {
      droppedSections.push(section.name);
    }
  }

  return { text, keptSections, droppedSections, fallback: false };
}
