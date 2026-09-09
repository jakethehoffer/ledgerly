import type Stripe from 'stripe';
import { cents } from '../money.js';
import { assertBalanced } from '../journal.js';
import type { JournalEntry, JournalLine, RecognitionSchedule } from '../journal.js';
import { requireExpanded } from '../errors.js';
import { sortLines } from '../util/lines.js';
import { handleChargeRefunded } from '../events/charges/chargeRefunded.js';
import { partitionLineAmounts, resolveSubscriptionId } from '../events/invoices/recognition.js';
import type { RefundReconcileInput } from './storage/types.js';
import { buildReducedSchedule, recognitionAmount } from './deferredSchedule.js';

/** The 4900 debit an engine-built refund entry books as contra-revenue. */
function contraRevenueAmount(entry: JournalEntry): number {
  let total = 0;
  for (const line of entry.lines) {
    if (line.accountCode === '4900' && line.side === 'debit') {
      total += line.amount;
    }
  }
  return total;
}

/**
 * Build the storage input that draws a deferred-schedule invoice's recognition
 * down when the charge that paid it is refunded.
 *
 * The stateless engine books every refund's revenue side to 4900 Refunds Issued.
 * That is right for revenue the ledger actually recognized, and wrong for money
 * returned against service not yet delivered: nothing was recognized, so there is
 * no revenue to reverse — the refund repays the 2100 Deferred Revenue liability
 * the payment created. Booking it to 4900 leaves 2100 standing as a phantom
 * liability and drives net revenue negative for a customer who was refunded
 * mid-term.
 *
 * With storage access the split is readable from the ledger, and follows the same
 * deferred-first rule as the credit-note draw-down (Decision 1):
 *
 *   remainingDeferred = Σ pending recognition amounts
 *   deferredRepaid    = min(refundRevenue, remainingDeferred)  → Dr 2100
 *   clawback          = refundRevenue − deferredRepaid          → Dr 4900 (only the
 *                                                                   excess over all
 *                                                                   remaining deferred)
 *
 * Everything else in the entry is the engine's and is left exactly as built: the
 * cash leg (1010), the proportional tax drain (2000), any realized FX gain or loss
 * (7000), the cumulative-basis rounding across a multi-refund charge, the memo and
 * the `fxContext` provenance. Only the classification of the revenue-side debit
 * changes, so the entry stays balanced by construction and every non-deferred
 * refund keeps booking byte-identically to today.
 *
 * The still-deferred remainder is re-spread over the pending months by
 * `buildReducedSchedule` and the storage layer cancels the old rows. When the
 * subscription has already ended, the storage layer re-holds the reissued rows
 * against the saved end date, so a refund after a cancellation closes the held
 * schedule out instead of resurrecting it.
 */
export function buildRefundReconcileInput(event: Stripe.Event): RefundReconcileInput {
  if (event.type !== 'charge.refunded') {
    throw new Error(`buildRefundReconcileInput received wrong event type: ${event.type}`);
  }
  const charge = event.data.object;
  const invoice = requireExpanded<Stripe.Invoice>(charge.invoice, 'charge.invoice', event.id);
  const subscriptionId = resolveSubscriptionId(invoice);

  return {
    subscriptionId,
    invoiceId: invoice.id,
    build(
      posted,
      pending,
    ): { reversals: ReadonlyArray<JournalEntry>; reducedSchedule: RecognitionSchedule | null } {
      // The engine owns the whole refund calculation — amounts, tax share, FX,
      // and the cumulative basis across every refund on this charge. We only
      // reclassify its revenue-side debit.
      const engine = handleChargeRefunded(event);
      if (engine.entries.length === 0) {
        return { reversals: [], reducedSchedule: null };
      }

      // Both sides of the draw-down must be in the same currency to be
      // subtractable. Recognition rows are booked in the settlement currency of
      // the paying charge, and so is the engine's 4900 debit (it posts at the
      // original charge rate), so an FX refund is sound here — unlike the
      // credit-note draw-down, which subtracts a customer-currency credit and is
      // refused under FX. A genuine mismatch means the schedule and the refund
      // do not describe the same money, so refuse rather than guess.
      const scheduleCurrencies = new Set(
        [...posted, ...pending].map((row) => row.currency.toUpperCase()),
      );
      for (const entry of engine.entries) {
        const entryCurrency = entry.currency.toUpperCase();
        for (const scheduleCurrency of scheduleCurrencies) {
          if (scheduleCurrency !== entryCurrency) {
            throw new Error(
              `Deferred refund reconciliation for invoice ${invoice.id} involves a ` +
                `recognition schedule in ${scheduleCurrency} but a refund settling in ` +
                `${entryCurrency}; cross-currency deferred refunds are not supported.`,
            );
          }
        }
      }

      let remainingDeferred = pending.reduce((sum, e) => sum + recognitionAmount(e), 0);
      const reversals = engine.entries.map((entry) => {
        const refundRevenue = contraRevenueAmount(entry);
        const deferredRepaid = Math.min(refundRevenue, remainingDeferred);
        if (deferredRepaid === 0) return entry; // nothing deferred left to repay
        remainingDeferred -= deferredRepaid;
        const clawback = refundRevenue - deferredRepaid;

        const draft: JournalLine[] = entry.lines.filter(
          (line) => !(line.accountCode === '4900' && line.side === 'debit'),
        );
        if (clawback > 0) {
          draft.push({
            accountCode: '4900',
            side: 'debit',
            amount: cents(clawback),
            memo: 'Refund issued',
          });
        }
        draft.push({
          accountCode: '2100',
          side: 'debit',
          amount: cents(deferredRepaid),
          memo: 'Deferred revenue repaid — refund',
        });
        const reclassified: JournalEntry = { ...entry, lines: sortLines(draft) };
        assertBalanced(reclassified);
        return reclassified;
      });

      const reducedSchedule = buildReducedSchedule(pending, remainingDeferred, {
        subscriptionId,
        sourceEventId: event.id,
        sourceEventType: event.type,
        invoiceId: invoice.id,
        currency: engine.entries[0]?.currency ?? invoice.currency.toUpperCase(),
      });

      return { reversals, reducedSchedule };
    },
  };
}

/**
 * True when the server should route this `charge.refunded` event to the refund
 * reconciler instead of `mapEvent`: the refunded charge paid an invoice that
 * deferred revenue, so the ledger may still hold an unrecognized balance the
 * refund has to repay.
 *
 * This is a shape gate on the Stripe object, exactly like `voidHasDeferredSchedule`
 * and `creditNoteHasDeferredSchedule`. Whether anything is actually still deferred
 * is decided by the ledger read inside `build`, which degrades to the engine's own
 * entries when the schedule is fully recognized or absent.
 */
export function refundNeedsReconcile(event: Stripe.Event): boolean {
  if (event.type !== 'charge.refunded') return false;
  const invoice = event.data.object.invoice;
  if (!invoice || typeof invoice !== 'object') return false;
  // A paginated line list can't be classified; the engine throws on it anyway,
  // so let that refusal happen on the normal path rather than here.
  if (invoice.lines.has_more) return false;
  return partitionLineAmounts(invoice).deferredCustomer > 0;
}
