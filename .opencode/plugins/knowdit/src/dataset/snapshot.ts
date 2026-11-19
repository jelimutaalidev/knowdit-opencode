import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { ContestRef } from "./types.ts";

export const VENDORED_EXCLUDES: readonly string[] = [
  "node_modules",
  "node_modules/**",
  "**/node_modules",
  "**/node_modules/**",
  "lib",
  "lib/**",
  "**/lib",
  "**/lib/**",
  "build",
  "build/**",
  "**/build",
  "**/build/**",
  "artifacts",
  "artifacts/**",
  "**/artifacts",
  "**/artifacts/**",
  "cache",
  "cache/**",
  "**/cache",
  "**/cache/**",
  "test",
  "test/**",
  "**/test",
  "**/test/**",
  "mock",
  "mock/**",
  "**/mock",
  "**/mock/**",
  "deploy",
  "deploy/**",
  "**/deploy",
  "**/deploy/**",
  "script",
  "script/**",
  "**/script",
  "**/script/**",
  "src/vendor",
  "src/vendor/**",
  "**/src/vendor",
  "**/src/vendor/**",
  ".git/**",
  "target/**",
];

const EXCLUDED_SEGMENTS = new Set([
  "node_modules",
  "lib",
  "build",
  "artifacts",
  "cache",
  "test",
  "mock",
  "deploy",
  "script",
]);

export function isExcluded(relativePath: string): boolean {
  const segments = relativePath.split("/");
  if (segments.includes(".git")) return true;
  if (segments[0] === "target") return true;

  for (let i = 0; i < segments.length - 1; i++) {
    if (EXCLUDED_SEGMENTS.has(segments[i])) return true;
    if (segments[i] === "src" && segments[i + 1] === "vendor") return true;
  }
  return false;
}

export type SnapshotFile = {
  path: string;
  bytes: number;
  sha256: string;
  origin: string;
};

export type SnapshotResult = { files: SnapshotFile[]; coreLoc: number };

async function walk(root: string, current: string, out: string[]): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    const rel = relative(root, absolute).split(sep).join("/");
    if (entry.isDirectory()) {
      if (entry.name === ".git") continue;
      if (isExcluded(`${rel}/`)) continue;
      await walk(root, absolute, out);
    } else if (entry.isFile() && entry.name.endsWith(".sol") && !isExcluded(rel)) {
      out.push(rel);
    }
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const newlines = text.split("\n").length - 1;
  return text.endsWith("\n") ? newlines : newlines + 1;
}

export async function writeSnapshot(
  contest: ContestRef,
  outDir: string,
): Promise<SnapshotResult> {
  const paths: string[] = [];
  await walk(contest.repoDir, contest.repoDir, paths);
  paths.sort();

  const files: SnapshotFile[] = [];
  let coreLoc = 0;

  for (const path of paths) {
    const source = join(contest.repoDir, path);
    const destination = join(outDir, path);
    const content = await readFile(source);
    const info = await stat(source);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    coreLoc += countLines(content.toString("utf8"));
    files.push({
      path,
      bytes: info.size,
      sha256: createHash("sha256").update(content).digest("hex"),
      origin: path,
    });
  }

  // The reference loader feeds the project README to the extractor too, so the
  // snapshot has to carry it next to the sources.
  for (const name of ["README.md", "readme.md", "Readme.md"] as const) {
    const source = join(contest.repoDir, name);
    try {
      await copyFile(source, join(outDir, name));
      break;
    } catch {
      continue;
    }
  }

  return { files, coreLoc };
}

export type ManifestReport = {
  path: string;
  sha256: string;
  originalChars: number;
  trimmedChars: number;
  tokensEst: number;
  keptSections: string[];
  droppedSections: string[];
  trimFallback: boolean;
};

export type ManifestContest = {
  localId: number;
  c4Id: number;
  slug: string;
  title: string;
  coreLoc: number;
  sourceFiles: string[];
  report: ManifestReport | null;
  expected: { high: number; medium: number };
};

export type Manifest = {
  schemaVersion: 1;
  generatedAt: string;
  sourceRoot: string;
  contests: ManifestContest[];
  excluded: { localId: number; reason: string }[];
};

export function writeManifest(path: string, manifest: Manifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}
