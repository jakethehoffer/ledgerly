import type { JournalEntry, MapResult, RecognitionSchedule } from '../../journal.js';
import type { ConnectedTokens, OAuthProvider } from '../oauth/types.js';

/**
 * Event deduplication interface.
 *
 * Production receivers should persist the dedup state so that Stripe redeliveries
 * (up to 3 days, sometimes more) are caught across server restarts and rolling
 * deploys. The in-memory implementation has a 7-day TTL and is fine for dev /
 * single-instance demos, but loses state on restart.
 *
 * The split `has()` / `record()` shape lets the server check for an existing
 * event before doing the expensive expansion + mapping work, then record the
 * event ID atomically with persisting the resulting journal entries. The
 * `checkAndRecord()` convenience preserves the original single-call semantics
 * for code paths that don't need the split.
 */
export interface Deduplicator {
  /** Returns true if the event ID has been recorded as processed. */
  has(eventId: string): boolean;

  /** Records the event ID as processed at the given timestamp (epoch ms). */
  record(eventId: string, now?: number): void;

  /**
   * Convenience: returns true if the event was already seen, otherwise records
   * it and returns false. Equivalent to `has(id) || (record(id), false)`.
   */
  checkAndRecord(eventId: string, now?: number): boolean;

  /** Number of currently recorded (and not expired) event IDs. */
  size(): number;
}

/**
 * A journal entry that has been persisted as posted today (immediate).
 *
 * The `id` is the backend-assigned primary key. Callers downstream of the
 * receiver (a batch QBO/Xero sync job, an audit report) can use it to refer to
 * a specific persisted row.
 */
export interface SavedImmediateEntry {
  readonly id: number;
  readonly eventId: string;
  readonly entry: JournalEntry;
  readonly postedAt: number; // epoch ms
}

/**
 * A future-dated journal entry that is part of a recognition schedule. Status
 * starts as `'pending'`; a downstream poster transitions it to `'posted'` once
 * it has been pushed to QBO/Xero on or after `entry.date`. After enough
 * consecutive dispatcher failures the scheduler moves the entry to `'failed'`
 * (dead-letter); a human re-queues it via SQL after fixing the root cause.
 *
 * Attempt fields:
 * - `attempts` — count of dispatch attempts that have been recorded (each
 *   thrown dispatcher call increments this by 1). 0 for fresh entries.
 * - `lastAttemptedAt` — epoch ms of the most recent failed dispatch attempt.
 *   `null` for entries that have never been attempted (or where the most
 *   recent attempt succeeded — but those rows are `'posted'` so the field is
 *   moot).
 * - `nextAttemptAt` — epoch ms after which the scheduler is allowed to retry.
 *   `null` means "ready now" (fresh entry, or no backoff scheduled).
 * - `lastError` — truncated error message from the most recent failed
 *   dispatch attempt. `null` for entries that have never failed.
 */
export interface SavedScheduledEntry {
  readonly id: number;
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly entry: JournalEntry;
  readonly status: 'pending' | 'posted' | 'cancelled' | 'failed';
  readonly attempts: number;
  readonly lastAttemptedAt: number | null;
  readonly nextAttemptAt: number | null;
  readonly lastError: string | null;
}

/**
 * Journal entry persistence interface. Both immediate entries (posting today)
 * and future-dated entries (deferred-revenue recognition) live here.
 *
 * Implementations are not required to make `saveImmediate` / `saveScheduled`
 * atomic across multiple calls — callers that need cross-call atomicity should
 * use `Storage.persistMapResult` instead, which the SQLite backend wraps in a
 * single transaction.
 */
export interface JournalEntryStore {
  /** Persist a journal entry that posts immediately (today). */
  saveImmediate(entry: JournalEntry, eventId: string): SavedImmediateEntry;

  /** Persist a future-dated entry from a RecognitionSchedule. */
  saveScheduled(
    entry: JournalEntry,
    schedule: Pick<RecognitionSchedule, 'subscriptionId' | 'sourceEventId'>,
  ): SavedScheduledEntry;

  /** Query: immediate entries for an event ID, oldest-first. */
  findByEventId(eventId: string): SavedImmediateEntry[];

  /**
   * Query: immediate entries whose `sourceObjectId` matches, oldest-first. Used by
   * the credit-void reconciler to find the draw-down entry a deferred
   * `credit_note.created` posted (keyed by the credit-note id) so a later
   * `credit_note.voided` can invert it exactly.
   */
  findImmediateBySourceObject(objectId: string): SavedImmediateEntry[];

