import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult, RecognitionSchedule } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { invoiceMemo } from '../../util/memo.js';
import { buildRecognitionSchedule, computeFinalizationSplit, periodMonths } from './recognition.js';

/**
 * `invoice.finalized` — the point a draft invoice becomes an open (issued)
 * invoice.
 *
 * Only **net-terms** invoices (`collection_method === 'send_invoice'`, the B2B
 * "invoice now, pay later" flow) do accounting work here: revenue is earned when
 * the invoice is issued, and you now hold a receivable. We book the revenue
 * against **1100 Accounts Receivable** — recognizing immediately-earned lines to
 * 4000, deferring longer-term lines to 2100 (with a recognition schedule), and
 * splitting out sales tax to 2000. The cash and Stripe fee arrive later on
 * `invoice.payment_succeeded`, which clears 1100 (see that handler's
 * send_invoice branch).
 *
 * `charge_automatically` invoices are paid on the spot, so their revenue is
 * booked at `invoice.payment_succeeded`; finalization is informational for them
 * and produces no entry.
 *
 * No charge or balance transaction exists yet (the invoice is unpaid), so every
 * amount posts in the invoice currency and there is no Stripe fee leg. FX (an
 * invoice billed in one currency but later settled in another) is not modeled on
 * this path yet — the payment handler refuses a send_invoice payment whose
 * settlement currency differs from the invoice currency rather than mixing
 * currencies across the two legs.
 */
export function handleInvoiceFinalized(event: Stripe.Event): MapResult {
  if (event.type !== 'invoice.finalized') {
    throw new Error(`handleInvoiceFinalized received wrong event type: ${event.type}`);
  }
  const invoice = event.data.object;

  if (invoice.collection_method !== 'send_invoice') {
    return { entries: [], schedule: null };
  }
  if (invoice.amount_due === 0) {
    return { entries: [], schedule: null };
  }
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }

  const currency = invoice.currency.toUpperCase();
  // Per-line recognition, identical basis to the payment path: a line spanning a
  // month or less is earned now (4000); a longer line is deferred (2100) and
  // recognized over its term. Split preTax by the immediate share of the pre-tax
  // line total so the credits sum back to preTax exactly. `invoice.voided`
  // reverses this same split, so the arithmetic lives in one shared helper.
  const { gross, taxAmt, immediatePreTax, deferredPreTax } = computeFinalizationSplit(invoice);

  const draft: JournalLine[] = [
    {
      accountCode: '1100',
      side: 'debit',
      amount: cents(gross),
      memo: 'Accounts receivable on finalized invoice',
    },
  ];
  if (immediatePreTax > 0) {
    draft.push({
      accountCode: '4000',
      side: 'credit',
      amount: cents(immediatePreTax),
      memo: 'Subscription revenue (recognized now)',
    });
  }
  if (deferredPreTax > 0) {
    draft.push({
      accountCode: '2100',
      side: 'credit',
      amount: cents(deferredPreTax),
      memo: 'Deferred subscription revenue',
    });
  }
  if (taxAmt > 0) {
    draft.push({
      accountCode: '2000',
      side: 'credit',
      amount: cents(taxAmt),
      memo: 'Sales tax collected',
    });
  }

  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency,
    memo: invoiceMemo(invoice),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: invoice.id,
    lines: sortLines(draft),
  };

  // The deferred portion recognizes over its term, independent of when the
  // customer pays. Same-currency (no BT at finalization), so no schedule FX
  // anchor. `periodMonths` is only reached when a deferred line exists, so its
  // span is positive and it won't throw.
  const schedule: RecognitionSchedule | null =
    deferredPreTax > 0
      ? buildRecognitionSchedule(event, invoice, cents(deferredPreTax), periodMonths(invoice), currency, undefined)
      : null;

  return { entries: [entry], schedule };
}
