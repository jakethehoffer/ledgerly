import type Stripe from 'stripe';
import { cents } from '../money.js';
import { assertBalanced } from '../journal.js';
import type { JournalEntry, JournalLine, RecognitionSchedule } from '../journal.js';
import { requireExpanded } from '../errors.js';
import { epochToUtcDate } from '../util/dates.js';
import { sortLines } from '../util/lines.js';
import { creditNoteMemo } from '../util/memo.js';
import { resolveSubscriptionId } from '../events/invoices/recognition.js';
import {
  creditNoteFundingAccount,
  creditNoteHasDeferredSchedule,
} from '../events/creditNotes/shared.js';
import type { CreditReconcileInput } from './storage/types.js';

/**
 * The revenue a single recognition row moves out of deferred (2100) into
 * recognized (4000) — its 4000 credit. Summed over posted rows it is how much of
 * the schedule has recognized; over pending rows it is how much is still deferred.
 */
function recognitionAmount(entry: JournalEntry): number {
  let total = 0;
  for (const line of entry.lines) {
    if (line.accountCode === '4000' && line.side === 'credit') {
      total += line.amount;
    }
  }
  return total;
}

/**
 * Reissue `newDeferred` cents across the still-pending recognition dates
 * (Decision 2 — even re-spread), floor + remainder with the last month absorbing
 * the remainder, exactly like `buildRecognitionSchedule`. Each reissued row keeps
 * its pending row's date and memo (same service month, reduced amount) and carries
 * `sourceObjectId = invoiceId` so a later credit or void against the same invoice
 * still finds it. Returns `null` when nothing remains deferred or there are no
 * pending months (a full draw-down, or an already fully-recognized invoice).
 */
function buildReducedSchedule(
  pending: ReadonlyArray<JournalEntry>,
  newDeferred: number,
  meta: {
    subscriptionId: string;
    sourceEventId: string;
    sourceEventType: string;
    invoiceId: string;
    currency: string;
  },
): RecognitionSchedule | null {
  if (pending.length === 0 || newDeferred <= 0) return null;
  const sorted = [...pending].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const n = sorted.length;
  const base = Math.floor(newDeferred / n);
  const remainder = newDeferred - base * n;
  const entries: JournalEntry[] = sorted.map((row, i) => {
    const amount = cents(i === n - 1 ? base + remainder : base);
    return {
      date: row.date,
      currency: meta.currency,
      memo: row.memo,
      sourceEventId: meta.sourceEventId,
      sourceEventType: meta.sourceEventType,
      sourceObjectId: meta.invoiceId,
      lines: sortLines([
        { accountCode: '2100', side: 'debit', amount, memo: 'Recognize from deferred' },
        { accountCode: '4000', side: 'credit', amount, memo: 'Subscription revenue' },
      ]),
    };
  });
  return { subscriptionId: meta.subscriptionId, sourceEventId: meta.sourceEventId, entries };
}

/**
 * Build the storage input that draws a deferred-schedule invoice's recognition
 * down when a credit note is issued against it.
 *
 * The pure engine refuses this case (see `handleCreditNoteCreated`) because a
 * correct reversal depends on how much of the schedule has already recognized and
 * needs the future schedule reduced — stateful facts only the ledger holds. Here,
 * with storage access, the draw-down reads those facts from the schedule rows and
 * (Decision 1 — deferred-first) reduces the still-deferred balance before ever
 * clawing back recognized revenue:
 *
 *   remainingDeferred = Σ pending recognition amounts
 *   deferredReduction = min(creditSubtotal, remainingDeferred)   → Dr 2100
 *   clawback          = creditSubtotal − deferredReduction        → Dr 4000 (only if
 *                                                                    the credit exceeds
 *                                                                    all remaining deferred)
 *
 * The immediate reversal credits the receivable (1100, pre-payment) or the
 * customer balance (2200, post-payment-to-balance), reverses the tax (Dr 2000),
 * and always balances (debits sum to the credit total). The still-deferred
 * remainder is re-spread over the pending months by `buildReducedSchedule`, and
 * the storage layer cancels the old pending rows.
 */