  /**
   * Query: pending scheduled entries due for dispatch. Filter:
   * `status='pending'` AND `scheduled_date <= asOfDate` AND
   * (`next_attempt_at IS NULL` OR `next_attempt_at <= now`).
   *
   * `now` defaults to `Date.now()` and is overrideable for tests so the
   * retry-backoff predicate can be exercised deterministically.
   */
  findPendingScheduled(asOfDate: string, now?: number): SavedScheduledEntry[];

  /**
   * Query: every recognition-schedule row for a subscription, any status.
   * Filters on `subscription_id`, which recognition entries share, so it
   * excludes the synthetic `immediate:<eventId>` dispatch rows written for
   * immediate entries. A caller isolating one invoice filters the result by
   * `entry.sourceObjectId`. Used by the void reconciler to find the schedule it
   * must reverse and cancel.
   */
  findScheduledBySubscription(subscriptionId: string): SavedScheduledEntry[];

  /** Mark a scheduled entry as posted. Throws if the ID does not exist. */
  markScheduledPosted(id: number): void;

  /**
   * Transition a scheduled entry to `'cancelled'` so the scheduler never posts
   * it. Only `'pending'` and `'failed'` rows are cancellable; a `'posted'` or
   * already-`'cancelled'` row is left unchanged (a no-op, not an error, so a
   * void reconciliation is safe against a row the scheduler posted a moment
   * earlier). Throws only if no row with `id` exists.
   */
  cancelScheduled(id: number): void;

  /**
   * Record a failed dispatch attempt. Storage just persists what it's told —
   * the scheduler computes `attempts + 1`, `lastAttemptedAt = now`,
   * `nextAttemptAt = now + backoffMs(...)` (or `null` when dead-lettering),
   * and `status` (`'pending'` for a retry, `'failed'` for dead-letter).
   */
  recordScheduledAttempt(
    id: number,
    attempts: number,
    lastAttemptedAt: number,
    nextAttemptAt: number | null,
    lastError: string,
    status: 'pending' | 'failed',
  ): void;

  /** Count of immediate journal entries (for /health). */
  countImmediate(): number;

  /** Count of pending scheduled entries (for /health). */
  countPendingScheduled(): number;

  /** Count of dead-lettered scheduled entries in `'failed'` state (for /health). */
  countFailedScheduled(): number;

  /**
   * List immediate journal entries newest-first (descending id), capped at
   * `limit` rows. Implementations cap `limit` at 500 to prevent unbounded
   * response sizes; values larger than 500 are silently clamped. `limit`
   * defaults to 50.
   *
   * Used by the operational admin endpoint `GET /admin/entries` so an
   * operator can inspect what the receiver has recently posted without
   * dropping into the SQLite CLI.
   */
  listRecentImmediate(limit?: number): SavedImmediateEntry[];

  /**
   * List scheduled entries with the given `status`, newest-first (descending
   * id), capped at `limit` rows. `limit` defaults to 50 and is clamped to a
   * maximum of 500.
   *
   * Used by the operational admin endpoint `GET /admin/scheduled` so an
   * operator can browse pending / failed / posted entries without dropping
   * into the SQLite CLI.
   */
  listScheduledByStatus(
    status: SavedScheduledEntry['status'],
    limit?: number,
  ): SavedScheduledEntry[];

  /**
   * Read a single scheduled entry by primary key. Returns `null` when no
   * row matches — admin endpoints translate that into a 404. Used by the
   * operational admin endpoint `GET /admin/scheduled/:id`.
   */
  getScheduledById(id: number): SavedScheduledEntry | null;

  /**
   * Re-queue a scheduled entry: resets `status='pending'`, `attempts=0`,
   * `lastAttemptedAt=null`, `nextAttemptAt=null`, `lastError=null`. The next
   * scheduler tick will pick it up immediately.
   *
   * Idempotent — calling on an already-pending row leaves it eligible-now
   * with the same field reset semantics. Throws if the row does not exist.
   * Returns the freshly-read row reflecting the new field values.
   *
   * Used by the operational admin endpoint `POST /admin/scheduled/:id/retry`
   * so an operator can recover dead-lettered entries after fixing the
   * underlying issue (a missing account map entry, a revoked OAuth grant)
   * without dropping into raw SQL.
   */
  requeueScheduled(id: number): SavedScheduledEntry;
}

/**
 * Persistence interface for OAuth token sets. Keyed by `(provider, tenantId)`
 * so a future multi-tenant deployment can hold many token sets per provider
 * without schema churn. MVP deployments store at most one row per provider
 * and use the `get(provider)` convenience to read it back.
 */
