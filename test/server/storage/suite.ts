import { describe, it, expect } from 'vitest';
import { cents } from '../../../src/money.js';
import type { JournalEntry, MapResult } from '../../../src/journal.js';
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
    });

    describe('persistMapResult', () => {
      it('persists immediate entries, schedule entries, and records dedup atomically', () => {
        const storage = factory();
        const immediate = makeEntry({ memo: 'immediate' });
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
        expect(storage.entries.countPendingScheduled()).toBe(2);

        const found = storage.entries.findByEventId('evt_annual');
        expect(found).toHaveLength(1);
        expect(found[0]?.entry.memo).toBe('immediate');

        const due = storage.entries.findPendingScheduled('2026-12-31');
        expect(due).toHaveLength(2);
        expect(due.map((row) => row.entry.memo).sort()).toEqual(['month1', 'month2']);
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
        expect(storage.entries.countPendingScheduled()).toBe(0);
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
