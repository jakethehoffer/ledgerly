import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cents } from '../../src/money.js';
import type { JournalEntry } from '../../src/journal.js';
import { createScheduler, defaultBackoffMs } from '../../src/server/scheduler.js';
import type { Dispatcher } from '../../src/server/scheduler.js';
import { consoleDispatcher } from '../../src/server/dispatchers/console.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';
import type { Storage } from '../../src/server/storage/types.js';
import type { SavedScheduledEntry } from '../../src/server/storage/types.js';

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    date: '2026-05-16',
    currency: 'USD',
    memo: 'monthly recognition',
    sourceEventId: 'evt_test_1',
    sourceEventType: 'invoice.payment_succeeded',
    sourceObjectId: 'in_test_1',
    lines: [
      { accountCode: '2100', side: 'debit', amount: cents(1000) },
      { accountCode: '4000', side: 'credit', amount: cents(1000) },
    ],
    ...overrides,
  };
}

function seedScheduled(
  storage: Storage,
  date: string,
  subscriptionId = 'sub_test',
  eventId = 'evt_test',
): SavedScheduledEntry {
  return storage.entries.saveScheduled(makeEntry({ date }), {
    subscriptionId,
    sourceEventId: eventId,
  });
}

describe('createScheduler', () => {
  describe('default state', () => {
    it('is not running until start() is called', () => {
      const storage = inMemoryStorage();
      const scheduler = createScheduler({
        storage,
        dispatcher: vi.fn(),
      });
      expect(scheduler.isRunning()).toBe(false);
    });

    it('tick() works without start()', async () => {
      const storage = inMemoryStorage();
      const dispatcher = vi.fn();
      const scheduler = createScheduler({ storage, dispatcher });
      const result = await scheduler.tick();
      expect(result).toEqual({ attempted: 0, posted: 0, failed: 0, deadLettered: 0 });
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('no pending entries', () => {
    it('tick returns zero counters on an empty store', async () => {
      const storage = inMemoryStorage();
      const dispatcher = vi.fn();
      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
      });
      const result = await scheduler.tick();
      expect(result).toEqual({ attempted: 0, posted: 0, failed: 0, deadLettered: 0 });
      expect(dispatcher).not.toHaveBeenCalled();
    });
  });

  describe('dispatches due entries', () => {
    it('dispatches every due entry, marks them posted, and they disappear from findPendingScheduled', async () => {
      const storage = inMemoryStorage();
      const a = seedScheduled(storage, '2026-05-01', 'sub_a', 'evt_a');
      const b = seedScheduled(storage, '2026-05-10', 'sub_b', 'evt_b');
      const c = seedScheduled(storage, '2026-05-16', 'sub_c', 'evt_c');

      const dispatched: number[] = [];
      const dispatcher: Dispatcher = (entry) => {
        dispatched.push(entry.id);
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
      });

      const result = await scheduler.tick();

      expect(result).toEqual({ attempted: 3, posted: 3, failed: 0, deadLettered: 0 });
      expect(dispatched).toEqual([a.id, b.id, c.id]);
      expect(storage.entries.findPendingScheduled('2026-05-16')).toEqual([]);
      expect(storage.entries.countPendingScheduled()).toBe(0);
    });

    it('supports an async dispatcher', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-16', 'sub_async', 'evt_async');

      let dispatched = false;
      const dispatcher: Dispatcher = async (_entry) => {
        await Promise.resolve();
        dispatched = true;
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
      });

      const result = await scheduler.tick();

      expect(dispatched).toBe(true);
      expect(result).toEqual({ attempted: 1, posted: 1, failed: 0, deadLettered: 0 });
    });
  });

  describe('skips not-yet-due entries', () => {
    it('leaves future-dated entries pending', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-06-01', 'sub_future_1', 'evt_future_1');
      seedScheduled(storage, '2026-12-31', 'sub_future_2', 'evt_future_2');

      const dispatcher = vi.fn();
      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
      });

      const result = await scheduler.tick();

      expect(result).toEqual({ attempted: 0, posted: 0, failed: 0, deadLettered: 0 });
      expect(dispatcher).not.toHaveBeenCalled();
      expect(storage.entries.countPendingScheduled()).toBe(2);
    });
  });

  describe('dispatcher throws', () => {
    it('leaves failing entry pending; succeeds for the next; onError called with entry+error', async () => {
      const storage = inMemoryStorage();
      const failing = seedScheduled(storage, '2026-05-10', 'sub_f', 'evt_f');
      seedScheduled(storage, '2026-05-15', 'sub_s', 'evt_s');

      const boom = new Error('dispatcher exploded');
      const dispatcher: Dispatcher = (entry) => {
        if (entry.id === failing.id) throw boom;
      };

      const onError = vi.fn();

      const scheduler = createScheduler({
        storage,
        dispatcher,
        onError,
        today: () => '2026-05-16',
      });

      const result = await scheduler.tick();

      expect(result).toEqual({ attempted: 2, posted: 1, failed: 1, deadLettered: 0 });

      // Failing entry is still pending (status remained 'pending'; only
      // posted entries disappear) but is queued for a future retry — querying
      // far in the future returns it; querying now does not (backoff window).
      const futurePending = storage.entries.findPendingScheduled(
        '2026-05-16',
        Date.now() + 24 * 60 * 60_000,
      );
      expect(futurePending.map((e) => e.id)).toEqual([failing.id]);
      // attempts incremented and lastError captured.
      expect(futurePending[0]?.attempts).toBe(1);
      expect(futurePending[0]?.lastError).toBe('dispatcher exploded');

      // onError was called once, with the failing entry and the thrown error.
      expect(onError).toHaveBeenCalledTimes(1);
      const [calledEntry, calledErr] = onError.mock.calls[0] ?? [];
      expect((calledEntry as SavedScheduledEntry).id).toBe(failing.id);
      expect(calledErr).toBe(boom);
    });

    it('also catches rejected promises from async dispatchers', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_a', 'evt_a');

      const boom = new Error('async exploded');
      const dispatcher: Dispatcher = () => Promise.reject(boom);
      const onError = vi.fn();

      const scheduler = createScheduler({
        storage,
        dispatcher,
        onError,
        today: () => '2026-05-16',
      });

      const result = await scheduler.tick();

      expect(result).toEqual({ attempted: 1, posted: 0, failed: 1, deadLettered: 0 });
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  describe('re-entrant safety (concurrent ticks)', () => {
    it('a second concurrent tick is a no-op while the first is in flight', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_a', 'evt_a');
      seedScheduled(storage, '2026-05-11', 'sub_b', 'evt_b');

      // A dispatcher that pauses until we explicitly release it.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      const dispatcher: Dispatcher = async () => {
        await gate;
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
      });

      // Start tick #1 (will await `gate`)
      const t1 = scheduler.tick();
      // Tick #2 should immediately short-circuit while #1 is in-flight.
      const t2Result = await scheduler.tick();
      expect(t2Result).toEqual({ attempted: 0, posted: 0, failed: 0, deadLettered: 0 });

      // Now let tick #1 complete.
      release();
      const t1Result = await t1;
      expect(t1Result).toEqual({ attempted: 2, posted: 2, failed: 0, deadLettered: 0 });
      expect(storage.entries.countPendingScheduled()).toBe(0);
    });
  });

  describe('start()/stop() lifecycle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('start is idempotent; stop is idempotent; isRunning reflects state', () => {
      const storage = inMemoryStorage();
      const scheduler = createScheduler({
        storage,
        dispatcher: vi.fn(),
        intervalMs: 1000,
        today: () => '2026-05-16',
      });

      expect(scheduler.isRunning()).toBe(false);
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.start(); // second start is a no-op
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
      scheduler.stop(); // second stop is a no-op
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('today override', () => {
    it('controls which entries are considered due', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_a', 'evt_a');
      seedScheduled(storage, '2026-06-10', 'sub_b', 'evt_b');

      const dispatcher = vi.fn();
      const scheduler = createScheduler({
        storage,
        dispatcher,
        // Pretend today is well before either entry.
        today: () => '2026-05-01',
      });

      const first = await scheduler.tick();
      expect(first).toEqual({ attempted: 0, posted: 0, failed: 0, deadLettered: 0 });
      expect(dispatcher).not.toHaveBeenCalled();

      // Build a second scheduler with a later "today" — now the first entry is due.
      const dispatcher2 = vi.fn();
      const scheduler2 = createScheduler({
        storage,
        dispatcher: dispatcher2,
        today: () => '2026-05-15',
      });
      const second = await scheduler2.tick();
      expect(second).toEqual({ attempted: 1, posted: 1, failed: 0, deadLettered: 0 });
      expect(dispatcher2).toHaveBeenCalledTimes(1);
    });
  });

  describe('initial tick on start', () => {
    it('runs a tick immediately rather than waiting an interval', async () => {
      const storage = inMemoryStorage();
      const due = seedScheduled(storage, '2026-05-10', 'sub_immediate', 'evt_immediate');

      let dispatched = false;
      const dispatcher: Dispatcher = (entry) => {
        if (entry.id === due.id) dispatched = true;
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        intervalMs: 60_000,
        today: () => '2026-05-16',
      });

      scheduler.start();
      // Wait for the microtask queue to drain — the immediate tick is async,
      // but it should resolve before any wall-clock time passes.
      await new Promise((resolve) => setImmediate(resolve));

      expect(dispatched).toBe(true);
      expect(storage.entries.countPendingScheduled()).toBe(0);

      scheduler.stop();
    });
  });

  describe('setInterval firing', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('advancing fake timers by interval triggers another tick', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-01', 'sub_a', 'evt_a');

      const dispatcher = vi.fn();
      const scheduler = createScheduler({
        storage,
        dispatcher,
        intervalMs: 1000,
        today: () => '2026-05-16',
      });

      scheduler.start();
      // Drain microtasks so the initial tick resolves.
      await vi.runOnlyPendingTimersAsync();
      expect(dispatcher).toHaveBeenCalledTimes(1);

      // Seed another due entry, advance one interval — the interval handler
      // fires another tick.
      seedScheduled(storage, '2026-05-02', 'sub_b', 'evt_b');
      await vi.advanceTimersByTimeAsync(1000);
      expect(dispatcher).toHaveBeenCalledTimes(2);

      scheduler.stop();
    });
  });

  describe('retry backoff + dead-letter', () => {
    it('increments attempts and schedules next_attempt_at via backoffMs on failure', async () => {
      const storage = inMemoryStorage();
      const e = seedScheduled(storage, '2026-05-10', 'sub_r', 'evt_r');

      const boom = new Error('transient');
      const dispatcher: Dispatcher = () => {
        throw boom;
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => 10_000,
        backoffMs: () => 500,
      });

      const result = await scheduler.tick();
      expect(result).toEqual({ attempted: 1, posted: 0, failed: 1, deadLettered: 0 });

      const found = storage.entries.findPendingScheduled('2026-05-16', 1_000_000);
      expect(found).toHaveLength(1);
      expect(found[0]?.attempts).toBe(1);
      expect(found[0]?.lastAttemptedAt).toBe(10_000);
      expect(found[0]?.nextAttemptAt).toBe(10_500);
      expect(found[0]?.lastError).toBe('transient');
      expect(found[0]?.status).toBe('pending');
      // sanity: id preserved.
      expect(found[0]?.id).toBe(e.id);
    });

    it('does not retry an entry whose next_attempt_at is in the future', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_r', 'evt_r');

      const dispatcher = vi.fn(() => {
        throw new Error('boom');
      });

      // backoff = 1000ms; first tick at t=10_000, fails, schedules retry at t=11_000.
      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => 10_000,
        backoffMs: () => 1_000,
      });

      await scheduler.tick();
      expect(dispatcher).toHaveBeenCalledTimes(1);

      // A second scheduler at t=10_500 (still inside the backoff window) skips it.
      const dispatcher2 = vi.fn(() => {
        throw new Error('boom');
      });
      const scheduler2 = createScheduler({
        storage,
        dispatcher: dispatcher2,
        today: () => '2026-05-16',
        now: () => 10_500,
        backoffMs: () => 1_000,
      });
      const skip = await scheduler2.tick();
      expect(skip).toEqual({ attempted: 0, posted: 0, failed: 0, deadLettered: 0 });
      expect(dispatcher2).not.toHaveBeenCalled();

      // A third scheduler at t=11_500 (past the backoff window) does retry.
      const dispatcher3 = vi.fn(() => {
        throw new Error('boom');
      });
      const scheduler3 = createScheduler({
        storage,
        dispatcher: dispatcher3,
        today: () => '2026-05-16',
        now: () => 11_500,
        backoffMs: () => 1_000,
      });
      const retry = await scheduler3.tick();
      expect(retry.attempted).toBe(1);
      expect(retry.failed).toBe(1);
      expect(dispatcher3).toHaveBeenCalledTimes(1);
    });

    it('transitions to failed (dead-letter) after maxAttempts failures', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_dl', 'evt_dl');

      const dispatcher: Dispatcher = () => {
        throw new Error('always broken');
      };

      // maxAttempts=3; backoff=0 so we don't have to advance time between attempts.
      let clock = 1_000;
      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => clock,
        maxAttempts: 3,
        backoffMs: () => 0,
      });

      // Attempt 1: pending, attempts=1, deadLettered=0.
      let r = await scheduler.tick();
      expect(r).toEqual({ attempted: 1, posted: 0, failed: 1, deadLettered: 0 });
      // Advance past the (zero) backoff so the entry surfaces again.
      clock = 1_001;

      // Attempt 2: pending, attempts=2, still no dead-letter.
      r = await scheduler.tick();
      expect(r).toEqual({ attempted: 1, posted: 0, failed: 1, deadLettered: 0 });
      clock = 1_002;

      // Attempt 3: hits maxAttempts → dead-letter.
      r = await scheduler.tick();
      expect(r).toEqual({ attempted: 1, posted: 0, failed: 1, deadLettered: 1 });

      // Subsequent ticks find nothing — failed entries are excluded.
      clock = 9_999_999;
      const after = await scheduler.tick();
      expect(after).toEqual({ attempted: 0, posted: 0, failed: 0, deadLettered: 0 });

      expect(storage.entries.countPendingScheduled()).toBe(0);
      expect(storage.entries.countFailedScheduled()).toBe(1);
    });

    it('records and truncates lastError longer than 1000 chars', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_t', 'evt_t');

      const long = 'x'.repeat(2000);
      const dispatcher: Dispatcher = () => {
        throw new Error(long);
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => 1_000,
        backoffMs: () => 0,
        maxAttempts: 10,
      });
      await scheduler.tick();

      const found = storage.entries.findPendingScheduled('2026-05-16', 9_999_999);
      const recorded = found[0]?.lastError ?? '';
      // 1000 chars + literal "..." trailer.
      expect(recorded.length).toBe(1003);
      expect(recorded.endsWith('...')).toBe(true);
      expect(recorded.slice(0, 10)).toBe('xxxxxxxxxx');
    });

    it('records lastError for non-Error throws via String() coercion', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_str', 'evt_str');

      const dispatcher: Dispatcher = () => {
        throw 'string boom'; // eslint-disable-line @typescript-eslint/only-throw-error
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => 1_000,
        backoffMs: () => 0,
      });
      await scheduler.tick();
      const found = storage.entries.findPendingScheduled('2026-05-16', 9_999_999);
      expect(found[0]?.lastError).toBe('string boom');
    });

    it('honors a custom backoffMs function', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_cb', 'evt_cb');

      const calls: number[] = [];
      const dispatcher: Dispatcher = () => {
        throw new Error('boom');
      };
      const backoffMs = (attempts: number): number => {
        calls.push(attempts);
        return attempts * 12_345;
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => 100,
        backoffMs,
      });
      await scheduler.tick();
      expect(calls).toEqual([1]); // called with newAttempts
      const found = storage.entries.findPendingScheduled('2026-05-16', 9_999_999);
      expect(found[0]?.nextAttemptAt).toBe(100 + 12_345);
    });

    it('honors a custom now() function for both query and recording', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_n', 'evt_n');

      const dispatcher: Dispatcher = () => {
        throw new Error('boom');
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => 555_000,
        backoffMs: () => 100,
      });
      await scheduler.tick();
      const found = storage.entries.findPendingScheduled('2026-05-16', 9_999_999);
      expect(found[0]?.lastAttemptedAt).toBe(555_000);
      expect(found[0]?.nextAttemptAt).toBe(555_100);
    });

    it('deadLettered counter is a subset of failed (mixed batch)', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_a', 'evt_a');
      const b = seedScheduled(storage, '2026-05-11', 'sub_b', 'evt_b');

      // Mark entry b as already at 9 attempts so one more failure dead-letters it.
      // Use the storage API directly to set attempts=9, no backoff window.
      storage.entries.recordScheduledAttempt(b.id, 9, 1, null, 'prior', 'pending');

      const dispatcher: Dispatcher = () => {
        throw new Error('boom');
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => 1_000,
        maxAttempts: 10,
        backoffMs: () => 0,
      });
      const r = await scheduler.tick();
      expect(r.attempted).toBe(2);
      expect(r.posted).toBe(0);
      expect(r.failed).toBe(2);
      expect(r.deadLettered).toBe(1);
      expect(storage.entries.countFailedScheduled()).toBe(1);
    });

    it('maxAttempts=1 dead-letters on the first failure', async () => {
      const storage = inMemoryStorage();
      seedScheduled(storage, '2026-05-10', 'sub_one', 'evt_one');

      const dispatcher: Dispatcher = () => {
        throw new Error('boom');
      };

      const scheduler = createScheduler({
        storage,
        dispatcher,
        today: () => '2026-05-16',
        now: () => 1_000,
        maxAttempts: 1,
        backoffMs: () => 0,
      });
      const r = await scheduler.tick();
      expect(r).toEqual({ attempted: 1, posted: 0, failed: 1, deadLettered: 1 });
      expect(storage.entries.countFailedScheduled()).toBe(1);
    });
  });
});

