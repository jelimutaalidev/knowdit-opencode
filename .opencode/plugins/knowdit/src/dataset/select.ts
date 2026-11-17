import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ContestRef, Selection } from "./types.ts";

export const BATCH_LOCAL_IDS: readonly number[] = [
  110, 33, 40, 32, 23, 12, 65, 54, 34, 57, 96, 64,
];

const TEMPLATE_SLUG = "2022-01-dev-test-repo";
const HIGH_HEADING = /^##\s+\[{1,2}H-\d+\]/m;

function frontmatter(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  return text.slice(3, end);
}

function parseContestId(report: string | null): number | null {
  if (!report) return null;
  const meta = frontmatter(report);
  if (!meta) return null;
  const match = /^contest:\s*["']?(\d+)["']?\s*$/m.exec(meta);
  return match ? Number(match[1]) : null;
}

function parseSlug(report: string | null): string | null {
  if (!report) return null;
  const meta = frontmatter(report);
  if (!meta) return null;
  const match = /^slug:\s*["']?(.+?)["']?\s*$/m.exec(meta);
  return match ? match[1] : null;
}

function hasSolidity(dir: string): boolean {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (hasSolidity(join(dir, entry.name))) return true;
    } else if (entry.isFile() && entry.name.endsWith(".sol")) {
      return true;
    }
  }
  return false;
}

export function readContests(sourceRoot: string): ContestRef[] {
  const auditsDir = join(sourceRoot, "audits");
  if (!existsSync(auditsDir)) return [];

  const ids = readdirSync(auditsDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => Number(name.slice(0, -".json".length)))
    .filter((id) => Number.isInteger(id))
    .sort((a, b) => a - b);

  return ids.map((localId) => {
    const metaPath = join(auditsDir, `${localId}.json`);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      contestId?: number;
      title?: string;
      slug?: string;
    };
    const reportPath = join(sourceRoot, "reports", `${localId}.md`);
    const report = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : null;
    return {
      localId,
      c4Id: parseContestId(report),
      slug: parseSlug(report) ?? meta.slug ?? meta.title ?? String(localId),
      title: meta.title ?? String(localId),
      repoDir: join(sourceRoot, "contracts", String(localId)),
      reportPath: report ? reportPath : null,
    };
  });
}

export function selectContests(
  all: ContestRef[],
  localIds: readonly number[],
): Selection {
  const byId = new Map(all.map((contest) => [contest.localId, contest]));
  const selected: ContestRef[] = [];
  const excluded: { localId: number; reason: string }[] = [];

  for (const localId of localIds) {
    const contest = byId.get(localId);
    if (!contest) {
      excluded.push({ localId, reason: "unknown local id" });
      continue;
    }
    if (!contest.reportPath) {
      excluded.push({ localId, reason: "no report" });
      continue;
    }
    if (!hasSolidity(contest.repoDir)) {
      excluded.push({ localId, reason: "no solidity source" });
      continue;
    }
    if (contest.slug === TEMPLATE_SLUG) {
      excluded.push({ localId, reason: "template contest" });
      continue;
    }
    const report = readFileSync(contest.reportPath, "utf8");
    if (!HIGH_HEADING.test(report)) {
      excluded.push({ localId, reason: "no high finding" });
      continue;
    }
    selected.push(contest);
  }

  return { selected, excluded };
}
