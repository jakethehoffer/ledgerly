import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { invoiceMemo } from '../../util/memo.js';

/**
 * `invoice.marked_uncollectible` — a net-terms invoice the business has given up
 * collecting. The receivable becomes a bad debt.
 *
 * Only `send_invoice` (B2B) invoices booked a receivable in the first place (at
 * `invoice.finalized`, against 1100 Accounts Receivable). A
 * `charge_automatically` invoice never debited 1100, so there is nothing to
 * write off — acknowledge with no entry.
 *
 * For a net-terms invoice, write the receivable off to **6200 Bad Debt Expense**:
 *
 *   Dr 6200 Bad Debt Expense
 *   Cr 1100 Accounts Receivable
 *
 * Revenue already recognized stays recognized — under accrual accounting you
 * earned it when you delivered the service; the customer simply didn't pay, and
 * that shortfall is an expense, not a revenue reversal. This is stateless and
 * correct regardless of how much of a deferred invoice has been recognized so
 * far: 1100 carries the full gross from finalization until the invoice is paid
 * or written off (recognition moves 2100 → 4000 and never touches 1100), so the
 * write-off always clears exactly what was parked.
 *
 * (Voiding an invoice — `invoice.voided` — is different: it *reverses* the
 * revenue too, which collides with the recognition schedule, and is not modeled
 * here yet.)
 */
export function handleInvoiceMarkedUncollectible(event: Stripe.Event): MapResult {
  if (event.type !== 'invoice.marked_uncollectible') {
    throw new Error(
      `handleInvoiceMarkedUncollectible received wrong event type: ${event.type}`,
    );
  }
  const invoice = event.data.object;

  if (invoice.collection_method !== 'send_invoice') {
    return { entries: [], schedule: null };
  }
  const gross = invoice.total;
  if (gross === 0) {
    return { entries: [], schedule: null };
  }

  const amount = cents(gross);
  const lines: ReadonlyArray<JournalLine> = sortLines([
    { accountCode: '6200', side: 'debit',  amount, memo: 'Bad debt — receivable written off' },
    { accountCode: '1100', side: 'credit', amount, memo: 'Uncollectible receivable' },
  ]);

  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency: invoice.currency.toUpperCase(),
    memo: invoiceMemo(invoice),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: invoice.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
