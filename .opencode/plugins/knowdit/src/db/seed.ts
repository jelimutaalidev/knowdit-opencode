import type { KgDb } from "./client.ts";
import { DEFI_CATEGORIES } from "../domain/categories.ts";
import { FINDING_TAXONOMY } from "../domain/taxonomy.ts";

export function seedReferenceTables(db: KgDb): void {
  db.tx(() => {
    for (const name of DEFI_CATEGORIES) {
      db.run("insert or ignore into category (name) values (?)", [name]);
    }
    for (const entry of FINDING_TAXONOMY) {
      const exists = db.get<{ n: number }>(
        "select 1 as n from finding_category where category = ? and name = ?",
        [entry.category, entry.subcategory],
      );
      if (exists) continue;
      db.run(
        "insert into finding_category (category, name, description) values (?, ?, ?)",
        [entry.category, entry.subcategory, entry.description],
      );
    }
  });
}
