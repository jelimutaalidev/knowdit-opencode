import test from "node:test";
import assert from "node:assert/strict";

import {
  formatProgressLine,
  isKnowditProgress,
  latestProgress,
  markKnowditProgress,
  removeProgress,
  upsertProgress,
  type ProgressEntry,
} from "../../.opencode/plugins/knowdit/src/progress-events.ts";

test("marks a progress update as knowdit and recognises only marked updates", () => {
  const marked = markKnowditProgress({ stage: "findings" });

  assert.equal(marked.source, "knowdit");
  assert.equal(marked.stage, "findings");
  assert.equal(isKnowditProgress(marked), true);
  assert.equal(isKnowditProgress({ stage: "findings" }), false);
  assert.equal(isKnowditProgress(null), false);
});

test("formats a one-line status with a whole percent", () => {
  const line = formatProgressLine({
    source: "knowdit",
    detail: "Extracting findings · chunk 2/5 · C4 453",
    completed: 1,
    total: 5,
  });

  assert.deepEqual(line, {
    detail: "Extracting findings · chunk 2/5 · C4 453",
    percent: 20,
  });
});

test("omits percent when the stage has no total", () => {
  const line = formatProgressLine({
    source: "knowdit",
    detail: "Verifying knowledge graph integrity",
  });

  assert.deepEqual(line, {
    detail: "Verifying knowledge graph integrity",
    percent: null,
  });
});

test("clamps percent and ignores non-numeric counters", () => {
  assert.equal(
    formatProgressLine({ detail: "x", completed: 9, total: 4 })?.percent,
    100,
  );
  assert.equal(
    formatProgressLine({ detail: "x", completed: -3, total: 4 })?.percent,
    0,
  );
  assert.equal(
    formatProgressLine({ detail: "x", completed: "2", total: 4 })?.percent,
    null,
  );
  assert.equal(formatProgressLine({ detail: "x", completed: 2, total: 0 })?.percent, null);
});

test("returns null when there is nothing to show", () => {
  assert.equal(formatProgressLine({}), null);
  assert.equal(formatProgressLine({ detail: "   " }), null);
});

test("upsert replaces the same tool and latest picks the newest for a session", () => {
  const first = entry("tool-1", "session-a", 1, "first");
  const second = entry("tool-1", "session-a", 2, "second");
  const other = entry("tool-2", "session-b", 3, "other");

  const entries = upsertProgress(upsertProgress([first], second), other);

  assert.equal(entries.length, 2);
  assert.equal(latestProgress(entries, "session-a")?.metadata.detail, "second");
  assert.equal(latestProgress(entries, "session-b")?.metadata.detail, "other");
  assert.equal(latestProgress(entries, "session-c"), undefined);
});

test("removeProgress drops only the finished tool", () => {
  const entries = [entry("tool-1", "session-a", 1, "one"), entry("tool-2", "session-a", 2, "two")];

  assert.deepEqual(
    removeProgress(entries, "tool-1").map((value) => value.toolID),
    ["tool-2"],
  );
});

function entry(
  toolID: string,
  sessionID: string,
  seq: number,
  detail: string,
): ProgressEntry {
  return { toolID, sessionID, seq, metadata: { detail } };
}
