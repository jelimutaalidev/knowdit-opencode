import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKg, seedReferenceTables, type KgDb } from "../../.opencode/plugins/knowdit/src/db/client.ts";

export async function tempDb(): Promise<{ db: KgDb; path: string; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "kg-"));
  const path = join(dir, "kg.sqlite");
  const db = await openKg(path);
  seedReferenceTables(db);
  return {
    db,
    path,
    cleanup: () => {
      db.close();
    },
  };
}
