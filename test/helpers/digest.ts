import { createHash } from "node:crypto";
import type { KgDb } from "../../.opencode/plugins/knowdit/src/db/client.ts";

const SEED_TABLES = new Set(["category", "finding_category"]);
const EXCLUDED_TABLES = new Set(["operation_history", "sqlite_sequence"]);

/**
 * Stable per-table content hashes for the G-E determinism guard.
 *
 * Rows are ordered by the table's primary key and serialized as column-order
 * arrays, so object key order and SQLite row order cannot change the digest.
 * Seed tables are identical by construction; `operation_history` carries a
 * wall-clock timestamp and is deliberately excluded.
 */
export function tableDigests(db: KgDb): Record<string, string> {
  const tables = db
    .all<{ name: string }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .map((row) => row.name)
    .filter((name) => !SEED_TABLES.has(name) && !EXCLUDED_TABLES.has(name));

  const digests: Record<string, string> = {};

  for (const table of tables) {
    const columns = db.all<{ name: string; pk: number }>(`pragma table_info("${table}")`);
    const selectList = columns.map((column) => `"${column.name}"`).join(", ");
    const orderBy = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => `"${column.name}"`)
      .join(", ");

    const rows = db.all<Record<string, unknown>>(
      `select ${selectList} from "${table}"${orderBy ? ` order by ${orderBy}` : ""}`,
    );
    const lines = rows.map((row) => JSON.stringify(columns.map((column) => row[column.name])));
    digests[table] = createHash("sha256").update(lines.join("\n")).digest("hex");
  }

  return digests;
}
