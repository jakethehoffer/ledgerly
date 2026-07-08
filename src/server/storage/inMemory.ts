import type { JournalEntry, MapResult, RecognitionSchedule } from '../../journal.js';
import type { ConnectedTokens, OAuthProvider } from '../oauth/types.js';
import type {
  CreditReconcileInput,
  Deduplicator,
  JournalEntryStore,
  OAuthTokenStore,
  PersistResult,
  SavedImmediateEntry,
  SavedScheduledEntry,
  Storage,
  VoidReconcileInput,
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
        attempts: 0,
        lastAttemptedAt: null,
        nextAttemptAt: null,
        lastError: null,
      };
      scheduled.push(saved);
      return saved;
    },

    findByEventId(eventId: string): SavedImmediateEntry[] {
      return immediate.filter((row) => row.eventId === eventId);
    },

    findPendingScheduled(asOfDate: string, now: number = Date.now()): SavedScheduledEntry[] {
      return scheduled.filter(
        (row) =>
          row.status === 'pending' &&
          row.entry.date <= asOfDate &&
          (row.nextAttemptAt === null || row.nextAttemptAt <= now),
      );
    },

    findScheduledBySubscription(subscriptionId: string): SavedScheduledEntry[] {
      return scheduled.filter((row) => row.subscriptionId === subscriptionId);
    },

    cancelScheduled(id: number): void {
      const idx = scheduled.findIndex((row) => row.id === id);
      if (idx === -1) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
      const existing = scheduled[idx];
      if (!existing) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
      // Only an in-flight (pending) or dead-lettered (failed) row can be
      // cancelled; a row that already posted stays posted, and re-cancelling is
      // a no-op. This keeps a void reconciliation safe against a row the
      // scheduler posted a moment earlier.
      if (existing.status === 'pending' || existing.status === 'failed') {
        scheduled[idx] = { ...existing, status: 'cancelled' };
      }
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

    recordScheduledAttempt(
      id: number,
      attempts: number,
      lastAttemptedAt: number,
      nextAttemptAt: number | null,
      lastError: string,
      status: 'pending' | 'failed',
    ): void {
      const idx = scheduled.findIndex((row) => row.id === id);
      if (idx === -1) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
      const existing = scheduled[idx];
      if (!existing) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
      scheduled[idx] = {
        ...existing,
        status,
        attempts,
        lastAttemptedAt,
        nextAttemptAt,
        lastError,
      };
    },

    countImmediate(): number {
      return immediate.length;
    },

    countPendingScheduled(): number {
      return scheduled.reduce((acc, row) => acc + (row.status === 'pending' ? 1 : 0), 0);
    },

    countFailedScheduled(): number {
      return scheduled.reduce((acc, row) => acc + (row.status === 'failed' ? 1 : 0), 0);
    },

    listRecentImmediate(limit: number = 50): SavedImmediateEntry[] {
      const cap = Math.min(Math.max(limit, 0), 500);
      // Sort descending by id — append-only ids are monotonically increasing so
      // this is equivalent to "newest first".
      return [...immediate].sort((a, b) => b.id - a.id).slice(0, cap);
    },

    listScheduledByStatus(
      status: SavedScheduledEntry['status'],
      limit: number = 50,
    ): SavedScheduledEntry[] {
      const cap = Math.min(Math.max(limit, 0), 500);
      return [...scheduled]
        .filter((row) => row.status === status)
        .sort((a, b) => b.id - a.id)
        .slice(0, cap);
    },

    getScheduledById(id: number): SavedScheduledEntry | null {
      return scheduled.find((row) => row.id === id) ?? null;
    },

    requeueScheduled(id: number): SavedScheduledEntry {
      const idx = scheduled.findIndex((row) => row.id === id);
      if (idx === -1) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
      const existing = scheduled[idx];
      if (!existing) {
        throw new Error(`No scheduled entry with id=${String(id)}`);
      }
      const updated: SavedScheduledEntry = {
        ...existing,
        status: 'pending',
        attempts: 0,
        lastAttemptedAt: null,
        nextAttemptAt: null,
        lastError: null,
      };
      scheduled[idx] = updated;
      return updated;
    },
  };
}

/**
 * In-memory OAuth token store. Backed by a `Map` keyed by
 * `${provider}::${tenantId}` so it satisfies the same `(provider, tenantId)`
 * primary-key semantics as the SQLite backend without any extra bookkeeping.
 */
export function inMemoryOAuthTokenStore(): OAuthTokenStore {
  const rows = new Map<string, ConnectedTokens>();

  function key(provider: OAuthProvider, tenantId: string): string {
    return `${provider}::${tenantId}`;
  }

  return {
    save(tokens: ConnectedTokens): void {
      rows.set(key(tokens.provider, tokens.tenantId), tokens);
    },

    get(provider: OAuthProvider): ConnectedTokens | null {
      const matches = [...rows.values()].filter((row) => row.provider === provider);
      if (matches.length === 0) return null;
      if (matches.length > 1) {
        throw new Error(
          `Multiple token rows for provider=${provider}; use list() in multi-tenant deployments`,
        );
      }
      return matches[0] ?? null;
    },

    list(provider: OAuthProvider): ConnectedTokens[] {
      return [...rows.values()].filter((row) => row.provider === provider);
    },

    delete(provider: OAuthProvider, tenantId: string): void {
      rows.delete(key(provider, tenantId));
    },
  };
}