describe('defaultBackoffMs', () => {
  it('attempts=1 → 60s', () => {
    expect(defaultBackoffMs(1)).toBe(60_000);
  });
  it('attempts=2 → 120s', () => {
    expect(defaultBackoffMs(2)).toBe(120_000);
  });
  it('attempts=3 → 240s', () => {
    expect(defaultBackoffMs(3)).toBe(240_000);
  });
  it('doubles each attempt up to the cap', () => {
    // attempts=10 → 60_000 * 2^9 = 30_720_000 ms = 8.5h (under the 24h cap).
    expect(defaultBackoffMs(10)).toBe(60_000 * Math.pow(2, 9));
    // attempts=11 → 60_000 * 2^10 = 61_440_000 ms = ~17h (still under cap).
    expect(defaultBackoffMs(11)).toBe(60_000 * Math.pow(2, 10));
  });
  it('caps at 24h once 60s * 2^(attempts-1) exceeds the cap', () => {
    const cap = 24 * 60 * 60_000;
    // attempts=12 → 122_880_000 > cap; clamps.
    expect(defaultBackoffMs(12)).toBe(cap);
    expect(defaultBackoffMs(20)).toBe(cap);
    expect(defaultBackoffMs(50)).toBe(cap);
  });
});

describe('consoleDispatcher', () => {
  it('logs a one-liner with the entry id, subscription, date, and memo', () => {
    const storage = inMemoryStorage();
    const saved = seedScheduled(storage, '2026-05-16', 'sub_log', 'evt_log');

    const info = vi.fn();
    const dispatcher = consoleDispatcher({
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
    });
    void dispatcher(saved);

    expect(info).toHaveBeenCalledTimes(1);
    const [msg, meta] = info.mock.calls[0] ?? [];
    expect(typeof msg).toBe('string');
    expect(msg as string).toContain(`id=${String(saved.id)}`);
    expect(msg as string).toContain('subscription=sub_log');
    expect(msg as string).toContain('date=2026-05-16');
    expect(msg as string).toContain('memo=monthly recognition');
    expect(meta).toEqual({ entry: saved.entry });
  });

  it('uses console by default when no logger is passed', () => {
    // We don't actually want to assert on console output here — just smoke
    // test that the default path does not throw.
    const storage = inMemoryStorage();
    const saved = seedScheduled(storage, '2026-05-16', 'sub_default', 'evt_default');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const dispatcher = consoleDispatcher();
      expect(() => {
        void dispatcher(saved);
      }).not.toThrow();
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});