export function buildCreditReconcileInput(event: Stripe.Event): CreditReconcileInput {
  if (event.type !== 'credit_note.created') {
    throw new Error(`buildCreditReconcileInput received wrong event type: ${event.type}`);
  }
  const creditNote = event.data.object;
  const invoice = requireExpanded<Stripe.Invoice>(
    creditNote.invoice,
    'credit_note.invoice',
    event.id,
  );

  const subtotal = creditNote.subtotal; // pre-tax credit (C)
  const total = creditNote.total;
  const tax = total - subtotal; // T
  const fundingAccount = creditNoteFundingAccount(creditNote);
  const fundingMemo =
    fundingAccount === '2200'
      ? 'Customer credit balance issued'
      : 'Receivable reduced — credit note';
  const currency = creditNote.currency.toUpperCase();
  const date = epochToUtcDate(event.created);
  const memo = creditNoteMemo(creditNote);
  const subscriptionId = resolveSubscriptionId(invoice);

  return {
    subscriptionId,
    invoiceId: invoice.id,
    build(posted, pending): { reversal: JournalEntry; reducedSchedule: RecognitionSchedule | null } {
      // FX-bearing draw-downs are out of scope (Decision 5): the ledger-driven
      // arithmetic subtracts a customer-currency credit from settlement-currency
      // schedule rows, sound only when the two currencies match. Refuse loudly
      // otherwise, like the engine's other FX refusals.
      for (const row of [...posted, ...pending]) {
        if (row.fxContext || row.currency.toUpperCase() !== currency) {
          throw new Error(
            `Deferred credit reconciliation for invoice ${invoice.id} involves an ` +
              `FX-bearing recognition schedule (schedule currency ` +
              `${row.currency.toUpperCase()} vs credit ${currency}); cross-currency ` +
              `deferred credits are not yet supported.`,
          );
        }
      }

      const remainingDeferred = pending.reduce((sum, e) => sum + recognitionAmount(e), 0);
      const deferredReduction = Math.min(subtotal, remainingDeferred);
      const clawback = subtotal - deferredReduction;
      const newDeferred = remainingDeferred - deferredReduction;

      const draft: JournalLine[] = [
        { accountCode: fundingAccount, side: 'credit', amount: cents(total), memo: fundingMemo },
      ];
      if (clawback > 0) {
        draft.push({
          accountCode: '4000',
          side: 'debit',
          amount: cents(clawback),
          memo: 'Revenue reversed — credit note',
        });
      }
      if (deferredReduction > 0) {
        draft.push({
          accountCode: '2100',
          side: 'debit',
          amount: cents(deferredReduction),
          memo: 'Deferred revenue reversed — credit note',
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
      const reversal: JournalEntry = {
        date,
        currency,
        memo,
        sourceEventId: event.id,
        sourceEventType: event.type,
        sourceObjectId: creditNote.id,
        lines: sortLines(draft),
      };
      assertBalanced(reversal);

      const reducedSchedule = buildReducedSchedule(pending, newDeferred, {
        subscriptionId,
        sourceEventId: event.id,
        sourceEventType: event.type,
        invoiceId: invoice.id,
        currency,
      });

      return { reversal, reducedSchedule };
    },
  };
}

/**
 * True when the server should route this `credit_note.created` event to the
 * credit reconciler instead of `mapEvent`: an **issued** credit note that ledgerly
 * books, whose invoice deferred revenue to a recognition schedule. Mirrors how the
 * receiver gates `invoice.voided` on `voidHasDeferredSchedule`.
 */
export function creditNoteNeedsReconcile(event: Stripe.Event): boolean {
  if (event.type !== 'credit_note.created') return false;
  const creditNote = event.data.object;
  if (creditNote.status !== 'issued') return false;
  const invoice = requireExpanded<Stripe.Invoice>(
    creditNote.invoice,
    'credit_note.invoice',
    event.id,
  );
  return creditNoteHasDeferredSchedule(creditNote, invoice);
}
