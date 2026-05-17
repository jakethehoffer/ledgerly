import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cents } from '../../src/money.js';
import type { JournalEntry } from '../../src/journal.js';
import { createScheduler } from '../../src/server/scheduler.js';
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
      expect(result).toEqual({ attempted: 0, posted: 0, failed: 0 });
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
      expect(result).toEqual({ attempted: 0, posted: 0, failed: 0 });
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

      expect(result).toEqual({ attempted: 3, posted: 3, failed: 0 });
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
      expect(result).toEqual({ attempted: 1, posted: 1, failed: 0 });
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

      expect(result).toEqual({ attempted: 0, posted: 0, failed: 0 });
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

      expect(result).toEqual({ attempted: 2, posted: 1, failed: 1 });

      // Failing entry still appears as pending; succeeding does not.
      const stillPending = storage.entries.findPendingScheduled('2026-05-16');
      expect(stillPending.map((e) => e.id)).toEqual([failing.id]);

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

      expect(result).toEqual({ attempted: 1, posted: 0, failed: 1 });
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
      expect(t2Result).toEqual({ attempted: 0, posted: 0, failed: 0 });

      // Now let tick #1 complete.
      release();
      const t1Result = await t1;
      expect(t1Result).toEqual({ attempted: 2, posted: 2, failed: 0 });
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
      expect(first).toEqual({ attempted: 0, posted: 0, failed: 0 });
      expect(dispatcher).not.toHaveBeenCalled();

      // Build a second scheduler with a later "today" — now the first entry is due.
      const dispatcher2 = vi.fn();
      const scheduler2 = createScheduler({
        storage,
        dispatcher: dispatcher2,
        today: () => '2026-05-15',
      });
      const second = await scheduler2.tick();
      expect(second).toEqual({ attempted: 1, posted: 1, failed: 0 });
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
});

describe('consoleDispatcher', () => {
  it('logs a one-liner with the entry id, subscription, date, and memo', () => {
    const storage = inMemoryStorage();
    const saved = seedScheduled(storage, '2026-05-16', 'sub_log', 'evt_log');

    const info = vi.fn();
    const dispatcher = consoleDispatcher({ info });
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
