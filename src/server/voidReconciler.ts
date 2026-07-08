import type Stripe from 'stripe';
import { cents } from '../money.js';
import { assertBalanced } from '../journal.js';
import type { JournalEntry, JournalLine } from '../journal.js';
import { epochToUtcDate } from '../util/dates.js';
import { sortLines } from '../util/lines.js';
import { invoiceMemo } from '../util/memo.js';
import {
  computeFinalizationSplit,
  resolveSubscriptionId,
} from '../events/invoices/recognition.js';
import type { VoidReconcileInput } from './storage/types.js';

/**
 * Sum the revenue a set of already-posted recognition entries moved out of
 * deferred (2100) into recognized (4000). Each recognition entry credits 4000
 * for that month's portion, so the total is how much of the deferred schedule
 * has recognized by the time the void arrives.
 */
function recognizedFromPosted(posted: ReadonlyArray<JournalEntry>): number {
  let total = 0;
  for (const entry of posted) {
    for (const line of entry.lines) {
      if (line.accountCode === '4000' && line.side === 'credit') {
        total += line.amount;
      }
    }
  }
  return total;
}

/**
 * Build the storage input that reverses a voided net-terms invoice whose
 * finalization deferred part of the revenue to a recognition schedule.
 *
 * The pure engine refuses this case (see `handleInvoiceVoided`) because a
 * correct reversal depends on how much of the schedule has already recognized —
 * a stateful fact only the ledger holds. Here, with storage access, the
 * reversal:
 *
 *   - clears the receivable in full (Cr 1100) — a voided invoice is unpaid, so
 *     1100 still carries the finalization gross;
 *   - reverses ALL recognized revenue (Dr 4000: the immediate portion booked at
 *     finalization plus whatever the schedule has recognized since);
 *   - clears the still-deferred remainder (Dr 2100: what has not recognized);
 *   - reverses the tax (Dr 2000).
 *
 * The debits sum to the gross regardless of how far the schedule ran — the
 * recognized amount that leaves 2100 is exactly what it adds to 4000 — so the
 * entry always balances and every account the invoice touched returns to zero.
 * The storage layer separately cancels the still-unposted schedule rows so no
 * further month recognizes against the voided invoice.
 */
export function buildVoidReconcileInput(event: Stripe.Event): VoidReconcileInput {
  if (event.type !== 'invoice.voided') {
    throw new Error(`buildVoidReconcileInput received wrong event type: ${event.type}`);
  }
  const invoice = event.data.object;
  const { gross, taxAmt, immediatePreTax, deferredPreTax } = computeFinalizationSplit(invoice);
  const currency = invoice.currency.toUpperCase();
  const date = epochToUtcDate(event.created);
  const memo = invoiceMemo(invoice);

  return {
    subscriptionId: resolveSubscriptionId(invoice),
    invoiceId: invoice.id,
    buildReversal(posted): JournalEntry {
      // The posted schedule can never exceed what was deferred; clamp anyway so
      // the entry stays balanced against any unexpected row.
      const recognized = Math.min(recognizedFromPosted(posted), deferredPreTax);
      const revenueReversal = immediatePreTax + recognized;
      const remainingDeferred = deferredPreTax - recognized;

      const draft: JournalLine[] = [
        {
          accountCode: '1100',
          side: 'credit',
          amount: cents(gross),
          memo: 'Receivable reversed — invoice voided',
        },
      ];
      if (revenueReversal > 0) {
        draft.push({
          accountCode: '4000',
          side: 'debit',
          amount: cents(revenueReversal),
          memo: 'Revenue reversed — invoice voided',
        });
      }
      if (remainingDeferred > 0) {
        draft.push({
          accountCode: '2100',
          side: 'debit',
          amount: cents(remainingDeferred),
          memo: 'Deferred revenue reversed — invoice voided',
        });
      }
      if (taxAmt > 0) {
        draft.push({
          accountCode: '2000',
          side: 'debit',
          amount: cents(taxAmt),
          memo: 'Sales tax reversed — invoice voided',
        });
      }

      const entry: JournalEntry = {
        date,
        currency,
        memo,
        sourceEventId: event.id,
        sourceEventType: event.type,
        sourceObjectId: invoice.id,
        lines: sortLines(draft),
      };
      assertBalanced(entry);
      return entry;
    },
  };
}
