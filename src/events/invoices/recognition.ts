import type Stripe from 'stripe';
import { cents, type Cents } from '../../money.js';
import type { FxContext, JournalEntry, RecognitionSchedule } from '../../journal.js';
import { epochToUtcDate, addMonths } from '../../util/dates.js';
import { withFx } from '../../util/fxContext.js';
import { sortLines } from '../../util/lines.js';
import { invoiceMemo } from '../../util/memo.js';

/**
 * Revenue-recognition helpers shared by the two invoice handlers:
 *
 *   - `invoice.payment_succeeded` (charge_automatically) recognizes revenue when
 *     the card is charged.
 *   - `invoice.finalized` (send_invoice / B2B net-terms) recognizes revenue when
 *     the invoice is issued, against Accounts Receivable.
 *
 * Both classify each line item by its own billing span and build the same
 * monthly deferred-revenue schedule, so the term/partition/schedule logic lives
 * here rather than being duplicated (or drifting) between them.
 */

export const SECONDS_PER_DAY = 86400;
export const MONTHLY_THRESHOLD_DAYS = 32;

export function periodSpanDays(invoice: Stripe.Invoice): number {
  let maxSpan = 0;
  for (const line of invoice.lines.data) {
    const span = (line.period.end - line.period.start) / SECONDS_PER_DAY;
    if (span > maxSpan) maxSpan = span;
  }
  if (maxSpan === 0) {
    throw new Error(
      `Invoice ${invoice.id} has no line-item periods; cannot classify subscription term`,
    );
  }
  return maxSpan;
}

export function periodMonths(invoice: Stripe.Invoice): number {
  // Approximate months by dividing the longest period span. 12 for annual, 1 for monthly.
  const days = periodSpanDays(invoice);
  return Math.max(1, Math.round(days / 30));
}

/**
 * Sum the invoice's line-item amounts (customer currency, pre-tax) into the
 * portion earned immediately vs. the portion deferred, classifying each line by
 * its OWN billing span. A line spanning a month or less (including a one-time
 * item with an instant period) is immediate; a longer line is deferred over its
 * term. Line amounts are pre-tax, so the two sums add up to the invoice's
 * pre-tax subtotal — the basis for splitting settlement-currency pre-tax
 * revenue between recognize-now (4000) and defer (2100).
 */
export function partitionLineAmounts(invoice: Stripe.Invoice): {
  immediateCustomer: number;
  deferredCustomer: number;
} {
  let immediateCustomer = 0;
  let deferredCustomer = 0;
  for (const line of invoice.lines.data) {
    const span = (line.period.end - line.period.start) / SECONDS_PER_DAY;
    if (span > MONTHLY_THRESHOLD_DAYS) {
      deferredCustomer += line.amount;
    } else {
      immediateCustomer += line.amount;
    }
  }
  return { immediateCustomer, deferredCustomer };
}

/**
 * The finalization revenue split for a net-terms invoice, shared by
 * `invoice.finalized` (which books it) and `invoice.voided` (which reverses it).
 *
 * `gross` is the invoice's `amount_due` — what finalization debited to 1100.
 * `taxAmt` is held in 2000, and the remaining `preTax` is split between the
 * portion earned now (`immediatePreTax` → 4000) and the portion deferred
 * (`deferredPreTax` → 2100, recognized monthly). The split classifies each line
 * by its own billing span, then apportions `preTax` by the immediate share of
 * the pre-tax line total so the two sums add back to `preTax` exactly.
 *
 * A positive `deferredPreTax` is exactly the condition under which finalization
 * builds a recognition schedule — so it doubles as the "does a schedule exist?"
 * test the void path needs.
 */
export interface FinalizationSplit {
  readonly gross: number;
  readonly taxAmt: number;
  readonly preTax: number;
  readonly immediatePreTax: number;
  readonly deferredPreTax: number;
}

export function computeFinalizationSplit(invoice: Stripe.Invoice): FinalizationSplit {
  const gross = invoice.amount_due;
  const invoiceTax = invoice.tax ?? 0;
  const taxAmt = invoiceTax > 0 ? invoiceTax : 0;
  const preTax = gross - taxAmt;

  const { immediateCustomer, deferredCustomer } = partitionLineAmounts(invoice);
  const lineTotal = immediateCustomer + deferredCustomer;
  const immediatePreTax =
    lineTotal > 0 ? Math.round((preTax * immediateCustomer) / lineTotal) : preTax;
  const deferredPreTax = preTax - immediatePreTax;

  return { gross, taxAmt, preTax, immediatePreTax, deferredPreTax };
}

export function resolveSubscriptionId(invoice: Stripe.Invoice): string {
  if (typeof invoice.subscription === 'string') {
    return invoice.subscription;
  }
  if (invoice.subscription && typeof invoice.subscription === 'object') {
    return invoice.subscription.id;
  }
  return `invoice:${invoice.id}`;
}

export function buildRecognitionSchedule(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  months: number,
  btCurrency: string,
  /**
   * Pro-rated fxContext anchor. When the invoice involved FX, the
   * schedule pro-rates both `customerAmount` and `settlementAmount` per
   * month, with month 12 absorbing the remainder so the per-month
   * customer-side sum equals `customerPreTax` and the settlement-side
   * sum equals `gross` exactly. When `undefined` (same-currency case),
   * the per-month entries get no fxContext.
   */
  scheduleFxAnchor: { customerCurrency: string; customerPreTax: number; settlementCurrency: string } | undefined,
): RecognitionSchedule {
  const subscriptionId = resolveSubscriptionId(invoice);

  const cashDate = epochToUtcDate(event.created);
  const baseAmount = Math.floor(gross / months);
  const remainder = gross - baseAmount * months;

  // Pro-rate the customer-side preTax with the same floor + remainder
  // pattern so per-month customer/settlement amounts line up at the
  // same indices and the schedule sums match both sides exactly.
  const customerBase = scheduleFxAnchor
    ? Math.floor(scheduleFxAnchor.customerPreTax / months)
    : 0;
  const customerRemainder = scheduleFxAnchor
    ? scheduleFxAnchor.customerPreTax - customerBase * months
    : 0;

  const entries: JournalEntry[] = [];
  for (let m = 1; m <= months; m++) {
    // Last entry absorbs the remainder so the schedule's sum equals gross exactly.
    const monthAmount = cents(m === months ? baseAmount + remainder : baseAmount);
    const monthCustomerAmount =
      m === months ? customerBase + customerRemainder : customerBase;
    const monthlyFxContext: FxContext | undefined = scheduleFxAnchor
      ? {
          customerCurrency: scheduleFxAnchor.customerCurrency.toUpperCase(),
          customerAmount: cents(monthCustomerAmount),
          settlementCurrency: scheduleFxAnchor.settlementCurrency.toUpperCase(),
          settlementAmount: monthAmount,
        }
      : undefined;
    entries.push(
      withFx(
        {
          date: addMonths(cashDate, m),
          currency: btCurrency,
          memo: `${invoiceMemo(invoice)} — month ${String(m)}/${String(months)} recognition`,
          sourceEventId: event.id,
          sourceEventType: event.type,
          sourceObjectId: invoice.id,
          lines: sortLines([
            { accountCode: '2100', side: 'debit',  amount: monthAmount, memo: 'Recognize from deferred' },
            { accountCode: '4000', side: 'credit', amount: monthAmount, memo: 'Subscription revenue' },
          ]),
        },
        monthlyFxContext,
      ),
    );
  }

  return {
    subscriptionId,
    sourceEventId: event.id,
    entries,
  };
}
