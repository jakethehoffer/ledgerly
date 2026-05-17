import type Database from 'better-sqlite3';

/**
 * Apply the storage schema to a database. Idempotent — every statement uses
 * `IF NOT EXISTS`, so running this against an existing db is a no-op.
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
 *   pushes the entry to QBO/Xero and calls `markScheduledPosted`. The
 *   `idx_scheduled_pending` index makes "give me everything due today" cheap.
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
  status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'cancelled')) DEFAULT 'pending',
  posted_at INTEGER,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scheduled_pending
  ON scheduled_entries(status, scheduled_date);
`;

export function applyMigrations(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}
