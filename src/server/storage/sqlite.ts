import Database from 'better-sqlite3';
import type { JournalEntry, MapResult, RecognitionSchedule } from '../../journal.js';
import { applyMigrations } from './migrations.js';
import type {
  Deduplicator,
  JournalEntryStore,
  SavedImmediateEntry,
  SavedScheduledEntry,
  Storage,
} from './types.js';

/**
 * Shape of a `processed_events` row.
 */
interface ProcessedEventRow {
  readonly event_id: string;
  readonly processed_at: number;
}

/**
 * Shape of a `journal_entries` row. `payload` is JSON.stringify of the full
 * `JournalEntry`.
 */
interface JournalEntryRow {
  readonly id: number;
  readonly event_id: string;
  readonly posted_at: number;
  readonly payload: string;
}

/**
 * Shape of a `scheduled_entries` row.
 */
interface ScheduledEntryRow {
  readonly id: number;
  readonly event_id: string;
  readonly subscription_id: string;
  readonly status: 'pending' | 'posted' | 'cancelled' | 'failed';
  readonly payload: string;
  readonly attempts: number;
  readonly last_attempted_at: number | null;
  readonly next_attempt_at: number | null;
  readonly last_error: string | null;
}

/**
 * Open a SQLite database at `path`, apply migrations, and return the handle.
 * Pass `':memory:'` for an ephemeral test database.
 *
 * The returned handle is owned by the caller — call `.close()` on shutdown if
 * you want a clean disk flush, though SQLite is durable across crashes by
 * default.
 */
export function openSqliteDatabase(path: string): Database.Database {
  const db = new Database(path);
  // WAL mode improves concurrent-reader throughput and reduces fsync overhead
  // on writes. Safe for our single-writer webhook receiver workload.
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  return db;
}

/**
 * SQLite-backed deduplicator. Uses the `processed_events` table; survives
 * process restarts.
 */
export function sqliteDeduplicator(db: Database.Database): Deduplicator {
  const hasStmt = db.prepare<[string], ProcessedEventRow>(
    'SELECT event_id, processed_at FROM processed_events WHERE event_id = ?',
  );
  const insertStmt = db.prepare<[string, number]>(
    'INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)',
  );
  const countStmt = db.prepare<[], { count: number }>(
    'SELECT COUNT(*) AS count FROM processed_events',
  );

  return {
    has(eventId: string): boolean {
      return hasStmt.get(eventId) !== undefined;
    },
    record(eventId: string, now: number = Date.now()): void {
      insertStmt.run(eventId, now);
    },
    checkAndRecord(eventId: string, now: number = Date.now()): boolean {
      const existing = hasStmt.get(eventId);
      if (existing !== undefined) return true;
      insertStmt.run(eventId, now);
      return false;
    },
    size(): number {
      const row = countStmt.get();
      return row?.count ?? 0;
    },
  };
}

/**
 * SQLite-backed journal entry store. All payloads are stored as JSON; the
 * denormalized columns make audit queries cheap without a JSON parse.
 */
