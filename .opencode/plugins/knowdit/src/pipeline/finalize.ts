import type { KgDb } from "../db/client.ts";
import { checkIntegrity, type IntegrityReport } from "../integrity.ts";

/**
 * Gate + record completion of a C4 build.
 *
 * The report is returned either way. `operation_history` records only
 * successful builds; the pair `(type, args)` is the idempotency key.
 */
export function finalizeBuild(
  db: KgDb,
  args: { c4Ids: number[] },
): IntegrityReport {
  const report = checkIntegrity(db, { requireAllLinked: true });
  if (!report.ok) return report;

  const payload = JSON.stringify({ c4Ids: args.c4Ids });
  const existing = db.get<{ id: number }>(
    "select id from operation_history where type = 'c4learn' and args = ?",
    [payload],
  );
  if (!existing) {
    db.run("insert into operation_history (datetime, type, args) values (?, 'c4learn', ?)", [
      new Date().toISOString(),
      payload,
    ]);
  }

  return report;
}
