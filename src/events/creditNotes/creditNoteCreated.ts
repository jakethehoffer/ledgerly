import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { creditNoteMemo } from '../../util/memo.js';
import { partitionLineAmounts } from '../invoices/recognition.js';

/**
 * `credit_note.created` — a credit note adjusts an invoice after it was issued.
 *
 * Only **pre-payment** credit notes against a **net-terms** (`send_invoice`)
 * invoice do accounting work here. A `send_invoice` invoice booked a receivable
 * at `invoice.finalized` (Dr 1100); a `pre_payment` credit note reduces what the
 * customer still owes, so it reverses that slice of the invoice:
 *
 *   Dr 4000 Subscription Revenue   (credit note subtotal — revenue not earned)
 *   Dr 2000 Sales Tax Payable      (credit note tax — less tax owed)
 *   Cr 1100 Accounts Receivable    (credit note total — receivable reduced)
 *
 * The credit note carries `subtotal` (pre-tax) and `total` (with tax) directly,
 * so the reversal is exact and partial credits need no proportioning here.
 *
 * Everything else is acknowledged with no entry, because a stateless per-event
 * engine can't book it correctly (and a throw would 500-loop a legitimate
 * webhook):
 *
 *   - **post-payment** credit notes (the invoice was already paid): any cash
 *     returned via a Stripe refund is booked by `charge.refunded`; a credit to
 *     the customer's balance needs a customer-credit liability account that
 *     doesn't exist yet.
 *   - **`charge_automatically`** invoices never debited 1100, so there is no
 *     receivable to reduce.
 *   - a `pre_payment` credit note against an invoice that **deferred** revenue to
 *     a recognition schedule: reversing it correctly needs to draw down the
 *     schedule proportionally (how much has recognized, which future months to
 *     reduce) — the stateful problem `invoice.voided` solves in the server. Until
 *     a credit-note reconciler exists, booking only the immediate slice would be
 *     wrong, so this no-ops rather than mis-post.
 *   - a voided credit note (`status !== 'issued'`) or a zero-total one.
 */
export function handleCreditNoteCreated(event: Stripe.Event): MapResult {
  if (event.type !== 'credit_note.created') {
    throw new Error(`handleCreditNoteCreated received wrong event type: ${event.type}`);
  }
  const creditNote = event.data.object;

  if (creditNote.status !== 'issued') {
    return { entries: [], schedule: null };
  }
  const invoice = requireExpanded<Stripe.Invoice>(
    creditNote.invoice,
    'credit_note.invoice',
    event.id,
  );
  if (invoice.collection_method !== 'send_invoice') {
    return { entries: [], schedule: null };
  }
  if (creditNote.type === 'post_payment') {
    return { entries: [], schedule: null };
  }
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }
  // A deferred invoice's credit needs a proportional draw-down of its
  // recognition schedule (stateful) — not modeled here yet; see the doc comment.
  if (partitionLineAmounts(invoice).deferredCustomer > 0) {
    return { entries: [], schedule: null };
  }

  const total = creditNote.total;
  if (total === 0) {
    return { entries: [], schedule: null };
  }
  const subtotal = creditNote.subtotal;
  const tax = total - subtotal;

  const draft: JournalLine[] = [
    {
      accountCode: '1100',
      side: 'credit',
      amount: cents(total),
      memo: 'Receivable reduced — credit note',
    },
  ];
  if (subtotal > 0) {
    draft.push({
      accountCode: '4000',
      side: 'debit',
      amount: cents(subtotal),
      memo: 'Revenue reversed — credit note',
    });
  }
  if (tax > 0) {
    draft.push({
      accountCode: '2000',
      side: 'debit',
      amount: cents(tax),
      memo: 'Sales tax reversed — credit note',
    });
  }

  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency: creditNote.currency.toUpperCase(),
    memo: creditNoteMemo(creditNote),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: creditNote.id,
    lines: sortLines(draft),
  };

  return { entries: [entry], schedule: null };
}
