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
 * - On failure: throw / reject. Scheduler increments the attempt counter,
 *   schedules a retry via exponential backoff, and after `maxAttempts` failures
 *   dead-letters the entry to `status='failed'`.
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
  /**
   * Function returning the current time as epoch ms. Defaults to `Date.now`.
   * Override for tests so retry-backoff math and `next_attempt_at` filtering
   * are deterministic.
   */
  readonly now?: () => number;
  /**
   * Maximum number of dispatch attempts before an entry is moved to the
   * dead-letter `'failed'` state. Default 10. Setting `maxAttempts=1` means
   * any single failure dead-letters immediately.
   */
  readonly maxAttempts?: number;
  /**
   * Function mapping attempt count (1-based, i.e. the attempt just recorded)
   * to delay-until-next-retry in ms. Defaults to `defaultBackoffMs`.
   */
  readonly backoffMs?: (attempts: number) => number;
}

export interface TickResult {
  readonly attempted: number;
  readonly posted: number;
  readonly failed: number;
  /**
   * Subset of `failed`: entries that transitioned from `'pending'` to
   * `'failed'` on this tick (reached `maxAttempts`). Useful for operator
   * alerts — "we just dead-lettered N entries" is the actionable signal.
   */
  readonly deadLettered: number;
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
 * Default exponential backoff: 60s × 2^(attempts-1), capped at 24h.
 *
 * - attempts=1 → 60s (1 minute)
 * - attempts=2 → 120s (2 minutes)
 * - attempts=3 → 240s (4 minutes)
 * - attempts=10 → ~512 minutes (~8.5 hours)
 * - attempts=11 → 1024 minutes (capped at 24h = 1440 minutes — so still ~17h)
 * - attempts=12+ → 24h (capped)
 *
 * With `maxAttempts=10` (default) an entry that fails every retry burns
 * roughly 17 hours before dead-lettering, which spans a full business day —
 * enough for transient incidents to clear without burning the operator's
 * pager overnight.
 */
export function defaultBackoffMs(attempts: number): number {
  const baseMs = 60_000;
  const maxMs = 24 * 60 * 60_000;
  return Math.min(baseMs * Math.pow(2, attempts - 1), maxMs);
}

/** Truncate a string with an ellipsis if longer than `maxLen`. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
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
 * On dispatcher failure the scheduler increments the entry's attempt counter,
 * schedules the next retry via exponential backoff (`backoffMs`), and after
 * `maxAttempts` failures moves the entry to `'failed'` (dead-letter). Failed
 * entries are surfaced via `Storage.entries.countFailedScheduled()` and the
 * `/health` endpoint's `failedScheduled` counter.
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
  const now = config.now ?? ((): number => Date.now());
  const maxAttempts = config.maxAttempts ?? 10;
  const backoffMs = config.backoffMs ?? defaultBackoffMs;

  let timer: NodeJS.Timeout | null = null;
  let isTicking = false;

  async function tick(): Promise<TickResult> {
    // Re-entrant safety: if a previous tick is still running (slow dispatcher),
    // skip this one rather than overlapping work.
    if (isTicking) return { attempted: 0, posted: 0, failed: 0, deadLettered: 0 };
    isTicking = true;
    let attempted = 0;
    let posted = 0;
    let failed = 0;
    let deadLettered = 0;
    try {
      const due = config.storage.entries.findPendingScheduled(today(), now());
      for (const entry of due) {
        attempted++;
        try {
          await config.dispatcher(entry);
          config.storage.entries.markScheduledPosted(entry.id);
          posted++;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const truncated = truncate(errMsg, 1000);
          const newAttempts = entry.attempts + 1;
          const attemptedAt = now();

          if (newAttempts >= maxAttempts) {
            // Dead-letter: leave next_attempt_at null so the entry doesn't
            // accidentally re-surface if status is later flipped back to
            // 'pending' without resetting next_attempt_at.
            config.storage.entries.recordScheduledAttempt(
              entry.id,
              newAttempts,
              attemptedAt,
              null,
              truncated,
              'failed',
            );
            deadLettered++;
          } else {
            const delay = backoffMs(newAttempts);
            config.storage.entries.recordScheduledAttempt(
              entry.id,
              newAttempts,
              attemptedAt,
              attemptedAt + delay,
              truncated,
              'pending',
            );
          }

          onError(entry, err);
          failed++;
        }
      }
    } finally {
      isTicking = false;
    }
    return { attempted, posted, failed, deadLettered };
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