export function sqliteJournalEntryStore(db: Database.Database): JournalEntryStore {
  const insertImmediate = db.prepare<
    [string, number, string, string, string, string, string | null, string]
  >(
    `INSERT INTO journal_entries
       (event_id, posted_at, date, currency, memo, source_event_type, source_object_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertScheduled = db.prepare<[string, string, string, string]>(
    `INSERT INTO scheduled_entries
       (event_id, subscription_id, scheduled_date, payload)
     VALUES (?, ?, ?, ?)`,
  );

  const selectByEventId = db.prepare<[string], JournalEntryRow>(
    `SELECT id, event_id, posted_at, payload
       FROM journal_entries
      WHERE event_id = ?
      ORDER BY id ASC`,
  );

  const selectPendingScheduled = db.prepare<[string, number], ScheduledEntryRow>(
    `SELECT id, event_id, subscription_id, status, payload,
            attempts, last_attempted_at, next_attempt_at, last_error
       FROM scheduled_entries
      WHERE status = 'pending'
        AND scheduled_date <= ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY scheduled_date ASC, id ASC`,
  );

  const markPosted = db.prepare<[number, number]>(
    `UPDATE scheduled_entries
        SET status = 'posted', posted_at = ?
      WHERE id = ? AND status = 'pending'`,
  );

  const recordAttemptStmt = db.prepare<
    [number, number, number | null, string, string, number]
  >(
    `UPDATE scheduled_entries
        SET attempts = ?,
            last_attempted_at = ?,
            next_attempt_at = ?,
            last_error = ?,
            status = ?
      WHERE id = ?`,
  );

  const countImmediateStmt = db.prepare<[], { count: number }>(
    'SELECT COUNT(*) AS count FROM journal_entries',
  );
  const countPendingStmt = db.prepare<[], { count: number }>(
    `SELECT COUNT(*) AS count FROM scheduled_entries WHERE status = 'pending'`,
  );
  const countFailedStmt = db.prepare<[], { count: number }>(
    `SELECT COUNT(*) AS count FROM scheduled_entries WHERE status = 'failed'`,
  );

  function saveImmediateInternal(
    entry: JournalEntry,
    eventId: string,
    now: number,
  ): SavedImmediateEntry {
    const info = insertImmediate.run(
      eventId,
      now,
      entry.date,
      entry.currency,
      entry.memo,
      entry.sourceEventType,
      entry.sourceObjectId ?? null,
      JSON.stringify(entry),
    );
    return {
      id: Number(info.lastInsertRowid),
      eventId,
      entry,
      postedAt: now,
    };
  }

  function saveScheduledInternal(
    entry: JournalEntry,
    schedule: Pick<RecognitionSchedule, 'subscriptionId' | 'sourceEventId'>,
  ): SavedScheduledEntry {
    const info = insertScheduled.run(
      schedule.sourceEventId,
      schedule.subscriptionId,
      entry.date,
      JSON.stringify(entry),
    );
    return {
      id: Number(info.lastInsertRowid),
      eventId: schedule.sourceEventId,
      subscriptionId: schedule.subscriptionId,
      entry,
      status: 'pending',
      attempts: 0,
      lastAttemptedAt: null,
      nextAttemptAt: null,
      lastError: null,
    };
  }

  return {
    saveImmediate(entry: JournalEntry, eventId: string): SavedImmediateEntry {
      return saveImmediateInternal(entry, eventId, Date.now());
    },

    saveScheduled(entry, schedule): SavedScheduledEntry {
      return saveScheduledInternal(entry, schedule);
    },

    findByEventId(eventId: string): SavedImmediateEntry[] {
      const rows = selectByEventId.all(eventId);
      return rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        entry: JSON.parse(row.payload) as JournalEntry,
        postedAt: row.posted_at,
      }));
    },

    findPendingScheduled(asOfDate: string, now: number = Date.now()): SavedScheduledEntry[] {
      const rows = selectPendingScheduled.all(asOfDate, now);
      return rows.map((row) => ({
        id: row.id,
        eventId: row.event_id,
        subscriptionId: row.subscription_id,
        entry: JSON.parse(row.payload) as JournalEntry,
        status: row.status,
        attempts: row.attempts,
        lastAttemptedAt: row.last_attempted_at,
        nextAttemptAt: row.next_attempt_at,
        lastError: row.last_error,
      }));
    },

    markScheduledPosted(id: number): void {
      const info = markPosted.run(Date.now(), id);
      if (info.changes === 0) {
        throw new Error(`No pending scheduled entry with id=${String(id)}`);
      }
    },

    recordScheduledAttempt(
      id: number,
      attempts: number,
      lastAttemptedAt: number,
      nextAttemptAt: number | null,
      lastError: string,
      status: 'pending' | 'failed',
    ): void {
      const info = recordAttemptStmt.run(
        attempts,
        lastAttemptedAt,
        nextAttemptAt,
        lastError,
        status,
        id,
      );
      if (info.changes === 0) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
    },

    countImmediate(): number {
      return countImmediateStmt.get()?.count ?? 0;
    },

    countPendingScheduled(): number {
      return countPendingStmt.get()?.count ?? 0;
    },

    countFailedScheduled(): number {
      return countFailedStmt.get()?.count ?? 0;
    },
  };
}

/**
 * Convenience factory: returns a SQLite-backed `Storage`. `persistMapResult`
 * is wrapped in a single transaction so save + dedup record are atomic — if
 * any write throws (disk full, constraint violation), the whole bundle rolls
 * back and the event is *not* recorded as processed, so Stripe's next
 * redelivery will retry cleanly.
 */
export function sqliteStorage(db: Database.Database): Storage {
  const dedup = sqliteDeduplicator(db);
  const entries = sqliteJournalEntryStore(db);

  // Prepared statements for the transactional path. We bypass the public
  // store/dedup methods here so the writes can share the transaction.
  const insertImmediate = db.prepare<
    [string, number, string, string, string, string, string | null, string]
  >(
    `INSERT INTO journal_entries
       (event_id, posted_at, date, currency, memo, source_event_type, source_object_id, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const insertScheduled = db.prepare<[string, string, string, string]>(
    `INSERT INTO scheduled_entries
       (event_id, subscription_id, scheduled_date, payload)
     VALUES (?, ?, ?, ?)`,
  );

  const recordEvent = db.prepare<[string, number]>(
    'INSERT OR IGNORE INTO processed_events (event_id, processed_at) VALUES (?, ?)',
  );

  const persistTxn = db.transaction((eventId: string, result: MapResult, now: number) => {
    for (const entry of result.entries) {
      insertImmediate.run(
        eventId,
        now,
        entry.date,
        entry.currency,
        entry.memo,
        entry.sourceEventType,
        entry.sourceObjectId ?? null,
        JSON.stringify(entry),
      );
    }
    if (result.schedule) {
      const sched = result.schedule;
      for (const entry of sched.entries) {
        insertScheduled.run(
          sched.sourceEventId,
          sched.subscriptionId,
          entry.date,
          JSON.stringify(entry),
        );
      }
    }
    recordEvent.run(eventId, now);
  });

  return {
    dedup,
    entries,
    persistMapResult(eventId: string, result: MapResult, now: number = Date.now()): void {
      persistTxn(eventId, result, now);
    },
  };
}
