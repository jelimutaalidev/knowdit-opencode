import { openKg, type KgDb } from "./db/client.ts";

export type JournalUnit = { stage: string; c4Id: number; unitIndex: number };

export type JournalStatus = "running" | "done" | "failed" | "skipped";

export type JournalUnitInfo = {
  stage: string;
  unitIndex: number;
  status: JournalStatus;
  error: string | null;
};

export type JournalDoneExtra = {
  tokensEst?: number;
  costEst?: number;
  promptHash?: string;
  responseHash?: string;
};

export interface Journal {
  start(u: JournalUnit): void;
  done(u: JournalUnit, extra?: JournalDoneExtra): void;
  fail(u: JournalUnit, error: string): void;
  isDone(u: JournalUnit): boolean;
  list(c4Id: number): JournalUnitInfo[];
  skip(c4Id: number, reason: string): void;
  isSkipped(c4Id: number): boolean;
  /**
   * Bind this run to a dataset/pipeline/model fingerprint. A journal written
   * under a different fingerprint (or an unversioned legacy journal with
   * units) must not be resumed: its `done` rows describe prompts and inputs
   * that no longer exist.
   */
  ensureFingerprint(fingerprint: string): void;
  resetContest(c4Id: number): void;
  /** Clear every journaled unit and record why in `journal_meta`. */
  resetAll(reason: string): void;
  close(): void;
}

const UNIT_TABLE = `
CREATE TABLE IF NOT EXISTS unit_status (
  stage text NOT NULL,
  c4_id integer NOT NULL,
  unit_index integer NOT NULL,
  status text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  tokens_est integer,
  cost_est real,
  prompt_hash text,
  response_hash text,
  error text,
  updated_at text NOT NULL,
  primary key (stage, c4_id, unit_index)
)`;

const CONTEST_TABLE = `
CREATE TABLE IF NOT EXISTS contest_status (
  c4_id integer NOT NULL PRIMARY KEY,
  status text NOT NULL,
  reason text,
  updated_at text NOT NULL
)`;

const META_TABLE = `
CREATE TABLE IF NOT EXISTS journal_meta (
  key text NOT NULL PRIMARY KEY,
  value text NOT NULL,
  updated_at text NOT NULL
)`;

const FINGERPRINT_KEY = "build_fingerprint";

function now(): string {
  return new Date().toISOString();
}

class SqlJournal implements Journal {
  private readonly db: KgDb;

  constructor(db: KgDb) {
    this.db = db;
  }

  start(u: JournalUnit): void {
    this.db.run(
      `insert into unit_status
         (stage, c4_id, unit_index, status, attempts, updated_at)
       values (?, ?, ?, 'running', 1, ?)
       on conflict(stage, c4_id, unit_index) do update set
         status = 'running',
         attempts = unit_status.attempts + 1,
         error = null,
         updated_at = excluded.updated_at`,
      [u.stage, u.c4Id, u.unitIndex, now()],
    );
  }

  done(u: JournalUnit, extra: JournalDoneExtra = {}): void {
    this.db.run(
      `insert into unit_status
         (stage, c4_id, unit_index, status, attempts, tokens_est, cost_est,
          prompt_hash, response_hash, updated_at)
       values (?, ?, ?, 'done', 1, ?, ?, ?, ?, ?)
       on conflict(stage, c4_id, unit_index) do update set
         status = 'done',
         tokens_est = excluded.tokens_est,
         cost_est = excluded.cost_est,
         prompt_hash = excluded.prompt_hash,
         response_hash = excluded.response_hash,
         error = null,
         updated_at = excluded.updated_at`,
      [
        u.stage,
        u.c4Id,
        u.unitIndex,
        extra.tokensEst ?? null,
        extra.costEst ?? null,
        extra.promptHash ?? null,
        extra.responseHash ?? null,
        now(),
      ],
    );
  }

