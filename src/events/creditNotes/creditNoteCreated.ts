import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { creditNoteMemo } from '../../util/memo.js';
import {
  balanceCreditAmounts,
  creditNoteHasDeferredSchedule,
  prepaymentCreditAmounts,
} from './shared.js';

/**
 * `credit_note.created` — a credit note adjusts an invoice after it was issued.
 * Two shapes do accounting work; everything else is acknowledged with no entry.
 *
 * **Pre-payment credit note against a net-terms (`send_invoice`) invoice.** A
 * `send_invoice` invoice booked a receivable at `invoice.finalized` (Dr 1100); a
 * `pre_payment` credit note reduces what the customer still owes, so it reverses
 * that slice of the invoice:
 *
 *   Dr 4000 Subscription Revenue   (credit note subtotal — revenue not earned)
 *   Dr 2000 Sales Tax Payable      (credit note tax — less tax owed)
 *   Cr 1100 Accounts Receivable    (credit note total — receivable reduced)
 *
 * **Post-payment credit note credited entirely to the customer's balance.** The
 * invoice was already paid (revenue recognized, cash in). Returning the money as
 * account credit rather than a cash refund reverses the revenue and books the
 * liability; the cash already received stays put:
 *
 *   Dr 4000 Subscription Revenue      (credit note subtotal)
 *   Dr 2000 Sales Tax Payable         (credit note tax)
 *   Cr 2200 Customer Credit Balance   (credit note total — owed as future credit)
 *
 * The credit note carries `subtotal` (pre-tax) and `total` (with tax) directly,
 * so both reversals are exact and partial credits need no proportioning here.
 *
 * Everything else is acknowledged with no entry, because a stateless per-event
 * engine can't book it correctly (and a throw would 500-loop a legitimate
 * webhook):
 *
 *   - a **refund-backed** post-payment credit note: the cash returned is booked
 *     by `charge.refunded`, not here.
 *   - a **`charge_automatically`** invoice's *pre-payment* credit note: it never
 *     debited 1100, so there is no receivable to reduce.
 *   - a voided credit note (`status !== 'issued'`) or a zero-total one.
 *
 * One bookable shape is **refused** rather than no-op'd: a pre-payment or
 * post-payment-to-balance credit note against an invoice that **deferred**
 * revenue to a recognition schedule. Reversing it correctly needs to draw the
 * schedule down proportionally (how much has recognized, which future months to
 * reduce) — the stateful problem `invoice.voided` solves in the server. The pure
 * engine throws (like a deferred void); the bundled receiver routes it to the
 * credit reconciler before mapEvent.
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

  // A bookable credit note against a deferred-schedule invoice is refused here,
  // exactly as a deferred invoice.voided is: reversing revenue that partly sits
  // in 2100 needs the stateful schedule draw-down a per-event engine can't do.
  // The bundled receiver routes this to the credit reconciler before mapEvent,
  // so this throw is only reached by a direct-engine caller (no ledger).
  if (creditNoteHasDeferredSchedule(creditNote, invoice)) {
    throw new Error(
      `Crediting deferred invoice ${invoice.id} is not supported by the pure ` +
        `engine: reversing revenue that partly sits in 2100 on a recognition ` +
        `schedule needs a proportional draw-down (how much has recognized, which ` +
        `months to reduce) — stateful facts a per-event engine doesn't track. The ` +
        `bundled receiver reconciles it against the ledger, like a deferred ` +
        `invoice.voided.`,
    );
  }

  const prepayment = prepaymentCreditAmounts(creditNote, invoice);
  if (prepayment !== null) {
    const { total, subtotal, tax } = prepayment;
    const draft: JournalLine[] = [
      { accountCode: '1100', side: 'credit', amount: cents(total), memo: 'Receivable reduced — credit note' },
    ];
    if (subtotal > 0) {
      draft.push({ accountCode: '4000', side: 'debit', amount: cents(subtotal), memo: 'Revenue reversed — credit note' });
    }
    if (tax > 0) {
      draft.push({ accountCode: '2000', side: 'debit', amount: cents(tax), memo: 'Sales tax reversed — credit note' });
    }
    return { entries: [buildCreditNoteEntry(event, creditNote, draft)], schedule: null };
  }

  const balance = balanceCreditAmounts(creditNote, invoice);
  if (balance !== null) {
    const { total, subtotal, tax } = balance;
    const draft: JournalLine[] = [
      { accountCode: '2200', side: 'credit', amount: cents(total), memo: 'Customer credit balance issued' },
    ];
    if (subtotal > 0) {
      draft.push({ accountCode: '4000', side: 'debit', amount: cents(subtotal), memo: 'Revenue reversed — credited to balance' });
    }
    if (tax > 0) {
      draft.push({ accountCode: '2000', side: 'debit', amount: cents(tax), memo: 'Sales tax reversed — credited to balance' });
    }
    return { entries: [buildCreditNoteEntry(event, creditNote, draft)], schedule: null };
  }

  return { entries: [], schedule: null };
}

function buildCreditNoteEntry(
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
