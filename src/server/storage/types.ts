import type { JournalEntry, MapResult, RecognitionSchedule } from '../../journal.js';

/**
 * Event deduplication interface.
 *
 * Production receivers should persist the dedup state so that Stripe redeliveries
 * (up to 3 days, sometimes more) are caught across server restarts and rolling
 * deploys. The in-memory implementation has a 7-day TTL and is fine for dev /
 * single-instance demos, but loses state on restart.
 *
 * The split `has()` / `record()` shape lets the server check for an existing
 * event before doing the expensive expansion + mapping work, then record the
 * event ID atomically with persisting the resulting journal entries. The
 * `checkAndRecord()` convenience preserves the original single-call semantics
 * for code paths that don't need the split.
 */
export interface Deduplicator {
  /** Returns true if the event ID has been recorded as processed. */
  has(eventId: string): boolean;

  /** Records the event ID as processed at the given timestamp (epoch ms). */
  record(eventId: string, now?: number): void;

  /**
   * Convenience: returns true if the event was already seen, otherwise records
   * it and returns false. Equivalent to `has(id) || (record(id), false)`.
   */
  checkAndRecord(eventId: string, now?: number): boolean;

  /** Number of currently recorded (and not expired) event IDs. */
  size(): number;
}

/**
 * A journal entry that has been persisted as posted today (immediate).
 *
 * The `id` is the backend-assigned primary key. Callers downstream of the
 * receiver (a batch QBO/Xero sync job, an audit report) can use it to refer to
 * a specific persisted row.
 */
export interface SavedImmediateEntry {
  readonly id: number;
  readonly eventId: string;
  readonly entry: JournalEntry;
  readonly postedAt: number; // epoch ms
}

/**
 * A future-dated journal entry that is part of a recognition schedule. Status
 * starts as `'pending'`; a downstream poster transitions it to `'posted'` once
 * it has been pushed to QBO/Xero on or after `entry.date`.
 */
export interface SavedScheduledEntry {
  readonly id: number;
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly entry: JournalEntry;
  readonly status: 'pending' | 'posted' | 'cancelled';
}

/**
 * Journal entry persistence interface. Both immediate entries (posting today)
 * and future-dated entries (deferred-revenue recognition) live here.
 *
 * Implementations are not required to make `saveImmediate` / `saveScheduled`
 * atomic across multiple calls — callers that need cross-call atomicity should
 * use `Storage.persistMapResult` instead, which the SQLite backend wraps in a
 * single transaction.
 */
export interface JournalEntryStore {
  /** Persist a journal entry that posts immediately (today). */
  saveImmediate(entry: JournalEntry, eventId: string): SavedImmediateEntry;

  /** Persist a future-dated entry from a RecognitionSchedule. */
  saveScheduled(
    entry: JournalEntry,
    schedule: Pick<RecognitionSchedule, 'subscriptionId' | 'sourceEventId'>,
  ): SavedScheduledEntry;

  /** Query: immediate entries for an event ID, oldest-first. */
  findByEventId(eventId: string): SavedImmediateEntry[];

  /** Query: pending scheduled entries with scheduled_date <= asOfDate (YYYY-MM-DD). */
  findPendingScheduled(asOfDate: string): SavedScheduledEntry[];

  /** Mark a scheduled entry as posted. Throws if the ID does not exist. */
  markScheduledPosted(id: number): void;

  /** Count of immediate journal entries (for /health). */
  countImmediate(): number;

  /** Count of pending scheduled entries (for /health). */
  countPendingScheduled(): number;
}

/**
 * Aggregate persistence handle bundling a deduplicator and journal entry store.
 *
 * `persistMapResult` is the single-call entry point the server uses after a
 * successful `mapEvent`: it persists every immediate entry, every scheduled
 * entry, and records the event ID as processed — atomically per backend
 * semantics. The SQLite backend wraps the work in a transaction; the in-memory
 * backend runs sequentially (atomic under JS single-threaded semantics).
 */
export interface Storage {
  readonly dedup: Deduplicator;
  readonly entries: JournalEntryStore;

  /**
   * Persist every entry in `result` and record `eventId` as processed.
   * Atomic per-backend: either all writes land and the event is recorded, or
   * none do.
   */
  persistMapResult(eventId: string, result: MapResult, now?: number): void;
}