  fail(u: JournalUnit, error: string): void {
    this.db.run(
      `insert into unit_status
         (stage, c4_id, unit_index, status, attempts, error, updated_at)
       values (?, ?, ?, 'failed', 1, ?, ?)
       on conflict(stage, c4_id, unit_index) do update set
         status = 'failed',
         error = excluded.error,
         updated_at = excluded.updated_at`,
      [u.stage, u.c4Id, u.unitIndex, error, now()],
    );
  }

  isDone(u: JournalUnit): boolean {
    const row = this.db.get<{ status: string }>(
      "select status from unit_status where stage = ? and c4_id = ? and unit_index = ?",
      [u.stage, u.c4Id, u.unitIndex],
    );
    return row?.status === "done";
  }

  list(c4Id: number): JournalUnitInfo[] {
    const rows = this.db.all<{
      stage: string;
      unit_index: number;
      status: JournalStatus;
      error: string | null;
    }>(
      `select stage, unit_index, status, error
         from unit_status
        where c4_id = ?
        order by stage, unit_index`,
      [c4Id],
    );
    return rows.map((row) => ({
      stage: row.stage,
      unitIndex: row.unit_index,
      status: row.status,
      error: row.error,
    }));
  }

  skip(c4Id: number, reason: string): void {
    this.db.run(
      `insert into contest_status (c4_id, status, reason, updated_at)
       values (?, 'skipped', ?, ?)
       on conflict(c4_id) do update set
         status = 'skipped',
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
      [c4Id, reason, now()],
    );
  }

  isSkipped(c4Id: number): boolean {
    const row = this.db.get<{ status: string }>(
      "select status from contest_status where c4_id = ?",
      [c4Id],
    );
    return row?.status === "skipped";
  }

  ensureFingerprint(fingerprint: string): void {
    const row = this.db.get<{ value: string }>(
      "select value from journal_meta where key = ?",
      [FINGERPRINT_KEY],
    );
    if (row === undefined) {
      const units =
        (this.db.get<{ n: number }>("select count(*) n from unit_status")?.n ?? 0) +
        (this.db.get<{ n: number }>("select count(*) n from contest_status")?.n ?? 0);
      if (units > 0) {
        throw new Error(
          "journal has completed units but no build fingerprint (unversioned journal). " +
            "Those rows may refer to a different dataset, prompt set, or model effort. " +
            "Run kg_build with reset_all after reviewing the existing KG, or reset the affected " +
            "contests explicitly; resuming would silently mix old and new quality.",
        );
      }
      this.db.run(
        "insert into journal_meta (key, value, updated_at) values (?, ?, ?)",
        [FINGERPRINT_KEY, fingerprint, now()],
      );
      return;
    }

    if (row.value !== fingerprint) {
      throw new Error(
        `journal build fingerprint changed (recorded '${row.value}', current '${fingerprint}'). ` +
          "The dataset, pipeline version, context window, or model effort changed since the " +
          "journaled units ran. Run kg_build with reset_all (or reset the affected contests) " +
          "before rebuilding; resuming would mix results from different inputs.",
      );
    }
  }

  resetContest(c4Id: number): void {
    this.db.run("delete from unit_status where c4_id = ?", [c4Id]);
    this.db.run("delete from contest_status where c4_id = ?", [c4Id]);
  }
  resetAll(reason: string): void {
    this.db.run("delete from unit_status");
    this.db.run("delete from contest_status");
    this.db.run("delete from journal_meta");
    this.db.run(
      "insert into journal_meta (key, value, updated_at) values (?, ?, ?)",
      ["reset_reason", reason, now()],
    );
  }

  close(): void {
    this.db.close();
  }
}

export async function openJournal(path: string): Promise<Journal> {
  const db = await openKg(path);
  db.exec(UNIT_TABLE);
  db.exec(CONTEST_TABLE);
  db.exec(META_TABLE);
  return new SqlJournal(db);
}
