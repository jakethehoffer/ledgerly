import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { invoiceMemo } from '../../util/memo.js';
import { computeFinalizationSplit } from './recognition.js';

/**
 * True when voiding this invoice would need the stateful reversal the pure
 * engine can't do: a net-terms invoice whose finalization deferred part of the
 * revenue to 2100 and built a recognition schedule. The gate is finalization's
 * own `deferredPreTax > 0` test, so it flags exactly the invoices for which a
 * schedule exists. A server with ledger access (see `voidReconciler`) handles
 * this case; the pure `handleInvoiceVoided` below refuses it.
 *
 * Invoices the void handler no-ops or throws on for other reasons
 * (`charge_automatically`, zero amount, paginated lines) are not "deferred
 * schedule" cases and return `false`.
 */
export function voidHasDeferredSchedule(invoice: Stripe.Invoice): boolean {
  if (invoice.collection_method !== 'send_invoice') return false;
  if (invoice.amount_due === 0) return false;
  if (invoice.lines.has_more) return false;
  return computeFinalizationSplit(invoice).deferredPreTax > 0;
}

/**
 * `invoice.voided` — a finalized (open) invoice cancelled as if it were never
 * issued. This is the opposite of `invoice.marked_uncollectible`: a write-off
 * keeps the revenue (you earned it, the customer just didn't pay), whereas a
 * void *reverses* it (the invoice was a mistake — no sale happened).
 *
 * Only `send_invoice` (B2B) invoices booked anything at `invoice.finalized`
 * (against 1100 Accounts Receivable). A `charge_automatically` invoice books its
 * revenue at payment, and Stripe only voids an *open, unpaid* invoice, so such an
 * invoice never posted anything to reverse — acknowledge with no entry.
 *
 * For a net-terms invoice with **no deferred portion** (every line is earned now,
 * so finalization built no recognition schedule), the void is the exact inverse
 * of the finalization entry:
 *
 *   Cr 1100 Accounts Receivable   (clear the receivable — a voided invoice is unpaid)
 *   Dr 4000 Subscription Revenue  (reverse the recognized revenue)
 *   Dr 2000 Sales Tax Payable     (reverse the tax — no sale, nothing owed)
 *
 * Because a voided invoice is always unpaid, 1100 still carries the full gross
 * from finalization, so reversing it against the same gross zeroes every account
 * the invoice touched.
 *
 * A net-terms invoice **with** a deferred portion is refused. Finalization
 * deferred that portion to 2100 and built a monthly recognition schedule; by the
 * time a void arrives, some of that schedule may already have recognized (moving
 * 2100 → 4000) and the unposted remainder still needs cancelling. A correct
 * reversal therefore depends on how much has recognized so far and on cancelling
 * future schedule entries — stateful facts a pure per-event engine doesn't have.
 * We throw rather than mis-post, exactly as the cross-currency B2B payment path
 * does for a case it can't model. The gate mirrors finalization's own
 * `deferredPreTax > 0` test, so it refuses exactly the invoices for which a
 * schedule was built.
 */
export function handleInvoiceVoided(event: Stripe.Event): MapResult {
  if (event.type !== 'invoice.voided') {
    throw new Error(`handleInvoiceVoided received wrong event type: ${event.type}`);
  }
  const invoice = event.data.object;

  if (invoice.collection_method !== 'send_invoice') {
    return { entries: [], schedule: null };
  }
  const gross = invoice.amount_due;
  if (gross === 0) {
    return { entries: [], schedule: null };
  }
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }

  // Reconstruct finalization's immediate/deferred split (same shared helper) so
  // the refusal gate lines up exactly with whether finalization built a schedule.
  const { taxAmt, immediatePreTax, deferredPreTax } = computeFinalizationSplit(invoice);

  if (deferredPreTax > 0) {
    throw new Error(
      `Voiding net-terms invoice ${invoice.id} is not supported: it carries a ` +
        `deferred-revenue schedule (part of the invoice defers to 2100 and ` +
        `recognizes monthly). Reversing a void correctly requires knowing how ` +
        `much has already recognized and cancelling the unposted schedule — ` +
        `stateful facts this engine doesn't track.`,
    );
  }

  const draft: JournalLine[] = [
    {
      accountCode: '1100',
      side: 'credit',
      amount: cents(gross),
      memo: 'Receivable reversed — invoice voided',
    },
    {
      accountCode: '4000',
      side: 'debit',
      amount: cents(immediatePreTax),
      memo: 'Revenue reversed — invoice voided',
    },
  ];
  if (taxAmt > 0) {
    draft.push({
      accountCode: '2000',
      side: 'debit',
      amount: cents(taxAmt),
      memo: 'Sales tax reversed — invoice voided',
    });
  }

  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency: invoice.currency.toUpperCase(),
    memo: invoiceMemo(invoice),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: invoice.id,
    lines: sortLines(draft),
  };

  return { entries: [entry], schedule: null };
}
