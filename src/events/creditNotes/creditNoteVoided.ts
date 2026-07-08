import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { creditNoteMemo } from '../../util/memo.js';
import { prepaymentCreditAmounts } from './shared.js';

/**
 * `credit_note.voided` — a credit note issued in error is voided. Whatever
 * `credit_note.created` posted must be undone.
 *
 * The reversal mirrors the creation entry with the sides flipped: a pre-payment
 * credit note reduced the receivable and reversed revenue/tax, so voiding it
 * restores them:
 *
 *   Dr 1100 Accounts Receivable    (credit note total — receivable restored)
 *   Cr 4000 Subscription Revenue   (credit note subtotal)
 *   Cr 2000 Sales Tax Payable      (credit note tax)
 *
 * Cases `credit_note.created` acknowledged with no entry (post-payment,
 * `charge_automatically`, a deferred-schedule invoice, zero total) posted
 * nothing, so voiding them is a no-op too. Both handlers gate on the same
 * {@link prepaymentCreditAmounts}, so the void un-books exactly what creation
 * booked — no more, no less.
 */
export function handleCreditNoteVoided(event: Stripe.Event): MapResult {
  if (event.type !== 'credit_note.voided') {
    throw new Error(`handleCreditNoteVoided received wrong event type: ${event.type}`);
  }
  const creditNote = event.data.object;

  const invoice = requireExpanded<Stripe.Invoice>(
    creditNote.invoice,
    'credit_note.invoice',
    event.id,
  );
  const amounts = prepaymentCreditAmounts(creditNote, invoice);
  if (amounts === null) {
    return { entries: [], schedule: null };
  }
  const { total, subtotal, tax } = amounts;

  const draft: JournalLine[] = [
    {
      accountCode: '1100',
      side: 'debit',
      amount: cents(total),
      memo: 'Receivable restored — credit note voided',
    },
  ];
  if (subtotal > 0) {
    draft.push({
      accountCode: '4000',
      side: 'credit',
      amount: cents(subtotal),
      memo: 'Revenue restored — credit note voided',
    });
  }
  if (tax > 0) {
    draft.push({
      accountCode: '2000',
      side: 'credit',
      amount: cents(tax),
      memo: 'Sales tax restored — credit note voided',
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
