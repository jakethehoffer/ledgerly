import type Stripe from 'stripe';
import { assertBalanced } from '../journal.js';
import type { JournalEntry, MapResult } from '../journal.js';
import { cents } from '../money.js';
import { resolveSubscriptionId } from '../events/invoices/recognition.js';
import { epochToUtcDate } from '../util/dates.js';
import { sortLines } from '../util/lines.js';
import type {
  SubscriptionChangeReconcileInput,
  SubscriptionChangeReconcilePlan,
} from './storage/types.js';

function recognitionAmount(entry: JournalEntry): number {
  let total = 0;
  for (const line of entry.lines) {
    if (line.accountCode === '4000' && line.side === 'credit') total += line.amount;
  }
  return total;
}

/**
 * A paid, positive mid-term change can carry a new deferred-revenue schedule
 * while the original annual invoice still has unposted recognition rows. The
 * bundled receiver rebuilds the future rows on the old schedule's dates. It
 * keeps each invoice's deferred slice in its own rows, so a later credit cannot
 * draw down another invoice's balance. Already-recognized months stay immutable,
 * and the change invoice cannot recognize beyond the original term end.
 *
 * FX-bearing rows are refused: merging them would discard the per-invoice
 * customer-currency anchors required for later revaluation, while keeping the
 * change as a separate schedule can recognize beyond the original term end.
 */
export function buildSubscriptionChangeReconcileInput(
  event: Stripe.Event,
  result: MapResult,
): SubscriptionChangeReconcileInput {
  if (event.type !== 'invoice.payment_succeeded') {
    throw new Error(
      `buildSubscriptionChangeReconcileInput received wrong event type: ${event.type}`,
    );
  }
  const invoice = event.data.object;
  if (!result.schedule) {
    throw new Error(`Subscription change invoice ${invoice.id} has no deferred schedule to merge`);
  }

  const newSchedule = result.schedule;
  const subscriptionId = resolveSubscriptionId(invoice);
  const currency = newSchedule.entries[0]?.currency ?? invoice.currency.toUpperCase();
  const latestServiceEnd = Math.max(
    ...invoice.lines.data
      .filter((line) => line.proration)
      .map((line) => line.period.end),
  );
  if (!Number.isFinite(latestServiceEnd)) {
    throw new Error(`Subscription change invoice ${invoice.id} has no service end date`);
  }

  return {
    subscriptionId,
    throughDate: epochToUtcDate(latestServiceEnd),
    immediateEntries: result.entries,
    build(pendingRecognition): SubscriptionChangeReconcilePlan {
      if (pendingRecognition.length === 0) {
        throw new Error(
          `Cannot rebuild subscription ${subscriptionId} after invoice ${invoice.id}: ` +
            `no unposted recognition rows exist for the changed term`,
        );
      }

      const allRows = [...pendingRecognition, ...newSchedule.entries];
      const hasFxOrCurrencyMismatch = allRows.some(
        (entry) => entry.fxContext !== undefined || entry.currency.toUpperCase() !== currency,
      );
      if (hasFxOrCurrencyMismatch) {
        throw new Error(
          `Cannot rebuild subscription ${subscriptionId} after invoice ${invoice.id}: ` +
            `FX-bearing or mixed-currency recognition rows require an operator correction`,
        );
      }

      const sortedPending = [...pendingRecognition].sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.sourceObjectId ?? '').localeCompare(b.sourceObjectId ?? '');
      });
      const remainingDates = [...new Set(sortedPending.map((entry) => entry.date))];
      const addedDeferred = newSchedule.entries.reduce(
        (sum, entry) => sum + recognitionAmount(entry),
        0,
      );
      const count = remainingDates.length;
      const base = Math.floor(addedDeferred / count);
      const remainder = addedDeferred - base * count;

      const addedEntries: JournalEntry[] = remainingDates.map((date, index) => {
        const amount = cents(index === count - 1 ? base + remainder : base);
        const entry: JournalEntry = {
          date,
          currency,
          memo: `${invoice.id} — mid-term change recognition ${String(index + 1)}/${String(count)}`,
          sourceEventId: event.id,
          sourceEventType: event.type,
          sourceObjectId: invoice.id,
          lines: sortLines([
            {
              accountCode: '2100',
              side: 'debit',
              amount,
              memo: 'Recognize from deferred',
            },
            {
              accountCode: '4000',
              side: 'credit',
              amount,
              memo: 'Subscription revenue',
            },
          ]),
        };
        assertBalanced(entry);
        return entry;
      });

      const entries = [...sortedPending, ...addedEntries].sort((a, b) => {
        if (a.date !== b.date) return a.date < b.date ? -1 : 1;
        return (a.sourceObjectId ?? '').localeCompare(b.sourceObjectId ?? '');
      });

      return {
        cancelExisting: true,
        schedule: {
          subscriptionId,
          sourceEventId: event.id,
          entries,
        },
      };
    },
  };
}

/**
 * Route only a real accounting event: a paid subscription-update invoice with
 * proration lines whose mapped result contains deferred revenue. Plain
 * `customer.subscription.updated` notifications remain informational because
 * they can be metadata-only or configured with no proration.
 */
export function subscriptionChangeNeedsReconcile(
  event: Stripe.Event,
  result: MapResult,
): boolean {
  if (event.type !== 'invoice.payment_succeeded') return false;
  const invoice = event.data.object;
  return (
    invoice.billing_reason === 'subscription_update' &&
    invoice.lines.data.some((line) => line.proration) &&
    result.schedule !== null &&
    result.schedule.entries.length > 0
  );
}
