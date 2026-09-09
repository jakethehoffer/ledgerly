import { describe, it, expect } from 'vitest';
import { cents } from '../../../src/money.js';
import type { JournalEntry, MapResult, RecognitionSchedule } from '../../../src/journal.js';
import type { ConnectedTokens } from '../../../src/server/oauth/types.js';
import type { SavedScheduledEntry, Storage } from '../../../src/server/storage/types.js';

/**
 * A balanced journal entry suitable for storage tests. Real engine output is
 * tested elsewhere; here we just need a value that satisfies the type.
 */
function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    date: '2026-05-16',
    currency: 'USD',
    memo: 'test memo',
    sourceEventId: 'evt_test_1',
    sourceEventType: 'charge.succeeded',
    sourceObjectId: 'ch_test_1',
    lines: [
      { accountCode: '1010', side: 'debit', amount: cents(10000) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ],
    ...overrides,
  };
}

/**
 * Run the shared storage interface suite against a factory. Both the
 * in-memory and SQLite backends pass this same suite — that's how we
 * guarantee interface compatibility without leaking implementation details
 * into either spec.
 */
export function runStorageSuite(name: string, factory: () => Storage): void {
  describe(name, () => {
    describe('Deduplicator', () => {
      it('has() returns false for unseen IDs', () => {
        const storage = factory();
        expect(storage.dedup.has('evt_1')).toBe(false);
      });

      it('record() then has() returns true', () => {
        const storage = factory();
        storage.dedup.record('evt_1');
        expect(storage.dedup.has('evt_1')).toBe(true);
      });

      it('checkAndRecord() returns false on first call, true on second', () => {
        const storage = factory();
        expect(storage.dedup.checkAndRecord('evt_1')).toBe(false);
        expect(storage.dedup.checkAndRecord('evt_1')).toBe(true);
      });

      it('size() reflects current state', () => {
        const storage = factory();
        expect(storage.dedup.size()).toBe(0);
        storage.dedup.record('evt_1');
        expect(storage.dedup.size()).toBe(1);
        storage.dedup.record('evt_2');
        expect(storage.dedup.size()).toBe(2);
        // Re-recording an existing ID is a no-op for size.
        storage.dedup.record('evt_1');
        expect(storage.dedup.size()).toBe(2);
      });

      it('treats distinct IDs independently', () => {
        const storage = factory();
        storage.dedup.record('evt_1');
        expect(storage.dedup.has('evt_1')).toBe(true);
        expect(storage.dedup.has('evt_2')).toBe(false);
      });
    });

    describe('JournalEntryStore', () => {
      it('empty store reports zero counts and returns no rows', () => {
        const storage = factory();
        expect(storage.entries.countImmediate()).toBe(0);
        expect(storage.entries.countPendingScheduled()).toBe(0);
        expect(storage.entries.findByEventId('evt_missing')).toEqual([]);
        expect(storage.entries.findPendingScheduled('2026-05-16')).toEqual([]);
      });

      it('saveImmediate persists and findByEventId returns it', () => {
        const storage = factory();
        const entry = makeEntry();
        const saved = storage.entries.saveImmediate(entry, 'evt_x');

        expect(saved.id).toBeGreaterThan(0);
        expect(saved.eventId).toBe('evt_x');
        expect(saved.entry).toEqual(entry);
        expect(saved.postedAt).toBeGreaterThan(0);

        const found = storage.entries.findByEventId('evt_x');
        expect(found).toHaveLength(1);
        expect(found[0]?.entry).toEqual(entry);
        expect(storage.entries.countImmediate()).toBe(1);
      });

      it('saveImmediate accepts multiple entries for the same event', () => {
        const storage = factory();
        const a = makeEntry({ memo: 'a' });
        const b = makeEntry({ memo: 'b' });
        storage.entries.saveImmediate(a, 'evt_x');
        storage.entries.saveImmediate(b, 'evt_x');

        const found = storage.entries.findByEventId('evt_x');
        expect(found).toHaveLength(2);
        expect(found.map((row) => row.entry.memo).sort()).toEqual(['a', 'b']);
        expect(storage.entries.countImmediate()).toBe(2);
      });

      it('saveImmediate isolates entries by event ID', () => {
        const storage = factory();
        storage.entries.saveImmediate(makeEntry({ memo: 'x' }), 'evt_x');
        storage.entries.saveImmediate(makeEntry({ memo: 'y' }), 'evt_y');
        expect(storage.entries.findByEventId('evt_x')).toHaveLength(1);
        expect(storage.entries.findByEventId('evt_y')).toHaveLength(1);
        expect(storage.entries.findByEventId('evt_z')).toEqual([]);
      });

      it('saveScheduled persists with pending status', () => {
        const storage = factory();
        const entry = makeEntry({ date: '2026-06-16' });
        const saved = storage.entries.saveScheduled(entry, {
          subscriptionId: 'sub_123',
          sourceEventId: 'evt_sched',
        });
        expect(saved.status).toBe('pending');
        expect(saved.subscriptionId).toBe('sub_123');
        expect(saved.eventId).toBe('evt_sched');
        expect(saved.entry).toEqual(entry);
        expect(storage.entries.countPendingScheduled()).toBe(1);
      });

      it('findPendingScheduled returns rows due on or before asOfDate', () => {
        const storage = factory();
        const future = makeEntry({ date: '2026-12-31' });
        const past = makeEntry({ date: '2026-01-01' });
        const today = makeEntry({ date: '2026-05-16' });
        storage.entries.saveScheduled(future, {
          subscriptionId: 'sub_1',
          sourceEventId: 'evt_1',
        });
        storage.entries.saveScheduled(past, {
          subscriptionId: 'sub_1',
          sourceEventId: 'evt_1',
        });
        storage.entries.saveScheduled(today, {
          subscriptionId: 'sub_1',
          sourceEventId: 'evt_1',
        });

        const due = storage.entries.findPendingScheduled('2026-05-16');
        const dueDates = due.map((row) => row.entry.date).sort();
        expect(dueDates).toEqual(['2026-01-01', '2026-05-16']);
      });

      it('markScheduledPosted flips status and excludes from subsequent queries', () => {
        const storage = factory();
        const entry = makeEntry({ date: '2026-05-01' });
        const saved = storage.entries.saveScheduled(entry, {
          subscriptionId: 'sub_1',
          sourceEventId: 'evt_1',
        });
        expect(storage.entries.findPendingScheduled('2026-05-16')).toHaveLength(1);

        storage.entries.markScheduledPosted(saved.id);

        expect(storage.entries.findPendingScheduled('2026-05-16')).toHaveLength(0);
        expect(storage.entries.countPendingScheduled()).toBe(0);
      });

      it('markScheduledPosted throws on unknown ID', () => {
        const storage = factory();
        expect(() => {
          storage.entries.markScheduledPosted(99999);
        }).toThrow();
      });

      it('findScheduledBySubscription returns only that subscription, all statuses', () => {
        const storage = factory();
        const a = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_target',
          sourceEventId: 'evt_fin',
        });
        const b = storage.entries.saveScheduled(makeEntry({ date: '2026-06-01' }), {
          subscriptionId: 'sub_target',
          sourceEventId: 'evt_fin',
        });
        storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_other',
          sourceEventId: 'evt_other',
        });
        // Posted rows are still returned — the void reversal needs them to
        // measure what has recognized.
        storage.entries.markScheduledPosted(a.id);

        const rows = storage.entries.findScheduledBySubscription('sub_target');
        expect(rows.map((r) => r.id).sort((x, y) => x - y)).toEqual([a.id, b.id]);
        expect(rows.find((r) => r.id === a.id)?.status).toBe('posted');
        expect(rows.find((r) => r.id === b.id)?.status).toBe('pending');
      });

      it('cancelScheduled flips a pending row to cancelled and out of the pending queue', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_c',
          sourceEventId: 'evt_c',
        });
        storage.entries.cancelScheduled(saved.id);
        expect(storage.entries.getScheduledById(saved.id)?.status).toBe('cancelled');
        expect(storage.entries.findPendingScheduled('2026-05-16')).toHaveLength(0);
        expect(storage.entries.countPendingScheduled()).toBe(0);
      });

      it('cancelScheduled leaves a posted row posted (no-op, not an error)', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_c2',
          sourceEventId: 'evt_c2',
        });
        storage.entries.markScheduledPosted(saved.id);
        expect(() => {
          storage.entries.cancelScheduled(saved.id);
        }).not.toThrow();
        expect(storage.entries.getScheduledById(saved.id)?.status).toBe('posted');
      });

      it('cancelScheduled throws on unknown ID', () => {
        const storage = factory();
        expect(() => {
          storage.entries.cancelScheduled(99999);
        }).toThrow();
      });

      it('saveScheduled defaults the retry-tracking fields', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_defaults',
          sourceEventId: 'evt_defaults',
        });
        expect(saved.attempts).toBe(0);
        expect(saved.lastAttemptedAt).toBeNull();
        expect(saved.nextAttemptAt).toBeNull();
        expect(saved.lastError).toBeNull();
      });

      it('recordScheduledAttempt updates attempts / timestamps / error / status', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_1',
          sourceEventId: 'evt_1',
        });
        storage.entries.recordScheduledAttempt(
          saved.id,
          3,
          1_000_000,
          1_060_000,
          'boom',
          'pending',
        );
        // Query at a time past next_attempt_at so the entry surfaces.
        const due = storage.entries.findPendingScheduled('2026-05-16', 2_000_000);
        expect(due).toHaveLength(1);
        expect(due[0]?.attempts).toBe(3);
        expect(due[0]?.lastAttemptedAt).toBe(1_000_000);
        expect(due[0]?.nextAttemptAt).toBe(1_060_000);
        expect(due[0]?.lastError).toBe('boom');
        expect(due[0]?.status).toBe('pending');
      });

      it('records a dispatch start before the outside send finishes', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_start',
          sourceEventId: 'evt_start',
        });

        storage.entries.markScheduledAttemptStarted(saved.id, 1, 1_000_000);

        const started = storage.entries.getScheduledById(saved.id);
        expect(started?.status).toBe('pending');
        expect(started?.attempts).toBe(1);
        expect(started?.lastAttemptedAt).toBe(1_000_000);
        expect(started?.nextAttemptAt).toBeNull();
        expect(started?.lastError).toBeNull();
      });

      it('recordScheduledAttempt can transition to failed (dead-letter)', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_dl',
          sourceEventId: 'evt_dl',
        });
        storage.entries.recordScheduledAttempt(saved.id, 10, 5_000_000, null, 'gave up', 'failed');
        // 'failed' rows are excluded from findPendingScheduled at any time.
        expect(storage.entries.findPendingScheduled('2026-05-16', 9_999_999_999)).toEqual([]);
        expect(storage.entries.countPendingScheduled()).toBe(0);
        expect(storage.entries.countFailedScheduled()).toBe(1);
      });

      it('findPendingScheduled excludes entries whose next_attempt_at is in the future', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_backoff',
          sourceEventId: 'evt_backoff',
        });
        // Backoff schedules retry at t=2000.
        storage.entries.recordScheduledAttempt(saved.id, 1, 1000, 2000, 'transient', 'pending');

        // At t=1500 (before backoff expires) the entry is NOT due.
        expect(storage.entries.findPendingScheduled('2026-05-16', 1500)).toEqual([]);
        // At t=2000 (exactly) the entry IS due.
        expect(storage.entries.findPendingScheduled('2026-05-16', 2000).map((r) => r.id)).toEqual([
          saved.id,
        ]);
        // At t=2500 (past backoff) the entry IS due.
        expect(storage.entries.findPendingScheduled('2026-05-16', 2500).map((r) => r.id)).toEqual([
          saved.id,
        ]);
      });

      it('findPendingScheduled includes entries with next_attempt_at = NULL (fresh)', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_fresh',
          sourceEventId: 'evt_fresh',
        });
        // A fresh entry has next_attempt_at = null → always ready.
        expect(storage.entries.findPendingScheduled('2026-05-16', 0).map((r) => r.id)).toEqual([
          saved.id,
        ]);
      });

      it('countFailedScheduled reflects dead-lettered entries', () => {
        const storage = factory();
        const a = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_a',
          sourceEventId: 'evt_a',
        });
        const b = storage.entries.saveScheduled(makeEntry({ date: '2026-05-02' }), {
          subscriptionId: 'sub_b',
          sourceEventId: 'evt_b',
        });
        storage.entries.saveScheduled(makeEntry({ date: '2026-05-03' }), {
          subscriptionId: 'sub_c',
          sourceEventId: 'evt_c',
        });
        expect(storage.entries.countFailedScheduled()).toBe(0);
        storage.entries.recordScheduledAttempt(a.id, 10, 1, null, 'x', 'failed');
        expect(storage.entries.countFailedScheduled()).toBe(1);
        storage.entries.recordScheduledAttempt(b.id, 10, 1, null, 'y', 'failed');
        expect(storage.entries.countFailedScheduled()).toBe(2);
      });

      it('listRecentImmediate returns newest-first and respects limit', () => {
        const storage = factory();
        const ids: number[] = [];
        for (let i = 0; i < 5; i++) {
          const saved = storage.entries.saveImmediate(
            makeEntry({ memo: `e${String(i)}` }),
            `evt_${String(i)}`,
          );
          ids.push(saved.id);
        }
        const all = storage.entries.listRecentImmediate(50);
        expect(all).toHaveLength(5);
        // Newest-first = descending id.
        expect(all.map((r) => r.id)).toEqual([...ids].reverse());
        const top2 = storage.entries.listRecentImmediate(2);
        expect(top2.map((r) => r.id)).toEqual(ids.slice(-2).reverse());
      });

      it('listRecentImmediate defaults to 50 and clamps at 500', () => {
        const storage = factory();
        storage.entries.saveImmediate(makeEntry(), 'evt_1');
        // Default
        expect(storage.entries.listRecentImmediate()).toHaveLength(1);
        // Clamp — passing 10_000 should not throw; we just verify the call
        // succeeds and returns at most the row count.
        expect(storage.entries.listRecentImmediate(10_000)).toHaveLength(1);
      });

      it('listScheduledByStatus filters by status and returns newest-first', () => {
        const storage = factory();
        const a = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01', memo: 'a' }), {
          subscriptionId: 'sub_a',
          sourceEventId: 'evt_a',
        });
        const b = storage.entries.saveScheduled(makeEntry({ date: '2026-05-02', memo: 'b' }), {
          subscriptionId: 'sub_b',
          sourceEventId: 'evt_b',
        });
        const c = storage.entries.saveScheduled(makeEntry({ date: '2026-05-03', memo: 'c' }), {
          subscriptionId: 'sub_c',
          sourceEventId: 'evt_c',
        });
        // Transition b to posted, c to failed; a stays pending.
        storage.entries.markScheduledPosted(b.id);
        storage.entries.recordScheduledAttempt(c.id, 10, 1, null, 'gave up', 'failed');

        const pending = storage.entries.listScheduledByStatus('pending');
        expect(pending.map((r) => r.id)).toEqual([a.id]);
        const posted = storage.entries.listScheduledByStatus('posted');
        expect(posted.map((r) => r.id)).toEqual([b.id]);
        const failed = storage.entries.listScheduledByStatus('failed');
        expect(failed.map((r) => r.id)).toEqual([c.id]);
      });

      it('getScheduledById returns the row or null', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_g',
          sourceEventId: 'evt_g',
        });
        const got = storage.entries.getScheduledById(saved.id);
        expect(got?.id).toBe(saved.id);
        expect(got?.subscriptionId).toBe('sub_g');
        expect(storage.entries.getScheduledById(999_999)).toBeNull();
      });

      it('requeueScheduled resets a failed entry to pending with cleared retry fields', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_r',
          sourceEventId: 'evt_r',
        });
        storage.entries.recordScheduledAttempt(saved.id, 7, 5_000, null, 'gave up', 'failed');
        expect(storage.entries.countFailedScheduled()).toBe(1);

        const requeued = storage.entries.requeueScheduled(saved.id);
        expect(requeued.status).toBe('pending');
        expect(requeued.attempts).toBe(0);
        expect(requeued.lastAttemptedAt).toBeNull();
        expect(requeued.nextAttemptAt).toBeNull();
        expect(requeued.lastError).toBeNull();
        expect(storage.entries.countFailedScheduled()).toBe(0);
        expect(storage.entries.countPendingScheduled()).toBe(1);
        // Now findPendingScheduled picks it up.
        expect(storage.entries.findPendingScheduled('2026-12-31').map((r) => r.id)).toContain(
          saved.id,
        );
      });

      it('requeueScheduled refuses every state except failed without changing the row', () => {
        const storage = factory();
        const pending = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_pending',
          sourceEventId: 'evt_pending',
        });
        storage.entries.markScheduledAttemptStarted(pending.id, 1, 1_000);

        const posted = storage.entries.saveScheduled(makeEntry({ date: '2026-05-02' }), {
          subscriptionId: 'sub_posted',
          sourceEventId: 'evt_posted',
        });
        storage.entries.markScheduledPosted(posted.id);

        const cancelled = storage.entries.saveScheduled(makeEntry({ date: '2026-05-03' }), {
          subscriptionId: 'sub_cancelled',
          sourceEventId: 'evt_cancelled',
        });
        storage.entries.cancelScheduled(cancelled.id);

        const held = storage.entries.saveScheduled(makeEntry({ date: '2026-05-04' }), {
          subscriptionId: 'sub_held',
          sourceEventId: 'evt_held',
        });
        storage.entries.holdScheduled(held.id);

        for (const [row, status] of [
          [pending, 'pending'],
          [posted, 'posted'],
          [cancelled, 'cancelled'],
          [held, 'held'],
        ] as const) {
          expect(() => storage.entries.requeueScheduled(row.id)).toThrow(/only failed/i);
          expect(storage.entries.getScheduledById(row.id)?.status).toBe(status);
        }
        expect(storage.entries.getScheduledById(pending.id)?.attempts).toBe(1);
      });

      it('requeueScheduled throws on unknown id', () => {
        const storage = factory();
        expect(() => storage.entries.requeueScheduled(999_999)).toThrow();
      });
    });

    describe('OAuthTokenStore', () => {
      function makeTokens(overrides: Partial<ConnectedTokens> = {}): ConnectedTokens {
        return {
          provider: 'qbo',
          tenantId: 'realm-1',
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          expiresAt: 1_700_000_000,
          scope: 'com.intuit.quickbooks.accounting',
          ...overrides,
        };
      }

      it('empty store returns null from get() and [] from list()', () => {
        const storage = factory();
        expect(storage.oauth.get('qbo')).toBeNull();
        expect(storage.oauth.get('xero')).toBeNull();
        expect(storage.oauth.list('qbo')).toEqual([]);
      });

      it('save + get round-trip', () => {
        const storage = factory();
        const tokens = makeTokens();
        storage.oauth.save(tokens);
        const got = storage.oauth.get('qbo');
        expect(got).toEqual(tokens);
      });

      it('save is an upsert on (provider, tenant_id) — re-saving replaces the row', () => {
        const storage = factory();
        storage.oauth.save(makeTokens({ accessToken: 'v1' }));
        storage.oauth.save(makeTokens({ accessToken: 'v2', refreshToken: 'r2' }));
        const got = storage.oauth.get('qbo');
        expect(got?.accessToken).toBe('v2');
        expect(got?.refreshToken).toBe('r2');
        // Only one row total.
        expect(storage.oauth.list('qbo')).toHaveLength(1);
      });

      it('list returns all rows for a provider', () => {
        const storage = factory();
        storage.oauth.save(makeTokens({ provider: 'qbo', tenantId: 'realm-1' }));
        storage.oauth.save(makeTokens({ provider: 'qbo', tenantId: 'realm-2' }));
        storage.oauth.save(makeTokens({ provider: 'xero', tenantId: 'tenant-x' }));
        expect(storage.oauth.list('qbo')).toHaveLength(2);
        expect(storage.oauth.list('xero')).toHaveLength(1);
      });

      it('get() throws when multiple rows exist for the provider', () => {
        const storage = factory();
        storage.oauth.save(makeTokens({ tenantId: 'realm-a' }));
        storage.oauth.save(makeTokens({ tenantId: 'realm-b' }));
        expect(() => storage.oauth.get('qbo')).toThrow(/multi-tenant/i);
      });

      it('delete removes only the matching (provider, tenant_id)', () => {
        const storage = factory();
        storage.oauth.save(makeTokens({ tenantId: 'realm-a' }));
        storage.oauth.save(makeTokens({ tenantId: 'realm-b' }));
        storage.oauth.delete('qbo', 'realm-a');
        const remaining = storage.oauth.list('qbo');
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.tenantId).toBe('realm-b');
      });

      it('delete is a no-op for nonexistent rows', () => {
        const storage = factory();
        expect(() => {
          storage.oauth.delete('qbo', 'never-existed');
        }).not.toThrow();
      });

      it('isolates qbo and xero rows', () => {
        const storage = factory();
        storage.oauth.save(makeTokens({ provider: 'qbo', tenantId: 'realm-1' }));
        storage.oauth.save(
          makeTokens({ provider: 'xero', tenantId: 'tenant-1', scope: 'accounting.transactions' }),
        );
        expect(storage.oauth.get('qbo')?.tenantId).toBe('realm-1');
        expect(storage.oauth.get('xero')?.tenantId).toBe('tenant-1');
      });
    });

    describe('persistMapResult', () => {
      it('persists immediate entries, schedule entries, and records dedup atomically', () => {
        const storage = factory();
        const immediate = makeEntry({ memo: 'immediate', sourceEventId: 'evt_annual' });
        const sched1 = makeEntry({ date: '2026-06-01', memo: 'month1' });
        const sched2 = makeEntry({ date: '2026-07-01', memo: 'month2' });

        const result: MapResult = {
          entries: [immediate],
          schedule: {
            subscriptionId: 'sub_annual',
            sourceEventId: 'evt_annual',
            entries: [sched1, sched2],
          },
        };

        storage.persistMapResult('evt_annual', result);

        expect(storage.dedup.has('evt_annual')).toBe(true);
        expect(storage.entries.countImmediate()).toBe(1);
        // Immediate entries are ALSO enqueued for dispatch, so pendingScheduled
        // counts the 1 immediate + 2 recognition = 3 rows.
        expect(storage.entries.countPendingScheduled()).toBe(3);

        const found = storage.entries.findByEventId('evt_annual');
        expect(found).toHaveLength(1);
        expect(found[0]?.entry.memo).toBe('immediate');

        const due = storage.entries.findPendingScheduled('2026-12-31');
        expect(due).toHaveLength(3);
        expect(due.map((row) => row.entry.memo).sort()).toEqual(['immediate', 'month1', 'month2']);

        // The immediate-dispatch row uses a synthetic subscriptionId that
        // distinguishes it from the recognition-schedule rows.
        const immediateDispatch = due.find((row) => row.entry.memo === 'immediate');
        expect(immediateDispatch?.subscriptionId).toBe('immediate:evt_annual');
        expect(immediateDispatch?.eventId).toBe('evt_annual');
        // Recognition rows still carry the real subscription id.
        const recognitionRows = due.filter((row) => row.entry.memo !== 'immediate');
        for (const row of recognitionRows) {
          expect(row.subscriptionId).toBe('sub_annual');
        }
      });

      it('handles a MapResult with no schedule', () => {
        const storage = factory();
        const result: MapResult = {
          entries: [makeEntry()],
          schedule: null,
        };
        storage.persistMapResult('evt_simple', result);
        expect(storage.dedup.has('evt_simple')).toBe(true);
        expect(storage.entries.countImmediate()).toBe(1);
        // The lone immediate entry is also enqueued for dispatch.
        expect(storage.entries.countPendingScheduled()).toBe(1);
        const due = storage.entries.findPendingScheduled('2026-12-31');
        expect(due).toHaveLength(1);
        expect(due[0]?.subscriptionId).toBe('immediate:evt_test_1');
        expect(due[0]?.eventId).toBe('evt_test_1');
        expect(due[0]?.nextAttemptAt).toBeNull();
        expect(due[0]?.attempts).toBe(0);
      });

      it('handles an empty MapResult (informational events)', () => {
        const storage = factory();
        const result: MapResult = { entries: [], schedule: null };
        storage.persistMapResult('evt_noop', result);
        expect(storage.dedup.has('evt_noop')).toBe(true);
        expect(storage.entries.countImmediate()).toBe(0);
        expect(storage.entries.countPendingScheduled()).toBe(0);
      });

      it('is idempotent — re-persisting the same event writes entries once and reports duplicate', () => {
        const storage = factory();
        const result: MapResult = {
          entries: [makeEntry({ sourceEventId: 'evt_dup', memo: 'first' })],
          schedule: {
            subscriptionId: 'sub_dup',
            sourceEventId: 'evt_dup',
            entries: [makeEntry({ date: '2026-06-01', memo: 'sched' })],
          },
        };

        // Two deliveries of the same event reach persistence (e.g. both raced
        // past the handler's cheap has() pre-check during the await-expansion
        // gap). The persistence layer is the correctness boundary: the first
        // claim wins and writes; the second is a no-op duplicate.
        const first = storage.persistMapResult('evt_dup', result);
        const second = storage.persistMapResult('evt_dup', result);

        expect(first).toEqual({ duplicate: false });
        expect(second).toEqual({ duplicate: true });

        // Entries written exactly once — no doubled journal or dispatch rows.
        expect(storage.entries.countImmediate()).toBe(1);
        expect(storage.entries.findByEventId('evt_dup')).toHaveLength(1);
        // 1 immediate dispatch row + 1 recognition row = 2, not 4.
        expect(storage.entries.countPendingScheduled()).toBe(2);
        expect(storage.dedup.has('evt_dup')).toBe(true);
      });
    });

    describe('persistVoidReversal', () => {
      function recognitionEntry(date: string, memo: string): JournalEntry {
        return {
          date,
          currency: 'USD',
          memo,
          sourceEventId: 'evt_fin_void',
          sourceEventType: 'invoice.finalized',
          sourceObjectId: 'in_void',
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(10000) },
            { accountCode: '4000', side: 'credit', amount: cents(10000) },
          ],
        };
      }

      it('cancels the unposted schedule, posts the reversal from posted rows, records dedup', () => {
        const storage = factory();
        const m1 = storage.entries.saveScheduled(recognitionEntry('2026-06-01', 'm1'), {
          subscriptionId: 'sub_void',
          sourceEventId: 'evt_fin_void',
        });
        const m2 = storage.entries.saveScheduled(recognitionEntry('2026-07-01', 'm2'), {
          subscriptionId: 'sub_void',
          sourceEventId: 'evt_fin_void',
        });
        const m3 = storage.entries.saveScheduled(recognitionEntry('2026-08-01', 'm3'), {
          subscriptionId: 'sub_void',
          sourceEventId: 'evt_fin_void',
        });
        // A different invoice/subscription — must be left untouched.
        const other = storage.entries.saveScheduled(makeEntry({ date: '2026-06-01' }), {
          subscriptionId: 'sub_other',
          sourceEventId: 'evt_other',
        });
        // One month already recognized before the void arrives.
        storage.entries.markScheduledPosted(m1.id);

        let receivedPosted: ReadonlyArray<JournalEntry> = [];
        const reversalEntry: JournalEntry = {
          date: '2026-08-15',
          currency: 'USD',
          memo: 'void reversal',
          sourceEventId: 'evt_void',
          sourceEventType: 'invoice.voided',
          sourceObjectId: 'in_void',
          lines: [
            { accountCode: '1100', side: 'credit', amount: cents(30000) },
            { accountCode: '4000', side: 'debit', amount: cents(10000) },
            { accountCode: '2100', side: 'debit', amount: cents(20000) },
          ],
        };

        const result = storage.persistVoidReversal('evt_void', {
          subscriptionId: 'sub_void',
          invoiceId: 'in_void',
          buildReversal(posted) {
            receivedPosted = posted;
            return reversalEntry;
          },
        });

        expect(result).toEqual({ duplicate: false });
        // buildReversal saw exactly the one posted month, isolated to this invoice.
        expect(receivedPosted.map((e) => e.memo)).toEqual(['m1']);
        // Unposted months cancelled; the posted one stays; other invoice untouched.
        expect(storage.entries.getScheduledById(m2.id)?.status).toBe('cancelled');
        expect(storage.entries.getScheduledById(m3.id)?.status).toBe('cancelled');
        expect(storage.entries.getScheduledById(m1.id)?.status).toBe('posted');
        expect(storage.entries.getScheduledById(other.id)?.status).toBe('pending');
        // Reversal persisted as an immediate audit entry (+ its dispatch row).
        const found = storage.entries.findByEventId('evt_void');
        expect(found).toHaveLength(1);
        expect(found[0]?.entry.memo).toBe('void reversal');
        expect(storage.dedup.has('evt_void')).toBe(true);
      });

      it('is idempotent — a duplicate void delivery writes nothing more', () => {
        const storage = factory();
        const m1 = storage.entries.saveScheduled(recognitionEntry('2026-06-01', 'm1'), {
          subscriptionId: 'sub_void',
          sourceEventId: 'evt_fin_void',
        });
        const reversalEntry: JournalEntry = {
          date: '2026-08-15',
          currency: 'USD',
          memo: 'void reversal',
          sourceEventId: 'evt_void_dup',
          sourceEventType: 'invoice.voided',
          sourceObjectId: 'in_void',
          lines: [
            { accountCode: '1100', side: 'credit', amount: cents(10000) },
            { accountCode: '2100', side: 'debit', amount: cents(10000) },
          ],
        };
        const input = {
          subscriptionId: 'sub_void',
          invoiceId: 'in_void',
          buildReversal: (): JournalEntry => reversalEntry,
        };

        const first = storage.persistVoidReversal('evt_void_dup', input);
        const second = storage.persistVoidReversal('evt_void_dup', input);

        expect(first).toEqual({ duplicate: false });
        expect(second).toEqual({ duplicate: true });
        expect(storage.entries.findByEventId('evt_void_dup')).toHaveLength(1);
        expect(storage.entries.getScheduledById(m1.id)?.status).toBe('cancelled');
      });

      it('refuses to cancel a row while its outside send may still finish', () => {
        const storage = factory();
        const row = storage.entries.saveScheduled(recognitionEntry('2026-07-01', 'sending'), {
          subscriptionId: 'sub_void_sending',
          sourceEventId: 'evt_fin_void',
        });
        storage.entries.markScheduledAttemptStarted(row.id, 1, 1_000);

        expect(() =>
          storage.persistVoidReversal('evt_void_sending', {
            subscriptionId: 'sub_void_sending',
            invoiceId: 'in_void',
            buildReversal: () => makeEntry({ sourceEventId: 'evt_void_sending' }),
          }),
        ).toThrow(/already has dispatch attempts/);
        expect(storage.entries.getScheduledById(row.id)?.status).toBe('pending');
        expect(storage.dedup.has('evt_void_sending')).toBe(false);
        expect(storage.entries.findByEventId('evt_void_sending')).toHaveLength(0);
      });
    });

    describe('findImmediateBySourceObject', () => {
      it('returns immediate entries matching sourceObjectId across event ids', () => {
        const storage = factory();
        const drawDown: JournalEntry = {
          date: '2026-04-01',
          currency: 'USD',
          memo: 'draw-down',
          sourceEventId: 'evt_cn_create',
          sourceEventType: 'credit_note.created',
          sourceObjectId: 'cn_1',
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(100) },
            { accountCode: '1100', side: 'credit', amount: cents(100) },
          ],
        };
        storage.entries.saveImmediate(drawDown, 'evt_cn_create');
        storage.entries.saveImmediate({ ...drawDown, sourceObjectId: 'cn_2' }, 'evt_other');
        const found = storage.entries.findImmediateBySourceObject('cn_1');
        expect(found).toHaveLength(1);
        expect(found[0]?.entry.sourceObjectId).toBe('cn_1');
      });
    });

    describe('persistCreditReversal', () => {
      function recognitionEntry(date: string, memo: string): JournalEntry {
        return {
          date,
          currency: 'USD',
          memo,
          sourceEventId: 'evt_fin_credit',
          sourceEventType: 'invoice.finalized',
          sourceObjectId: 'in_credit',
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(10000) },
            { accountCode: '4000', side: 'credit', amount: cents(10000) },
          ],
        };
      }

      it('hands posted+pending to build, cancels pending, posts the reversal, enqueues the reduced schedule', () => {
        const storage = factory();
        const m1 = storage.entries.saveScheduled(recognitionEntry('2026-06-01', 'm1'), {
          subscriptionId: 'sub_credit',
          sourceEventId: 'evt_fin_credit',
        });
        const m2 = storage.entries.saveScheduled(recognitionEntry('2026-07-01', 'm2'), {
          subscriptionId: 'sub_credit',
          sourceEventId: 'evt_fin_credit',
        });
        storage.entries.markScheduledPosted(m1.id);

        let sawPosted: ReadonlyArray<JournalEntry> = [];
        let sawPending: ReadonlyArray<JournalEntry> = [];
        const reversal: JournalEntry = {
          date: '2026-07-15',
          currency: 'USD',
          memo: 'credit reversal',
          sourceEventId: 'evt_credit',
          sourceEventType: 'credit_note.created',
          sourceObjectId: 'cn_credit',
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(5000) },
            { accountCode: '1100', side: 'credit', amount: cents(5000) },
          ],
        };
        const reducedSchedule: RecognitionSchedule = {
          subscriptionId: 'sub_credit',
          sourceEventId: 'evt_credit',
          entries: [
            {
              date: '2026-07-01',
              currency: 'USD',
              memo: 'reissued m2',
              sourceEventId: 'evt_credit',
              sourceEventType: 'credit_note.created',
              sourceObjectId: 'in_credit',
              lines: [
                { accountCode: '2100', side: 'debit', amount: cents(5000) },
                { accountCode: '4000', side: 'credit', amount: cents(5000) },
              ],
            },
          ],
        };

        const result = storage.persistCreditReversal('evt_credit', {
          subscriptionId: 'sub_credit',
          invoiceId: 'in_credit',
          build(posted, pending) {
            sawPosted = posted;
            sawPending = pending;
            return { reversal, reducedSchedule };
          },
        });

        expect(result).toEqual({ duplicate: false });
        expect(sawPosted.map((e) => e.memo)).toEqual(['m1']);
        expect(sawPending.map((e) => e.memo)).toEqual(['m2']);
        // Old pending cancelled; the reversal is an immediate audit entry.
        expect(storage.entries.getScheduledById(m2.id)?.status).toBe('cancelled');
        expect(storage.entries.getScheduledById(m1.id)?.status).toBe('posted');
        expect(storage.entries.findByEventId('evt_credit')[0]?.entry.memo).toBe('credit reversal');
        // The reduced schedule was enqueued as a fresh pending row.
        const reissued = storage.entries
          .findScheduledBySubscription('sub_credit')
          .filter((r) => r.entry.memo === 'reissued m2');
        expect(reissued).toHaveLength(1);
        expect(reissued[0]?.status).toBe('pending');
        expect(storage.dedup.has('evt_credit')).toBe(true);
      });

      it('is idempotent — a duplicate credit delivery writes nothing more', () => {
        const storage = factory();
        const recognized = storage.entries.saveScheduled(recognitionEntry('2026-06-01', 'done'), {
          subscriptionId: 'sub_credit',
          sourceEventId: 'evt_fin_credit',
        });
        storage.entries.markScheduledPosted(recognized.id);
        const reversal: JournalEntry = {
          date: '2026-07-15',
          currency: 'USD',
          memo: 'credit reversal',
          sourceEventId: 'evt_credit_dup',
          sourceEventType: 'credit_note.created',
          sourceObjectId: 'cn_credit',
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(5000) },
            { accountCode: '1100', side: 'credit', amount: cents(5000) },
          ],
        };
        const input = {
          subscriptionId: 'sub_credit',
          invoiceId: 'in_credit',
          build: () => ({ reversal, reducedSchedule: null }),
        };
        expect(storage.persistCreditReversal('evt_credit_dup', input)).toEqual({
          duplicate: false,
        });
        expect(storage.persistCreditReversal('evt_credit_dup', input)).toEqual({ duplicate: true });
        expect(storage.entries.findByEventId('evt_credit_dup')).toHaveLength(1);
      });

      it('refuses a credit that arrives before its invoice schedule', () => {
        const storage = factory();
        expect(() =>
          storage.persistCreditReversal('evt_credit_before_invoice', {
            subscriptionId: 'sub_credit_late_invoice',
            invoiceId: 'in_credit_late_invoice',
            build: () => {
              throw new Error('must not guess without invoice rows');
            },
          }),
        ).toThrow(/no recognition rows exist yet/);
        expect(storage.dedup.has('evt_credit_before_invoice')).toBe(false);
        expect(storage.entries.findByEventId('evt_credit_before_invoice')).toHaveLength(0);
      });

      it('refuses to replace a row while its outside send may still finish', () => {
        const storage = factory();
        const row = storage.entries.saveScheduled(recognitionEntry('2026-07-01', 'sending'), {
          subscriptionId: 'sub_credit_sending',
          sourceEventId: 'evt_fin_credit',
        });
        storage.entries.markScheduledAttemptStarted(row.id, 1, 1_000);

        expect(() =>
          storage.persistCreditReversal('evt_credit_sending', {
            subscriptionId: 'sub_credit_sending',
            invoiceId: 'in_credit',
            build: () => ({
              reversal: makeEntry({ sourceEventId: 'evt_credit_sending' }),
              reducedSchedule: null,
            }),
          }),
        ).toThrow(/already has dispatch attempts/);
        expect(storage.entries.getScheduledById(row.id)?.status).toBe('pending');
        expect(storage.dedup.has('evt_credit_sending')).toBe(false);
        expect(storage.entries.findByEventId('evt_credit_sending')).toHaveLength(0);
      });
    });

    describe('persistRefundReversal', () => {
      function refundRecognitionEntry(date: string, memo: string): JournalEntry {
        return {
          date,
          currency: 'USD',
          memo,
          sourceEventId: 'evt_paid_refund',
          sourceEventType: 'invoice.payment_succeeded',
          sourceObjectId: 'in_refund',
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(10000) },
            { accountCode: '4000', side: 'credit', amount: cents(10000) },
          ],
        };
      }

      function refundEntry(memo: string, eventId: string): JournalEntry {
        return {
          date: '2026-07-15',
          currency: 'USD',
          memo,
          sourceEventId: eventId,
          sourceEventType: 'charge.refunded',
          sourceObjectId: `re_${memo}`,
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(5000) },
            { accountCode: '1010', side: 'credit', amount: cents(5000) },
          ],
        };
      }

      it('hands posted+pending to build, cancels unposted rows including held ones, and posts every reversal', () => {
        const storage = factory();
        const save = (date: string, memo: string): SavedScheduledEntry =>
          storage.entries.saveScheduled(refundRecognitionEntry(date, memo), {
            subscriptionId: 'sub_refund',
            sourceEventId: 'evt_paid_refund',
          });
        const m1 = save('2026-06-01', 'm1');
        const m2 = save('2026-07-01', 'm2');
        const m3 = save('2026-08-01', 'm3');
        storage.entries.markScheduledPosted(m1.id);
        storage.entries.holdScheduled(m3.id);

        let sawPosted: ReadonlyArray<JournalEntry> = [];
        let sawPending: ReadonlyArray<JournalEntry> = [];
        const reducedSchedule: RecognitionSchedule = {
          subscriptionId: 'sub_refund',
          sourceEventId: 'evt_refund',
          entries: [refundRecognitionEntry('2026-07-01', 'reissued m2')],
        };

        const result = storage.persistRefundReversal('evt_refund', {
          subscriptionId: 'sub_refund',
          invoiceId: 'in_refund',
          build(posted, pending) {
            sawPosted = posted;
            sawPending = pending;
            return {
              reversals: [refundEntry('first', 'evt_refund'), refundEntry('second', 'evt_refund')],
              reducedSchedule,
            };
          },
        });

        expect(result).toEqual({ duplicate: false });
        expect(sawPosted.map((e) => e.memo)).toEqual(['m1']);
        // A held row is still unrecognized deferred revenue, so the refund sees it.
        expect(sawPending.map((e) => e.memo)).toEqual(['m2', 'm3']);
        expect(storage.entries.getScheduledById(m1.id)?.status).toBe('posted');
        expect(storage.entries.getScheduledById(m2.id)?.status).toBe('cancelled');
        expect(storage.entries.getScheduledById(m3.id)?.status).toBe('cancelled');
        // Both refund entries are audited and both are queued for dispatch.
        expect(storage.entries.findByEventId('evt_refund').map((r) => r.entry.memo)).toEqual([
          'first',
          'second',
        ]);
        expect(
          storage.entries
            .findScheduledBySubscription('immediate:evt_refund')
            .map((r) => r.entry.memo),
        ).toEqual(['first', 'second']);
        const reissued = storage.entries
          .findScheduledBySubscription('sub_refund')
          .filter((r) => r.entry.memo === 'reissued m2');
        expect(reissued).toHaveLength(1);
        expect(reissued[0]?.status).toBe('pending');
        expect(storage.dedup.has('evt_refund')).toBe(true);
      });

      it('books a refund for an invoice with no recognition rows instead of refusing', () => {
        const storage = factory();
        let sawPosted: ReadonlyArray<JournalEntry> | null = null;
        let sawPending: ReadonlyArray<JournalEntry> | null = null;

        const result = storage.persistRefundReversal('evt_refund_no_rows', {
          subscriptionId: 'sub_refund_unknown',
          invoiceId: 'in_refund_unknown',
          build(posted, pending) {
            sawPosted = posted;
            sawPending = pending;
            return {
              reversals: [refundEntry('engine fallback', 'evt_refund_no_rows')],
              reducedSchedule: null,
            };
          },
        });

        expect(result).toEqual({ duplicate: false });
        expect(sawPosted).toEqual([]);
        expect(sawPending).toEqual([]);
        expect(storage.entries.findByEventId('evt_refund_no_rows')).toHaveLength(1);
        expect(storage.dedup.has('evt_refund_no_rows')).toBe(true);
      });

      it('is idempotent — a duplicate refund delivery writes nothing more', () => {
        const storage = factory();
        const input = {
          subscriptionId: 'sub_refund_dup',
          invoiceId: 'in_refund_dup',
          build: () => ({
            reversals: [refundEntry('dup', 'evt_refund_dup')],
            reducedSchedule: null,
          }),
        };
        expect(storage.persistRefundReversal('evt_refund_dup', input)).toEqual({
          duplicate: false,
        });
        expect(storage.persistRefundReversal('evt_refund_dup', input)).toEqual({ duplicate: true });
        expect(storage.entries.findByEventId('evt_refund_dup')).toHaveLength(1);
      });

      it('refuses to replace a row while its outside send may still finish', () => {
        const storage = factory();
        const row = storage.entries.saveScheduled(refundRecognitionEntry('2026-07-01', 'sending'), {
          subscriptionId: 'sub_refund_sending',
          sourceEventId: 'evt_paid_refund',
        });
        storage.entries.markScheduledAttemptStarted(row.id, 1, 1_000);

        expect(() =>
          storage.persistRefundReversal('evt_refund_sending', {
            subscriptionId: 'sub_refund_sending',
            invoiceId: 'in_refund',
            build: () => ({
              reversals: [refundEntry('sending', 'evt_refund_sending')],
              reducedSchedule: null,
            }),
          }),
        ).toThrow(/already has dispatch attempts/);
        expect(storage.entries.getScheduledById(row.id)?.status).toBe('pending');
        expect(storage.dedup.has('evt_refund_sending')).toBe(false);
        expect(storage.entries.findByEventId('evt_refund_sending')).toHaveLength(0);
      });
    });

    describe('persistCreditVoidReversal', () => {
      it('inverts the draw-down, re-inflates the schedule, records dedup', () => {
        const storage = factory();
        // The draw-down's immediate entry (keyed by credit-note id) and one
        // current pending (reduced) recognition row.
        storage.entries.saveImmediate(
          {
            date: '2026-04-01',
            currency: 'USD',
            memo: 'draw-down',
            sourceEventId: 'evt_credit',
            sourceEventType: 'credit_note.created',
            sourceObjectId: 'cn_void',
            lines: [
              { accountCode: '2100', side: 'debit', amount: cents(5000) },
              { accountCode: '1100', side: 'credit', amount: cents(5000) },
            ],
          },
          'evt_credit',
        );
        const p = storage.entries.saveScheduled(
          {
            date: '2026-07-01',
            currency: 'USD',
            memo: 'reduced m2',
            sourceEventId: 'evt_credit',
            sourceEventType: 'credit_note.created',
            sourceObjectId: 'in_void',
            lines: [
              { accountCode: '2100', side: 'debit', amount: cents(5000) },
              { accountCode: '4000', side: 'credit', amount: cents(5000) },
            ],
          },
          { subscriptionId: 'sub_void', sourceEventId: 'evt_credit' },
        );

        let sawDrawDown: ReadonlyArray<JournalEntry> = [];
        const reversal: JournalEntry = {
          date: '2026-08-01',
          currency: 'USD',
          memo: 'credit void reversal',
          sourceEventId: 'evt_void',
          sourceEventType: 'credit_note.voided',
          sourceObjectId: 'cn_void',
          lines: [
            { accountCode: '1100', side: 'debit', amount: cents(5000) },
            { accountCode: '2100', side: 'credit', amount: cents(5000) },
          ],
        };
        const result = storage.persistCreditVoidReversal('evt_void', {
          subscriptionId: 'sub_void',
          invoiceId: 'in_void',
          creditNoteId: 'cn_void',
          build(drawDown) {
            sawDrawDown = drawDown;
            return { reversal, reissuedSchedule: null };
          },
        });

        expect(result).toEqual({ duplicate: false });
        expect(sawDrawDown.map((e) => e.memo)).toEqual(['draw-down']);
        expect(storage.entries.getScheduledById(p.id)?.status).toBe('cancelled');
        expect(storage.entries.findByEventId('evt_void')[0]?.entry.memo).toBe(
          'credit void reversal',
        );
        expect(storage.dedup.has('evt_void')).toBe(true);
      });

      it('no-ops (records dedup, leaves the schedule untouched) when build returns null', () => {
        const storage = factory();
        const p = storage.entries.saveScheduled(
          {
            date: '2026-07-01',
            currency: 'USD',
            memo: 'untouched',
            sourceEventId: 'evt_fin',
            sourceEventType: 'invoice.finalized',
            sourceObjectId: 'in_void',
            lines: [
              { accountCode: '2100', side: 'debit', amount: cents(5000) },
              { accountCode: '4000', side: 'credit', amount: cents(5000) },
            ],
          },
          { subscriptionId: 'sub_void', sourceEventId: 'evt_fin' },
        );
        const result = storage.persistCreditVoidReversal('evt_void_noop', {
          subscriptionId: 'sub_void',
          invoiceId: 'in_void',
          creditNoteId: 'cn_absent',
          build: (drawDown) =>
            drawDown.length === 0 ? null : { reversal: makeEntry(), reissuedSchedule: null },
        });
        expect(result).toEqual({ duplicate: false });
        // No draw-down existed, so the schedule is left pending and nothing posts.
        expect(storage.entries.getScheduledById(p.id)?.status).toBe('pending');
        expect(storage.entries.findByEventId('evt_void_noop')).toHaveLength(0);
        expect(storage.dedup.has('evt_void_noop')).toBe(true);
      });

      it('refuses to rebuild a row while its outside send may still finish', () => {
        const storage = factory();
        storage.entries.saveImmediate(
          {
            date: '2026-04-01',
            currency: 'USD',
            memo: 'draw-down',
            sourceEventId: 'evt_credit_sending',
            sourceEventType: 'credit_note.created',
            sourceObjectId: 'cn_sending',
            lines: [
              { accountCode: '2100', side: 'debit', amount: cents(5000) },
              { accountCode: '1100', side: 'credit', amount: cents(5000) },
            ],
          },
          'evt_credit_sending',
        );
        const row = storage.entries.saveScheduled(
          {
            date: '2026-07-01',
            currency: 'USD',
            memo: 'sending',
            sourceEventId: 'evt_credit_sending',
            sourceEventType: 'credit_note.created',
            sourceObjectId: 'in_void_sending',
            lines: [
              { accountCode: '2100', side: 'debit', amount: cents(5000) },
              { accountCode: '4000', side: 'credit', amount: cents(5000) },
            ],
          },
          { subscriptionId: 'sub_void_sending', sourceEventId: 'evt_credit_sending' },
        );
        storage.entries.markScheduledAttemptStarted(row.id, 1, 1_000);

        expect(() =>
          storage.persistCreditVoidReversal('evt_credit_void_sending', {
            subscriptionId: 'sub_void_sending',
            invoiceId: 'in_void_sending',
            creditNoteId: 'cn_sending',
            build: () => ({
              reversal: makeEntry({ sourceEventId: 'evt_credit_void_sending' }),
              reissuedSchedule: null,
            }),
          }),
        ).toThrow(/already has dispatch attempts/);
        expect(storage.entries.getScheduledById(row.id)?.status).toBe('pending');
        expect(storage.dedup.has('evt_credit_void_sending')).toBe(false);
        expect(storage.entries.findByEventId('evt_credit_void_sending')).toHaveLength(0);
      });
    });

    describe('persistSubscriptionChange', () => {
      function recognitionEntry(date: string, memo: string, eventId: string): JournalEntry {
        return makeEntry({
          date,
          memo,
          sourceEventId: eventId,
          sourceEventType: 'invoice.payment_succeeded',
          sourceObjectId: `in_${eventId}`,
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(10000) },
            { accountCode: '4000', side: 'credit', amount: cents(10000) },
          ],
        });
      }

      it('cancels old future rows and atomically saves the paid change plus rebuilt schedule', () => {
        const storage = factory();
        const old = storage.entries.saveScheduled(
          recognitionEntry('2026-07-01', 'old future', 'evt_old'),
          { subscriptionId: 'sub_change', sourceEventId: 'evt_old' },
        );
        const nextTerm = storage.entries.saveScheduled(
          recognitionEntry('2027-01-01', 'next renewal', 'evt_next'),
          { subscriptionId: 'sub_change', sourceEventId: 'evt_next' },
        );
        const immediate = makeEntry({
          memo: 'upgrade cash',
          sourceEventId: 'evt_change',
          sourceEventType: 'invoice.payment_succeeded',
          sourceObjectId: 'in_change',
        });
        const rebuilt: RecognitionSchedule = {
          subscriptionId: 'sub_change',
          sourceEventId: 'evt_change',
          entries: [recognitionEntry('2026-07-01', 'rebuilt future', 'evt_change')],
        };

        let sawPending: ReadonlyArray<JournalEntry> = [];
        const input = {
          subscriptionId: 'sub_change',
          throughDate: '2026-12-31',
          immediateEntries: [immediate],
          build(pending: ReadonlyArray<JournalEntry>) {
            sawPending = pending;
            return { cancelExisting: true, schedule: rebuilt };
          },
        };

        expect(storage.persistSubscriptionChange('evt_change', input)).toEqual({
          duplicate: false,
        });
        expect(sawPending.map((entry) => entry.memo)).toEqual(['old future']);
        expect(storage.entries.getScheduledById(old.id)?.status).toBe('cancelled');
        expect(storage.entries.getScheduledById(nextTerm.id)?.status).toBe('pending');
        expect(storage.entries.findByEventId('evt_change').map((row) => row.entry.memo)).toEqual([
          'upgrade cash',
        ]);
        expect(
          storage.entries
            .findScheduledBySubscription('sub_change')
            .filter((row) => row.status === 'pending')
            .map((row) => row.entry.memo),
        ).toEqual(['next renewal', 'rebuilt future']);
        expect(storage.dedup.has('evt_change')).toBe(true);

        // Duplicate Stripe delivery cannot cancel or write a second copy.
        expect(storage.persistSubscriptionChange('evt_change', input)).toEqual({ duplicate: true });
        expect(storage.entries.findByEventId('evt_change')).toHaveLength(1);
      });

      it('keeps the old schedule when the builder chooses the safe separate-schedule fallback', () => {
        const storage = factory();
        const old = storage.entries.saveScheduled(
          recognitionEntry('2026-07-01', 'old FX future', 'evt_old_fx'),
          { subscriptionId: 'sub_change_fx', sourceEventId: 'evt_old_fx' },
        );
        const delta: RecognitionSchedule = {
          subscriptionId: 'sub_change_fx',
          sourceEventId: 'evt_change_fx',
          entries: [recognitionEntry('2026-07-15', 'separate FX delta', 'evt_change_fx')],
        };
        storage.persistSubscriptionChange('evt_change_fx', {
          subscriptionId: 'sub_change_fx',
          throughDate: '2026-12-31',
          immediateEntries: [],
          build: () => ({ cancelExisting: false, schedule: delta }),
        });
        expect(storage.entries.getScheduledById(old.id)?.status).toBe('pending');
        expect(
          storage.entries
            .findScheduledBySubscription('sub_change_fx')
            .filter((row) => row.status === 'pending'),
        ).toHaveLength(2);
      });

      it('changes nothing and leaves the event retryable when the builder throws', () => {
        const storage = factory();
        const old = storage.entries.saveScheduled(
          recognitionEntry('2026-07-01', 'must survive', 'evt_old_fail'),
          { subscriptionId: 'sub_change_fail', sourceEventId: 'evt_old_fail' },
        );
        expect(() =>
          storage.persistSubscriptionChange('evt_change_fail', {
            subscriptionId: 'sub_change_fail',
            throughDate: '2026-12-31',
            immediateEntries: [makeEntry({ sourceEventId: 'evt_change_fail' })],
            build: () => {
              throw new Error('refuse unsafe rebuild');
            },
          }),
        ).toThrow(/unsafe rebuild/);
        expect(storage.entries.getScheduledById(old.id)?.status).toBe('pending');
        expect(storage.entries.findByEventId('evt_change_fail')).toHaveLength(0);
        expect(storage.dedup.has('evt_change_fail')).toBe(false);
      });

      it('refuses to replace a row that already has a dispatch attempt', () => {
        const storage = factory();
        const old = storage.entries.saveScheduled(
          recognitionEntry('2026-07-01', 'possibly sent', 'evt_old_attempted'),
          { subscriptionId: 'sub_change_attempted', sourceEventId: 'evt_old_attempted' },
        );
        storage.entries.recordScheduledAttempt(old.id, 1, 1000, 2000, 'reply was lost', 'pending');
        expect(() =>
          storage.persistSubscriptionChange('evt_change_attempted', {
            subscriptionId: 'sub_change_attempted',
            throughDate: '2026-12-31',
            immediateEntries: [],
            build: () => ({
              cancelExisting: true,
              schedule: {
                subscriptionId: 'sub_change_attempted',
                sourceEventId: 'evt_change_attempted',
                entries: [],
              },
            }),
          }),
        ).toThrow(/already has dispatch attempts/);
        expect(storage.entries.getScheduledById(old.id)?.status).toBe('pending');
        expect(storage.dedup.has('evt_change_attempted')).toBe(false);
      });
    });

    describe('persistSubscriptionCancellation', () => {
      function recognitionEntry(date: string, memo: string): JournalEntry {
        return makeEntry({
          date,
          memo,
          sourceEventId: 'evt_cancel_source',
          sourceEventType: 'invoice.payment_succeeded',
          sourceObjectId: 'in_cancel_source',
          lines: [
            { accountCode: '2100', side: 'debit', amount: cents(10000) },
            { accountCode: '4000', side: 'credit', amount: cents(10000) },
          ],
        });
      }

      it('keeps rows through the end date and atomically holds only later rows', () => {
        const storage = factory();
        const kept = storage.entries.saveScheduled(
          recognitionEntry('2026-07-15', 'service through end'),
          { subscriptionId: 'sub_cancel', sourceEventId: 'evt_cancel_source' },
        );
        const stopped = storage.entries.saveScheduled(
          recognitionEntry('2026-08-15', 'service after end'),
          { subscriptionId: 'sub_cancel', sourceEventId: 'evt_cancel_source' },
        );
        const sibling = storage.entries.saveScheduled(
          recognitionEntry('2026-08-15', 'different subscription'),
          { subscriptionId: 'sub_other', sourceEventId: 'evt_other' },
        );

        const input = {
          subscriptionId: 'sub_cancel',
          effectiveEndDate: '2026-07-15',
        };
        expect(storage.persistSubscriptionCancellation('evt_cancel', input)).toEqual({
          duplicate: false,
        });
        expect(storage.entries.getScheduledById(kept.id)?.status).toBe('pending');
        expect(storage.entries.getScheduledById(stopped.id)?.status).toBe('held');
        expect(storage.entries.getScheduledById(sibling.id)?.status).toBe('pending');
        expect(storage.dedup.has('evt_cancel')).toBe(true);

        expect(storage.persistSubscriptionCancellation('evt_cancel', input)).toEqual({
          duplicate: true,
        });
        expect(storage.entries.getScheduledById(stopped.id)?.status).toBe('held');
      });

      it('holds a later schedule even when Stripe sends the end before the invoice', () => {
        const storage = factory();
        storage.persistSubscriptionCancellation('evt_cancel_first', {
          subscriptionId: 'sub_cancel_first',
          effectiveEndDate: '2026-07-15',
        });

        const result: MapResult = {
          entries: [],
          schedule: {
            subscriptionId: 'sub_cancel_first',
            sourceEventId: 'evt_invoice_late',
            entries: [
              recognitionEntry('2026-07-15', 'service through end'),
              recognitionEntry('2026-08-15', 'late future month'),
            ],
          },
        };
        storage.persistMapResult('evt_invoice_late', result);

        const rows = storage.entries.findScheduledBySubscription('sub_cancel_first');
        expect(rows.map((row) => [row.entry.memo, row.status])).toEqual([
          ['service through end', 'pending'],
          ['late future month', 'held'],
        ]);
        expect(storage.entries.findPendingScheduled('2026-12-31')).toHaveLength(1);
      });

      it('treats held months as deferred when a later credit rebuilds the schedule', () => {
        const storage = factory();
        const held = storage.entries.saveScheduled(
          recognitionEntry('2026-08-15', 'still deferred'),
          { subscriptionId: 'sub_cancel_credit', sourceEventId: 'evt_source' },
        );
        storage.persistSubscriptionCancellation('evt_cancel_credit', {
          subscriptionId: 'sub_cancel_credit',
          effectiveEndDate: '2026-07-15',
        });

        let sawDeferred: ReadonlyArray<JournalEntry> = [];
        storage.persistCreditReversal('evt_credit_after_cancel', {
          subscriptionId: 'sub_cancel_credit',
          invoiceId: 'in_cancel_source',
          build(_posted, pending) {
            sawDeferred = pending;
            return {
              reversal: makeEntry({
                sourceEventId: 'evt_credit_after_cancel',
                sourceEventType: 'credit_note.created',
                sourceObjectId: 'cn_after_cancel',
              }),
              reducedSchedule: {
                subscriptionId: 'sub_cancel_credit',
                sourceEventId: 'evt_credit_after_cancel',
                entries: [recognitionEntry('2026-08-15', 'reduced but still held')],
              },
            };
          },
        });

        expect(sawDeferred.map((entry) => entry.memo)).toEqual(['still deferred']);
        expect(storage.entries.getScheduledById(held.id)?.status).toBe('cancelled');
        const rebuilt = storage.entries
          .findScheduledBySubscription('sub_cancel_credit')
          .find((row) => row.entry.memo === 'reduced but still held');
        expect(rebuilt?.status).toBe('held');
        expect(() => storage.entries.requeueScheduled(rebuilt?.id ?? -1)).toThrow(/held/);
      });

      it('refuses an after-end row with a dispatch attempt and leaves the event retryable', () => {
        const storage = factory();
        const attempted = storage.entries.saveScheduled(
          recognitionEntry('2026-08-15', 'possibly sent'),
          { subscriptionId: 'sub_cancel_attempted', sourceEventId: 'evt_source' },
        );
        storage.entries.recordScheduledAttempt(
          attempted.id,
          1,
          1000,
          2000,
          'reply was lost',
          'pending',
        );

        expect(() =>
          storage.persistSubscriptionCancellation('evt_cancel_attempted', {
            subscriptionId: 'sub_cancel_attempted',
            effectiveEndDate: '2026-07-15',
          }),
        ).toThrow(/already has dispatch attempts/);
        expect(storage.entries.getScheduledById(attempted.id)?.status).toBe('pending');
        expect(storage.dedup.has('evt_cancel_attempted')).toBe(false);
      });

      it('refuses an already-posted after-end row and leaves the event retryable', () => {
        const storage = factory();
        const posted = storage.entries.saveScheduled(
          recognitionEntry('2026-08-15', 'already sent'),
          { subscriptionId: 'sub_cancel_posted', sourceEventId: 'evt_source' },
        );
        storage.entries.markScheduledPosted(posted.id);

        expect(() =>
          storage.persistSubscriptionCancellation('evt_cancel_posted', {
            subscriptionId: 'sub_cancel_posted',
            effectiveEndDate: '2026-07-15',
          }),
        ).toThrow(/already posted/);
        expect(storage.entries.getScheduledById(posted.id)?.status).toBe('posted');
        expect(storage.dedup.has('evt_cancel_posted')).toBe(false);
      });

      it('refuses a different end date and keeps the first end rule', () => {
        const storage = factory();
        storage.persistSubscriptionCancellation('evt_cancel_first_end', {
          subscriptionId: 'sub_cancel_conflict',
          effectiveEndDate: '2026-07-15',
        });

        expect(() =>
          storage.persistSubscriptionCancellation('evt_cancel_conflict', {
            subscriptionId: 'sub_cancel_conflict',
            effectiveEndDate: '2026-08-15',
          }),
        ).toThrow(/conflicting end date/);
        expect(storage.dedup.has('evt_cancel_conflict')).toBe(false);

        storage.persistMapResult('evt_after_conflict', {
          entries: [],
          schedule: {
            subscriptionId: 'sub_cancel_conflict',
            sourceEventId: 'evt_after_conflict',
            entries: [recognitionEntry('2026-08-01', 'must follow first end')],
          },
        });
        expect(storage.entries.findScheduledBySubscription('sub_cancel_conflict')[0]?.status).toBe(
          'held',
        );
      });
    });

    describe('ping', () => {
      it('does not throw on a fresh storage', () => {
        const storage = factory();
        expect(() => {
          storage.ping();
        }).not.toThrow();
      });

      it('still does not throw after writes', () => {
        const storage = factory();
        storage.persistMapResult('evt_p', {
          entries: [makeEntry()],
          schedule: null,
        });
        expect(() => {
          storage.ping();
        }).not.toThrow();
      });
    });
  });
}
