import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { disputeMemo } from '../../util/memo.js';

export function handleDisputeClosed(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.dispute.closed') {
    throw new Error(
      `handleDisputeClosed received wrong event type: ${event.type}`,
    );
  }
  const dispute = event.data.object;
  if (dispute.currency !== 'usd') {
    throw new Error(
      `Non-USD disputes not yet supported (dispute ${dispute.id} currency=${dispute.currency})`,
    );
  }
  // FX limitation: this handler only sees dispute.amount (in dispute.currency).
  // If the originating chargeSucceeded entry posted in the account's
  // settlement currency (BT currency) and that differs from dispute.currency,
  // the 'lost' entry below will record 6100/1200 in dispute.currency while
  // the original 1200 receivable sits in BT currency — producing account-level
  // currency mixing. funds_withdrawn now rejects FX disputes, so this handler
  // is shielded in practice via the typical close-after-withdraw lifecycle;
  // direct close paths under FX remain spec-deferred (charge.dispute.closed
  // events do not expand BTs the way funds_withdrawn does).

  switch (dispute.status) {
    case 'won':
    case 'warning_closed':
      // 'won' returns money on a separate funds_reinstated event; warning_closed
      // disputes have no financial movement at all.
      return { entries: [], schedule: null };
    case 'lost': {
      if (dispute.amount === 0) {
        return { entries: [], schedule: null };
      }
      const amount = cents(dispute.amount);
      const rawLines: JournalLine[] = [
        {
          accountCode: '6100',
          side: 'debit',
          amount,
          memo: 'Dispute lost — writeoff of receivable',
        },
        {
          accountCode: '1200',
          side: 'credit',
          amount,
          memo: 'Release receivable to expense',
        },
      ];
      const lines: ReadonlyArray<JournalLine> = sortLines(rawLines);
      const entry: JournalEntry = {
        date: epochToUtcDate(event.created),
        currency: 'USD',
        memo: disputeMemo(dispute, 'closed lost'),
        sourceEventId: event.id,
        sourceEventType: event.type,
        sourceObjectId: dispute.id,
        lines,
      };
      return { entries: [entry], schedule: null };
    }
    default:
      throw new Error(
        `Unrecognized dispute.status on closed event for ${dispute.id}: ${String(dispute.status)}`,
      );
  }
}
