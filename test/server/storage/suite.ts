import { describe, it, expect } from 'vitest';
import { cents } from '../../../src/money.js';
import type { JournalEntry, MapResult } from '../../../src/journal.js';
import type { ConnectedTokens } from '../../../src/server/oauth/types.js';
import type { Storage } from '../../../src/server/storage/types.js';

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

      it('recordScheduledAttempt can transition to failed (dead-letter)', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_dl',
          sourceEventId: 'evt_dl',
        });
        storage.entries.recordScheduledAttempt(
          saved.id,
          10,
          5_000_000,
          null,
          'gave up',
          'failed',
        );
        // 'failed' rows are excluded from findPendingScheduled at any time.
        expect(
          storage.entries.findPendingScheduled('2026-05-16', 9_999_999_999),
        ).toEqual([]);
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
        storage.entries.recordScheduledAttempt(
          saved.id,
          1,
          1000,
          2000,
          'transient',
          'pending',
        );

        // At t=1500 (before backoff expires) the entry is NOT due.
        expect(storage.entries.findPendingScheduled('2026-05-16', 1500)).toEqual([]);
        // At t=2000 (exactly) the entry IS due.
        expect(
          storage.entries.findPendingScheduled('2026-05-16', 2000).map((r) => r.id),
        ).toEqual([saved.id]);
        // At t=2500 (past backoff) the entry IS due.
        expect(
          storage.entries.findPendingScheduled('2026-05-16', 2500).map((r) => r.id),
        ).toEqual([saved.id]);
      });

      it('findPendingScheduled includes entries with next_attempt_at = NULL (fresh)', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_fresh',
          sourceEventId: 'evt_fresh',
        });
        // A fresh entry has next_attempt_at = null → always ready.
        expect(
          storage.entries.findPendingScheduled('2026-05-16', 0).map((r) => r.id),
        ).toEqual([saved.id]);
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
        expect(
          storage.entries
            .findPendingScheduled('2026-12-31')
            .map((r) => r.id),
        ).toContain(saved.id);
      });

      it('requeueScheduled is idempotent on an already-pending row', () => {
        const storage = factory();
        const saved = storage.entries.saveScheduled(makeEntry({ date: '2026-05-01' }), {
          subscriptionId: 'sub_idem',
          sourceEventId: 'evt_idem',
        });
        const first = storage.entries.requeueScheduled(saved.id);
        const second = storage.entries.requeueScheduled(saved.id);
        expect(first.status).toBe('pending');
        expect(second.status).toBe('pending');
        expect(second.attempts).toBe(0);
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
        expect(due.map((row) => row.entry.memo).sort()).toEqual([
          'immediate',
          'month1',
          'month2',
        ]);

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
    });
  });
}
