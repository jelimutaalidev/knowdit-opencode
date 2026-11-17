/**
 * Evidence written for in-project links.
 *
 * This string is load-bearing: `kg_stats` uses the prefix to separate
 * in-project links from cross-project links, and `clear_finding_link_progress`
 * uses it to reset only global links. It must match the reference constant.
 */
export const IN_PROJECT_LINK_EVIDENCE_PREFIX =
  "in-project link: finding and semantic co-emitted by the extract pipeline";

export function inProjectEvidence(): string {
  return (
    `${IN_PROJECT_LINK_EVIDENCE_PREFIX} against the same project; finding ` +
    "instantiates the semantic in its originating codebase"
  );
}
