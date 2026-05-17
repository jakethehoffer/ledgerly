import type { JournalEntry, MapResult, RecognitionSchedule } from '../../journal.js';
import type {
  Deduplicator,
  JournalEntryStore,
  SavedImmediateEntry,
  SavedScheduledEntry,
  Storage,
} from './types.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * In-memory deduplicator. Bounded by a TTL — old entries are garbage-collected
 * on every write. Stripe redelivers for up to ~3 days, so a 7-day default TTL
 * is safe for any single-instance dev or demo deployment.
 *
 * State lives in a JS `Map`, so it is lost on process restart.
 */
export function inMemoryDeduplicator(ttlMs: number = DEFAULT_TTL_MS): Deduplicator {
  const seen = new Map<string, number>();

  function gc(now: number): void {
    for (const [id, ts] of seen) {
      if (now - ts > ttlMs) seen.delete(id);
    }
  }

  return {
    has(eventId: string): boolean {
      return seen.has(eventId);
    },
    record(eventId: string, now: number = Date.now()): void {
      gc(now);
      seen.set(eventId, now);
    },
    checkAndRecord(eventId: string, now: number = Date.now()): boolean {
      gc(now);
      if (seen.has(eventId)) return true;
      seen.set(eventId, now);
      return false;
    },
    size(): number {
      return seen.size;
    },
  };
}

/**
 * In-memory journal entry store. Holds two append-only arrays plus a
 * monotonically-increasing ID counter. Suitable for tests and dev; loses state
 * on process restart.
 */
export function inMemoryJournalEntryStore(): JournalEntryStore {
  const immediate: SavedImmediateEntry[] = [];
  const scheduled: SavedScheduledEntry[] = [];
  let nextImmediateId = 1;
  let nextScheduledId = 1;

  return {
    saveImmediate(entry: JournalEntry, eventId: string): SavedImmediateEntry {
      const saved: SavedImmediateEntry = {
        id: nextImmediateId++,
        eventId,
        entry,
        postedAt: Date.now(),
      };
      immediate.push(saved);
      return saved;
    },

    saveScheduled(
      entry: JournalEntry,
      schedule: Pick<RecognitionSchedule, 'subscriptionId' | 'sourceEventId'>,
    ): SavedScheduledEntry {
      const saved: SavedScheduledEntry = {
        id: nextScheduledId++,
        eventId: schedule.sourceEventId,
        subscriptionId: schedule.subscriptionId,
        entry,
        status: 'pending',
      };
      scheduled.push(saved);
      return saved;
    },

    findByEventId(eventId: string): SavedImmediateEntry[] {
      return immediate.filter((row) => row.eventId === eventId);
    },

    findPendingScheduled(asOfDate: string): SavedScheduledEntry[] {
      return scheduled.filter(
        (row) => row.status === 'pending' && row.entry.date <= asOfDate,
      );
    },

    markScheduledPosted(id: number): void {
      const idx = scheduled.findIndex((row) => row.id === id);
      if (idx === -1) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
      // Replace with a new object so callers can't mutate ours via the array ref.
      const existing = scheduled[idx];
      if (!existing) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
      scheduled[idx] = { ...existing, status: 'posted' };
    },

    countImmediate(): number {
      return immediate.length;
    },

    countPendingScheduled(): number {
      return scheduled.reduce((acc, row) => acc + (row.status === 'pending' ? 1 : 0), 0);
    },
  };
}

/**
 * Convenience factory: returns a fresh in-memory `Storage` (dedup + entries
 * + atomic `persistMapResult`). Under JS single-threaded semantics the
 * sequential writes inside `persistMapResult` are atomic w.r.t. other webhook
 * requests, so no extra locking is required.
 */
export function inMemoryStorage(ttlMs?: number): Storage {
  const dedup = inMemoryDeduplicator(ttlMs);
  const entries = inMemoryJournalEntryStore();
  return {
    dedup,
    entries,
    persistMapResult(eventId: string, result: MapResult, now: number = Date.now()): void {
      for (const entry of result.entries) {
        entries.saveImmediate(entry, eventId);
      }
      if (result.schedule) {
        for (const entry of result.schedule.entries) {
          entries.saveScheduled(entry, result.schedule);
        }
      }
      dedup.record(eventId, now);
    },
  };
}
