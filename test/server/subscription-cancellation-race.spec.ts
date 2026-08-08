import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { cents } from '../../src/money.js';
import { createScheduler } from '../../src/server/scheduler.js';
import { silentLogger } from '../../src/server/logger.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';
import { applyMigrations } from '../../src/server/storage/migrations.js';
import { sqliteStorage } from '../../src/server/storage/sqlite.js';
import type { Storage } from '../../src/server/storage/types.js';

const factories: ReadonlyArray<[string, () => Storage]> = [
  ['in-memory', () => inMemoryStorage()],
  [
    'SQLite',
    () => {
      const db = new Database(':memory:');
      applyMigrations(db);
      return sqliteStorage(db);
    },
  ],
];

describe.each(factories)('%s cancellation and dispatch safety', (_name, factory) => {
  it('refuses cancellation while a post-end row is being sent', async () => {
    const storage = factory();
    const due = storage.entries.saveScheduled(
      {
        date: '2026-08-15',
        currency: 'USD',
        memo: 'recognition being sent',
        sourceEventId: 'evt_invoice',
        sourceEventType: 'invoice.payment_succeeded',
        sourceObjectId: 'in_invoice',
        lines: [
          { accountCode: '2100', side: 'debit', amount: cents(10000) },
          { accountCode: '4000', side: 'credit', amount: cents(10000) },
        ],
      },
      { subscriptionId: 'sub_race', sourceEventId: 'evt_invoice' },
    );

    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      announceStarted = resolve;
    });
    let finishDispatch!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishDispatch = resolve;
    });
    const externalPosts: number[] = [];
    const scheduler = createScheduler({
      storage,
      today: () => '2026-08-15',
      now: () => Date.parse('2026-08-15T12:00:00Z'),
      log: silentLogger(),
      async dispatcher(row) {
        announceStarted();
        await finish;
        externalPosts.push(row.id);
      },
    });

    const tick = scheduler.tick().then(
      (result) => ({ result, error: null }),
      (error: unknown) => ({ result: null, error }),
    );
    await started;

    let cancellationError: unknown = null;
    try {
      storage.persistSubscriptionCancellation('evt_cancel_race', {
        subscriptionId: 'sub_race',
        effectiveEndDate: '2026-07-15',
      });
    } catch (error) {
      cancellationError = error;
    } finally {
      finishDispatch();
    }

    const outcome = await tick;
    expect(cancellationError).toBeInstanceOf(Error);
    expect((cancellationError as Error).message).toMatch(/dispatch attempts/);
    expect(outcome.error).toBeNull();
    expect(outcome.result).toEqual({ attempted: 1, posted: 1, failed: 0, deadLettered: 0 });
    expect(externalPosts).toEqual([due.id]);
    expect(storage.entries.getScheduledById(due.id)?.status).toBe('posted');
    expect(storage.dedup.has('evt_cancel_race')).toBe(false);
  });
});