export interface OAuthTokenStore {
  /** Upsert by `(provider, tenantId)` primary key. */
  save(tokens: ConnectedTokens): void;
  /**
   * Return the single token set for a provider. Convenience for MVP
   * single-tenant deployments. Returns `null` if no row exists for the
   * provider; throws if more than one row exists (multi-tenant deployments
   * must use {@link list} instead).
   */
  get(provider: OAuthProvider): ConnectedTokens | null;
  /** Return every token set for a provider. */
  list(provider: OAuthProvider): ConnectedTokens[];
  /** Delete the row at `(provider, tenantId)`. No-op if the row does not exist. */
  delete(provider: OAuthProvider, tenantId: string): void;
}

/**
 * Outcome of {@link Storage.persistMapResult}.
 *
 * `duplicate` is `true` when the event had already been recorded as processed
 * and this call wrote nothing. The persistence layer is the idempotency
 * boundary: a duplicate delivery that races past the receiver's cheap
 * `dedup.has()` pre-check (the check and the record straddle an `await`, so two
 * concurrent deliveries can both pass it) still posts entries exactly once,
 * because only the first caller to claim the event ID writes. `false` means
 * this call won the claim and persisted its entries.
 */
export interface PersistResult {
  readonly duplicate: boolean;
}

/**
 * Input to {@link Storage.persistVoidReversal}. Describes which invoice's
 * recognition schedule to reconcile and how to build the reversal entry from
 * whatever has already recognized.
 *
 * The storage layer holds no accounting knowledge: it reads the recognition
 * rows for `(subscriptionId, invoiceId)`, cancels the still-pending / dead-
 * lettered ones, and passes the already-**posted** recognition entries to
 * `buildReversal`, which returns the single balanced reversal entry to post.
 * Doing the read, the cancellation, and the build in one transaction means the
 * scheduler cannot recognize another month between "measure what has posted"
 * and "cancel the rest".
 */
export interface VoidReconcileInput {
  readonly subscriptionId: string;
  readonly invoiceId: string;
  readonly buildReversal: (postedRecognition: ReadonlyArray<JournalEntry>) => JournalEntry;
}

/**
 * Input to {@link Storage.persistCreditReversal}. Describes a credit note against
 * a deferred-schedule invoice: which invoice's schedule to draw down, and how to
 * build both the immediate reversal and the reduced (re-spread) schedule from the
 * ledger's current recognition rows.
 *
 * Like {@link VoidReconcileInput}, the storage layer holds no accounting
 * knowledge. It reads the recognition rows for `(subscriptionId, invoiceId)`,
 * hands the already-**posted** ones (recognized) and the still-**pending** ones
 * (remaining deferred) to `build`, cancels the pending ones, then posts the
 * returned `reversal` as an immediate entry and enqueues the returned
 * `reducedSchedule` (the re-spread of what remains deferred). Doing the read, the
 * cancellations, the reissue, and the posting in one transaction means the
 * scheduler cannot recognize another month mid-reconciliation.
 */
export interface CreditReconcileInput {
  readonly subscriptionId: string;
  readonly invoiceId: string;
  readonly build: (
    postedRecognition: ReadonlyArray<JournalEntry>,
    pendingRecognition: ReadonlyArray<JournalEntry>,
  ) => { reversal: JournalEntry; reducedSchedule: RecognitionSchedule | null };
}

/**
 * Input to {@link Storage.persistCreditVoidReversal}. Describes voiding a credit
 * note that was booked as a deferred draw-down: the invoice's schedule to
 * re-inflate, and the credit note whose draw-down entry must be inverted.
 *
 * The storage layer reads the draw-down's immediate entry (by `creditNoteId`) and
 * the invoice's current recognition rows, hands both to `build`, then — if `build`
 * returns a reversal (i.e. a draw-down was found) — cancels the current pending
 * rows, posts the `reversal`, and enqueues the `reissuedSchedule`. `build` returns
 * `null` when no draw-down entry exists (the credit note was never booked this
 * way), in which case voiding is a no-op and the schedule is left untouched.
 */
export interface CreditVoidReconcileInput {
  readonly subscriptionId: string;
  readonly invoiceId: string;
  readonly creditNoteId: string;
  readonly build: (
    drawDown: ReadonlyArray<JournalEntry>,
    pendingRecognition: ReadonlyArray<JournalEntry>,
  ) => { reversal: JournalEntry; reissuedSchedule: RecognitionSchedule | null } | null;
}

/**
 * Aggregate persistence handle bundling a deduplicator and journal entry store.
 *
 * `persistMapResult` is the single-call entry point the server uses after a
 * successful `mapEvent`: it persists every immediate entry, every scheduled
 * entry, and records the event ID as processed — atomically per backend
 * semantics. The SQLite backend wraps the work in a transaction; the in-memory
 * backend runs sequentially (atomic under JS single-threaded semantics).
 */
