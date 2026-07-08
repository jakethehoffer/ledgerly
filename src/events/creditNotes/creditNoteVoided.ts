import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { creditNoteMemo } from '../../util/memo.js';
import { balanceCreditAmounts, prepaymentCreditAmounts } from './shared.js';

/**
 * `credit_note.voided` — a credit note issued in error is voided. Whatever
 * `credit_note.created` posted must be undone, with the sides flipped.
 *
 * A **pre-payment** credit note reduced the receivable and reversed
 * revenue/tax, so voiding it restores them:
 *
 *   Dr 1100 Accounts Receivable    (credit note total — receivable restored)
 *   Cr 4000 Subscription Revenue   (credit note subtotal)
 *   Cr 2000 Sales Tax Payable      (credit note tax)
 *
 * A **post-payment credit-to-balance** credit note reversed revenue/tax and
 * booked the customer-credit liability, so voiding it drains the liability and
 * restores the revenue:
 *
 *   Dr 2200 Customer Credit Balance  (credit note total — credit clawed back)
 *   Cr 4000 Subscription Revenue     (credit note subtotal)
 *   Cr 2000 Sales Tax Payable        (credit note tax)
 *
 * Cases `credit_note.created` acknowledged with no entry (refund-backed
 * post-payment, a `charge_automatically` pre-payment, a deferred-schedule
 * invoice, zero total) posted nothing, so voiding them is a no-op too. Both
 * handlers gate on the same {@link prepaymentCreditAmounts} /
 * {@link balanceCreditAmounts}, so the void un-books exactly what creation
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

  const prepayment = prepaymentCreditAmounts(creditNote, invoice);
  if (prepayment !== null) {
    const { total, subtotal, tax } = prepayment;
    const draft: JournalLine[] = [
      { accountCode: '1100', side: 'debit', amount: cents(total), memo: 'Receivable restored — credit note voided' },
    ];
    if (subtotal > 0) {
      draft.push({ accountCode: '4000', side: 'credit', amount: cents(subtotal), memo: 'Revenue restored — credit note voided' });
    }
    if (tax > 0) {
      draft.push({ accountCode: '2000', side: 'credit', amount: cents(tax), memo: 'Sales tax restored — credit note voided' });
    }
    return { entries: [buildVoidEntry(event, creditNote, draft)], schedule: null };
  }

  const balance = balanceCreditAmounts(creditNote, invoice);
  if (balance !== null) {
    const { total, subtotal, tax } = balance;
    const draft: JournalLine[] = [
      { accountCode: '2200', side: 'debit', amount: cents(total), memo: 'Customer credit balance reversed — credit note voided' },
    ];
    if (subtotal > 0) {
      draft.push({ accountCode: '4000', side: 'credit', amount: cents(subtotal), memo: 'Revenue restored — credit note voided' });
    }
    if (tax > 0) {
      draft.push({ accountCode: '2000', side: 'credit', amount: cents(tax), memo: 'Sales tax restored — credit note voided' });
    }
    return { entries: [buildVoidEntry(event, creditNote, draft)], schedule: null };
  }

  return { entries: [], schedule: null };
}

function buildVoidEntry(
  event: Stripe.Event,
  creditNote: Stripe.CreditNote,
  draft: ReadonlyArray<JournalLine>,
): JournalEntry {
  return {
    date: epochToUtcDate(event.created),
    currency: creditNote.currency.toUpperCase(),
    memo: creditNoteMemo(creditNote),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: creditNote.id,
    lines: sortLines(draft),
  };
}
