import type Database from 'better-sqlite3';

/**
 * Apply the storage schema to a database. Idempotent — fresh databases get
 * the full schema, and existing v0 databases (which had a CHECK constraint
 * on `scheduled_entries.status` and lacked the retry-tracking columns) are
 * rebuilt in place to match.
 *
 * Schema notes:
 *
 * - `processed_events.processed_at` is epoch milliseconds. Stripe redelivers
 *   for up to ~3 days, so a cleanup job is optional, but the column lets one
 *   be written later.
 *
 * - `journal_entries.payload` stores the full `JournalEntry` as JSON. The
 *   denormalized columns (`date`, `currency`, `memo`, source fields) duplicate
 *   payload fields to allow indexed querying without parsing JSON. This is the
 *   standard event-sourcing audit-table shape.
 *
 * - `scheduled_entries` carries the same idea for future-dated entries from a
 *   `RecognitionSchedule`. `status` is `'pending'` until a downstream poster
 *   pushes the entry to QBO/Xero and calls `markScheduledPosted`, or until
 *   the scheduler dead-letters it to `'failed'` after `maxAttempts` failures.
 *   The CHECK constraint is intentionally omitted — validation lives in
 *   TypeScript so future status values don't require a schema migration. The
 *   `idx_scheduled_pending` index makes "give me everything due today" cheap.
 *
 * - The retry-tracking columns (`attempts`, `last_attempted_at`,
 *   `next_attempt_at`, `last_error`) let the scheduler implement exponential
 *   backoff and a dead-letter state. See `scheduler.ts`.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  posted_at INTEGER NOT NULL,
  date TEXT NOT NULL,
  currency TEXT NOT NULL,
  memo TEXT NOT NULL,
  source_event_type TEXT NOT NULL,
  source_object_id TEXT,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_journal_entries_event_id
  ON journal_entries(event_id);

CREATE TABLE IF NOT EXISTS scheduled_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  scheduled_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  posted_at INTEGER,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempted_at INTEGER,
  next_attempt_at INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_pending
  ON scheduled_entries(status, scheduled_date);
`;

/**
 * Row shape returned by SQLite's `PRAGMA table_info(...)`.
 */
interface PragmaTableInfoRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notnull: number;
  readonly dflt_value: string | null;
  readonly pk: number;
}

/**
 * Detect a v0 `scheduled_entries` table (missing the retry-tracking columns).
 * Returns `true` iff the table exists AND lacks the `attempts` column.
 */
function needsScheduledEntriesRebuild(db: Database.Database): boolean {
  const cols = db
    .prepare<[], PragmaTableInfoRow>(`PRAGMA table_info('scheduled_entries')`)
    .all();
  if (cols.length === 0) return false; // table doesn't exist yet → CREATE will handle it
  return !cols.some((c) => c.name === 'attempts');
}

/**
 * Rebuild `scheduled_entries` for a v0 database: drop the CHECK constraint,
 * add the retry-tracking columns, and preserve all existing rows.
 *
 * Wrapped in a single transaction so partial migrations can't leave the DB
 * with a half-renamed table. The index is recreated at the end to match the
 * new table.
 */
function rebuildScheduledEntries(db: Database.Database): void {
  const txn = db.transaction(() => {
    db.exec(`
      DROP INDEX IF EXISTS idx_scheduled_pending;

      CREATE TABLE scheduled_entries_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        posted_at INTEGER,
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempted_at INTEGER,
        next_attempt_at INTEGER,
        last_error TEXT
      );

      INSERT INTO scheduled_entries_new
        (id, event_id, subscription_id, scheduled_date, status, posted_at, payload)
        SELECT id, event_id, subscription_id, scheduled_date, status, posted_at, payload
          FROM scheduled_entries;

      DROP TABLE scheduled_entries;
      ALTER TABLE scheduled_entries_new RENAME TO scheduled_entries;

      CREATE INDEX idx_scheduled_pending
        ON scheduled_entries(status, scheduled_date);
    `);
  });
  txn();
}

export function applyMigrations(db: Database.Database): void {
  // Rebuild legacy v0 tables BEFORE running the fresh CREATE IF NOT EXISTS.
  // Otherwise the IF NOT EXISTS short-circuits and leaves the old CHECK in place.
  if (needsScheduledEntriesRebuild(db)) {
    rebuildScheduledEntries(db);
  }
  db.exec(SCHEMA_SQL);
}
