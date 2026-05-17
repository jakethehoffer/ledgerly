import type { SavedScheduledEntry, Storage } from './storage/types.js';

/**
 * A dispatcher receives a single scheduled entry and is responsible for
 * propagating it to its target (QBO API, Xero API, an outbound queue, console, etc.).
 *
 * Contract:
 * - MUST be idempotent. The scheduler may invoke the dispatcher multiple times
 *   for the same entry if a prior attempt failed AFTER dispatch but BEFORE the
 *   `markScheduledPosted` write. Real-world API pushers should pass `entry.id`
 *   as an idempotency key.
 * - On success: return / resolve normally. Scheduler will mark the entry posted.
 * - On failure: throw / reject. Scheduler will leave the entry as `pending` and
 *   retry on the next tick.
 */
export type Dispatcher = (entry: SavedScheduledEntry) => void | Promise<void>;

export interface SchedulerConfig {
  readonly storage: Storage;
  readonly dispatcher: Dispatcher;
  /** How often to poll for due entries. Default 60000ms. */
  readonly intervalMs?: number;
  /** Called when a dispatch attempt throws. Defaults to console.error. */
  readonly onError?: (entry: SavedScheduledEntry, error: unknown) => void;
  /** Function returning today's date as ISO YYYY-MM-DD. Defaults to UTC today. Override for tests. */
  readonly today?: () => string;
}

export interface TickResult {
  readonly attempted: number;
  readonly posted: number;
  readonly failed: number;
}

export interface Scheduler {
  /** Start the polling loop. Idempotent (no-op if already running). */
  start(): void;
  /** Stop the polling loop. Idempotent. */
  stop(): void;
  /** Whether the polling loop is active. */
  isRunning(): boolean;
  /** Process one batch synchronously (for tests + manual invocation). Returns count of attempts. */
  tick(): Promise<TickResult>;
}

/**
 * Build a background scheduler that periodically polls for due
 * `scheduled_entries`, dispatches each via the supplied `dispatcher`, and marks
 * successful entries as posted.
 *
 * The dispatcher is pluggable so downstream integrations (QBO API, Xero API,
 * an outbound queue) can swap in without scheduler changes. The default
 * shipped dispatcher writes to console.
 *
 * The scheduler is **single-writer**: it assumes nothing else is moving
 * scheduled entries from `pending` to `posted` concurrently. For multi-process
 * deployments, use an external lock or a queue-based dispatcher.
 */
export function createScheduler(config: SchedulerConfig): Scheduler {
  const interval = config.intervalMs ?? 60_000;
  const onError =
    config.onError ??
    ((entry, err): void => {
      // eslint-disable-next-line no-console
      console.error(
        `[scheduler] dispatch failed for entry id=${String(entry.id)}`,
        err,
      );
    });
  const today = config.today ?? ((): string => new Date().toISOString().slice(0, 10));

  let timer: NodeJS.Timeout | null = null;
  let isTicking = false;

  async function tick(): Promise<TickResult> {
    // Re-entrant safety: if a previous tick is still running (slow dispatcher),
    // skip this one rather than overlapping work.
    if (isTicking) return { attempted: 0, posted: 0, failed: 0 };
    isTicking = true;
    let attempted = 0;
    let posted = 0;
    let failed = 0;
    try {
      const due = config.storage.entries.findPendingScheduled(today());
      for (const entry of due) {
        attempted++;
        try {
          await config.dispatcher(entry);
          config.storage.entries.markScheduledPosted(entry.id);
          posted++;
        } catch (err) {
          onError(entry, err);
          failed++;
          // leave as pending; next tick retries
        }
      }
    } finally {
      isTicking = false;
    }
    return { attempted, posted, failed };
  }

  return {
    start(): void {
      if (timer !== null) return;
      // Run an initial tick immediately, then schedule subsequent ones.
      // Production deployments want due entries posted on startup, not
      // delayed by a full interval.
      void tick();
      timer = setInterval(() => {
        void tick();
      }, interval);
      // Don't keep the Node process alive just for the scheduler.
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    isRunning(): boolean {
      return timer !== null;
    },
    tick,
  };
}