/**
 * Convenience factory: returns a fresh in-memory `Storage` (dedup + entries
 * + oauth + atomic `persistMapResult`). Under JS single-threaded semantics the
 * sequential writes inside `persistMapResult` are atomic w.r.t. other webhook
 * requests, so no extra locking is required.
 *
 * Note: every immediate entry is persisted to BOTH the journal entry audit log
 * (via `saveImmediate`) AND the dispatch queue (via `saveScheduled` with a
 * synthetic `immediate:<sourceEventId>` subscription ID). The scheduler picks
 * the latter up on its next tick and pushes the entry to QBO/Xero. The
 * journal-entries row remains the canonical audit record.
 */
export function inMemoryStorage(ttlMs?: number): Storage {
  const dedup = inMemoryDeduplicator(ttlMs);
  const entries = inMemoryJournalEntryStore();
  const oauth = inMemoryOAuthTokenStore();
  return {
    dedup,
    entries,
    oauth,
    ping(): void {
      // In-memory storage is reachable for as long as the process is alive.
      // No I/O happens; if this function is reachable at all, the storage is.
    },
    persistMapResult(
      eventId: string,
      result: MapResult,
      now: number = Date.now(),
    ): PersistResult {
      // Idempotency boundary. The has() check, the writes, and record() run
      // with no `await` between them, so under JS single-threaded semantics
      // this whole block is atomic with respect to other webhook handlers — a
      // duplicate that raced past the receiver's cheap has() pre-check loses
      // here and writes nothing. record() stays AFTER the writes so a mid-write
      // throw never marks the event processed (this backend has no transaction
      // to roll back), leaving Stripe's redelivery free to retry cleanly.
      if (dedup.has(eventId)) return { duplicate: true };
      for (const entry of result.entries) {
        entries.saveImmediate(entry, eventId);
        // Also enqueue for dispatch. Synthetic subscriptionId distinguishes
        // immediate dispatch rows from real recognition-schedule rows.
        entries.saveScheduled(entry, {
          subscriptionId: `immediate:${entry.sourceEventId}`,
          sourceEventId: entry.sourceEventId,
        });
      }
      if (result.schedule) {
        for (const entry of result.schedule.entries) {
          entries.saveScheduled(entry, result.schedule);
        }
      }
      dedup.record(eventId, now);
      return { duplicate: false };
    },
    persistVoidReversal(
      eventId: string,
      input: VoidReconcileInput,
      now: number = Date.now(),
    ): PersistResult {
      // Same idempotency boundary as persistMapResult: has()/writes/record()
      // run with no await between them, so under JS single-threaded semantics
      // the read, the cancellations, and the reversal posting are atomic with
      // respect to other webhook handlers and the scheduler's own callbacks.
      if (dedup.has(eventId)) return { duplicate: true };
      const rows = entries
        .findScheduledBySubscription(input.subscriptionId)
        .filter((row) => row.entry.sourceObjectId === input.invoiceId);
      const posted = rows.filter((row) => row.status === 'posted').map((row) => row.entry);
      for (const row of rows) {
        if (row.status === 'pending' || row.status === 'failed') {
          entries.cancelScheduled(row.id);
        }
      }
      const reversal = input.buildReversal(posted);
      entries.saveImmediate(reversal, eventId);
      // Enqueue for dispatch to QBO/Xero, exactly like an immediate entry.
      entries.saveScheduled(reversal, {
        subscriptionId: `immediate:${reversal.sourceEventId}`,
        sourceEventId: reversal.sourceEventId,
      });
      dedup.record(eventId, now);
      return { duplicate: false };
    },
    persistCreditReversal(
      eventId: string,
      input: CreditReconcileInput,
      now: number = Date.now(),
    ): PersistResult {
      // Same idempotency boundary as persistVoidReversal. Read the invoice's
      // recognition rows, hand the posted (recognized) and pending (still
      // deferred) ones to build(), cancel the pending ones, post the reversal,
      // and enqueue the re-spread schedule — atomic under JS single-threaded
      // semantics (no await between has() and record()).
      if (dedup.has(eventId)) return { duplicate: true };
      const rows = entries
        .findScheduledBySubscription(input.subscriptionId)
        .filter((row) => row.entry.sourceObjectId === input.invoiceId);
      const posted = rows.filter((row) => row.status === 'posted').map((row) => row.entry);
      const pending = rows
        .filter((row) => row.status === 'pending' || row.status === 'failed')
        .map((row) => row.entry);
      const { reversal, reducedSchedule } = input.build(posted, pending);
      for (const row of rows) {
        if (row.status === 'pending' || row.status === 'failed') {
          entries.cancelScheduled(row.id);
        }
      }
      entries.saveImmediate(reversal, eventId);
      entries.saveScheduled(reversal, {
        subscriptionId: `immediate:${reversal.sourceEventId}`,
        sourceEventId: reversal.sourceEventId,
      });
      if (reducedSchedule) {
        for (const entry of reducedSchedule.entries) {
          entries.saveScheduled(entry, reducedSchedule);
        }
      }
      dedup.record(eventId, now);
      return { duplicate: false };
    },
  };
}