export interface Storage {
  readonly dedup: Deduplicator;
  readonly entries: JournalEntryStore;
  readonly oauth: OAuthTokenStore;

  /**
   * Cheap reachability check. Implementations issue the smallest possible
   * query that confirms the storage is responsive (e.g. SQLite `SELECT 1`);
   * throw if unreachable, return `void` on success. Used by `GET /readyz`
   * as a readiness probe distinct from `/health` (which always returns 200
   * with storage counts, suitable for liveness + observability scrapes).
   *
   * In-memory backends are always ready as long as the JS heap is alive,
   * so their implementation is a no-op. Persistent backends must not cache
   * the result — every call should actually touch the underlying store so
   * the readiness probe surfaces real connectivity failures (corrupt file,
   * unmounted volume, etc.) instead of stale "ready" answers.
   */
  ping(): void;

  /**
   * Persist every entry in `result` and record `eventId` as processed.
   * Atomic per-backend: either all writes land and the event is recorded, or
   * none do.
   *
   * Idempotent: if `eventId` was already recorded, nothing is written and the
   * call returns `{ duplicate: true }`. This is the receiver's correctness
   * boundary against double-posting (see {@link PersistResult}).
   *
   * For each immediate entry in `result.entries`, the implementation writes
   * to BOTH the journal entry audit log AND the scheduled-entries dispatch
   * queue (with a synthetic `immediate:<sourceEventId>` subscription ID and
   * `scheduled_date = entry.date`). The next scheduler tick picks it up and
   * pushes it to QBO/Xero. The journal entry row remains the canonical audit
   * record; the scheduled entry row is the dispatch handle that transitions
   * `pending` → `posted` (or `failed`) the same way recognition entries do.
   *
   * Recognition-schedule entries in `result.schedule.entries` are enqueued
   * the usual way (future-dated, real subscription ID).
   */
  persistMapResult(eventId: string, result: MapResult, now?: number): PersistResult;

  /**
   * Persist a void reversal and cancel the voided invoice's unposted schedule,
   * atomically, and record `eventId` as processed. Idempotent the same way as
   * {@link persistMapResult}: a duplicate `eventId` writes nothing and returns
   * `{ duplicate: true }`.
   *
   * In one transaction: claim `eventId`; read the recognition rows for
   * `(subscriptionId, invoiceId)`; transition the `'pending'` / `'failed'` ones
   * to `'cancelled'` so the scheduler never posts them; build the reversal entry
   * from the already-`'posted'` recognition entries via `input.buildReversal`;
   * and persist that entry as an immediate posting (audit log + dispatch queue),
   * exactly as {@link persistMapResult} does for immediate entries.
   */
  persistVoidReversal(
    eventId: string,
    input: VoidReconcileInput,
    now?: number,
  ): PersistResult;

  /**
   * Persist a credit-note draw-down against a deferred-schedule invoice, and
   * record `eventId` as processed. Idempotent the same way as
   * {@link persistVoidReversal}: a duplicate `eventId` writes nothing and returns
   * `{ duplicate: true }`.
   *
   * In one transaction: claim `eventId`; read the recognition rows for
   * `(subscriptionId, invoiceId)`; pass the `'posted'` and `'pending'`/`'failed'`
   * ones to `input.build`; transition the pending/failed ones to `'cancelled'` so
   * the scheduler never posts the pre-credit schedule; persist the returned
   * `reversal` as an immediate posting (audit log + dispatch queue); and enqueue
   * the returned `reducedSchedule` rows (the re-spread of what remains deferred),
   * exactly as {@link persistMapResult} does for a schedule.
   */
  persistCreditReversal(
    eventId: string,
    input: CreditReconcileInput,
    now?: number,
  ): PersistResult;

  /**
   * Persist the reversal of a voided deferred-credit draw-down, and record
   * `eventId` as processed. Idempotent like {@link persistVoidReversal}.
   *
   * In one transaction: claim `eventId`; read the draw-down's immediate entry
   * (by `input.creditNoteId`) and the invoice's recognition rows; call
   * `input.build`. If it returns `null` (nothing was booked for this credit note),
   * record and return without touching the schedule. Otherwise cancel the current
   * pending rows, persist the returned `reversal` as an immediate posting, and
   * enqueue the returned `reissuedSchedule` (the re-inflated remaining recognition).
   */
  persistCreditVoidReversal(
    eventId: string,
    input: CreditVoidReconcileInput,
    now?: number,
  ): PersistResult;
}
