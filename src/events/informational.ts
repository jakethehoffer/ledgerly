import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';

/**
 * Handler for Stripe events that have no accounting impact.
 *
 * Returns an empty `MapResult` -- engine acknowledges receipt without emitting
 * any journal entries. Use this for events that signal state changes the
 * accounting ledger doesn't need to track (e.g. dunning attempts, subscription
 * metadata changes, dispute-opened notifications without money movement).
 *
 * The event-type guard is intentionally omitted: this function is wired into
 * `HANDLERS` under multiple event types, and the registry dispatch already
 * routes by `event.type`. Adding a per-type guard would defeat the purpose
 * of a shared no-op.
 */
export function handleInformational(_event: Stripe.Event): MapResult {
  return { entries: [], schedule: null };
}
