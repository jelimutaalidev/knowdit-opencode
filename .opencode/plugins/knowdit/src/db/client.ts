import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export interface KgDb {
  exec(sql: string): void;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
  run(sql: string, params?: readonly unknown[]): { changes: number; lastInsertRowid: number };
  tx<T>(fn: () => T): T;
  close(): void;
}

type RawDb = {
  exec(sql: string): void;
  all<T>(sql: string, params: readonly unknown[]): T[];
  get<T>(sql: string, params: readonly unknown[]): T | undefined;
  run(sql: string, params: readonly unknown[]): { changes: number; lastInsertRowid: number | bigint };
  close(): void;
  readonly supportsTx: boolean;
};

const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

async function loadDriver(path: string): Promise<RawDb> {
  try {
    const bun = await import("bun:sqlite" as string);
    const db = new bun.Database(path);
    return {
      exec: (sql) => db.exec(sql),
      all: <T>(sql: string, params: readonly unknown[]) => db.query(sql).all(...params) as T[],
      get: <T>(sql: string, params: readonly unknown[]) =>
        (db.query(sql).get(...params) ?? undefined) as T | undefined,
      run: (sql, params) => {
        const r = db.query(sql).run(...params);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      close: () => db.close(),
      supportsTx: true,
    };
  } catch {
    // bun:sqlite is not available outside Bun.
  }

  try {
    const node = await import("node:sqlite" as string);
    const db = new node.DatabaseSync(path);
    return {
      exec: (sql) => db.exec(sql),
      all: <T>(sql: string, params: readonly unknown[]) =>
        db.prepare(sql).all(...params) as T[],
      get: <T>(sql: string, params: readonly unknown[]) =>
        (db.prepare(sql).get(...params) ?? undefined) as T | undefined,
      run: (sql, params) => {
        const r = db.prepare(sql).run(...params);
        return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
      },
      close: () => db.close(),
      supportsTx: true,
    };
  } catch {
    // node:sqlite is not available on older Node releases.
  }

  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error("knowdit: no SQLite driver available (tried bun:sqlite, node:sqlite, sqlite3)");
  }

  const query = (sql: string, params: readonly unknown[]): any[] => {
    const substituted = interpolate(sql, params);
    const out = execFileSync("sqlite3", ["-json", path, substituted], { encoding: "utf8" });
    const trimmed = out.trim();
    return trimmed ? JSON.parse(trimmed) : [];
  };

  return {
    exec: (sql) => {
      execFileSync("sqlite3", [path, sql], { stdio: "ignore" });
    },
    all: <T>(sql: string, params: readonly unknown[]) => query(sql, params) as T[],
    get: <T>(sql: string, params: readonly unknown[]) => query(sql, params)[0] as T | undefined,
    run: (sql, params) => {
      const rows = query(
        `${interpolate(sql, params)};\nselect changes() as changes, last_insert_rowid() as lastInsertRowid;`,
        [],
      );
      const row = rows.at(-1) ?? { changes: 0, lastInsertRowid: 0 };
      return {
        changes: Number(row.changes),
        lastInsertRowid: Number(row.lastInsertRowid),
      };
    },
    close: () => {},
    supportsTx: false,
  };
}

function interpolate(sql: string, params: readonly unknown[]): string {
  let index = 0;
  return sql.replace(/\?/g, () => {
    const value = params[index++];
    if (value === null || value === undefined) return "NULL";
    if (typeof value === "number" || typeof value === "bigint") return String(value);
    if (typeof value === "boolean") return value ? "1" : "0";
    return `'${String(value).replace(/'/g, "''")}'`;
  });
}

export async function openKg(path: string): Promise<KgDb> {
  const raw = await loadDriver(path);
  raw.exec("PRAGMA foreign_keys=ON");
  raw.exec("PRAGMA journal_mode=WAL");

  // Applying 18 DDL statements one by one costs one fsync each on WAL.
  // The schema is only `CREATE TABLE IF NOT EXISTS`, so one transaction is
  // equivalent and an order of magnitude faster.
  if (raw.supportsTx) {
    raw.exec("BEGIN");
    try {
      raw.exec(SCHEMA);
      raw.exec("COMMIT");
    } catch (error) {
      raw.exec("ROLLBACK");
      throw error;
    }
  } else {
    raw.exec(SCHEMA);
  }

  let inTx = false;

  return {
    exec: (sql) => raw.exec(sql),
    all: (sql, params = []) => raw.all(sql, params),
    get: (sql, params = []) => raw.get(sql, params),
    run: (sql, params = []) => raw.run(sql, params),
    tx<T>(fn: () => T): T {
      if (!raw.supportsTx) {
        throw new Error("knowdit: sqlite3 CLI fallback does not support transactions");
      }
      if (inTx) throw new Error("knowdit: nested transactions are not supported");
      raw.exec("BEGIN");
      inTx = true;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      } finally {
        inTx = false;
      }
    },
    close: () => raw.close(),
  };
}

export { seedReferenceTables } from "./seed.ts";
