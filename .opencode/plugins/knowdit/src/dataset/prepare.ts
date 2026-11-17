import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readContests, selectContests } from "./select.ts";
import { trimReport } from "./trim.ts";
import {
  writeManifest,
  writeSnapshot,
  type Manifest,
  type ManifestContest,
  type ManifestReport,
} from "./snapshot.ts";

const FINDING_MARKER = /^#{1,4}\s*\[\[?([HM]-\d+)/gm;

function countExpected(markdown: string): { high: number; medium: number } {
  const high = new Set<string>();
  const medium = new Set<string>();
  for (const match of markdown.matchAll(FINDING_MARKER)) {
    (match[1].startsWith("H-") ? high : medium).add(match[1]);
  }
  return { high: high.size, medium: medium.size };
}

export async function prepareDataset(opts: {
  sourceRoot: string;
  dataDir: string;
  localIds: readonly number[];
}): Promise<Manifest> {
  const datasetDir = join(opts.dataDir, "dataset");
  rmSync(datasetDir, { recursive: true, force: true });
  mkdirSync(join(datasetDir, "contracts"), { recursive: true });
  mkdirSync(join(datasetDir, "reports"), { recursive: true });

  const selection = selectContests(readContests(opts.sourceRoot), opts.localIds);
  const contests: ManifestContest[] = [];

  for (const contest of selection.selected) {
    if (contest.c4Id === null) continue;

    const original = readFileSync(contest.reportPath!, "utf8");
    const trimmed = trimReport(original);
    const reportPath = `reports/${contest.c4Id}.md`;
    writeFileSync(join(datasetDir, reportPath), trimmed.text);

    const report: ManifestReport = {
      path: reportPath,
      sha256: createHash("sha256").update(original).digest("hex"),
      originalChars: original.length,
      trimmedChars: trimmed.text.length,
      tokensEst: Math.ceil(trimmed.text.length / 4),
      keptSections: trimmed.keptSections,
      droppedSections: trimmed.droppedSections,
      trimFallback: trimmed.fallback,
    };

    const snapshot = await writeSnapshot(contest, join(datasetDir, "contracts", String(contest.c4Id)));

    contests.push({
      localId: contest.localId,
      c4Id: contest.c4Id,
      slug: contest.slug,
      title: contest.title,
      coreLoc: snapshot.coreLoc,
      sourceFiles: snapshot.files.map((file) => file.path),
      report,
      expected: countExpected(original),
    });
  }

  const manifest: Manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sourceRoot: opts.sourceRoot,
    contests,
    excluded: selection.excluded,
  };

  writeManifest(join(datasetDir, "manifest.json"), manifest);
  const idMap: Record<string, { localId: number; slug: string; title: string }> = {};
  for (const contest of contests) {
    idMap[String(contest.c4Id)] = {
      localId: contest.localId,
      slug: contest.slug,
      title: contest.title,
    };
  }
  writeFileSync(join(datasetDir, "id_map.json"), `${JSON.stringify(idMap, null, 2)}\n`);

  return manifest;
}
