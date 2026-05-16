import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { refundMemo } from '../../util/memo.js';

export function handleChargeRefunded(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.refunded') {
    throw new Error(`handleChargeRefunded received wrong event type: ${event.type}`);
  }
  const charge = event.data.object;
  if (charge.currency !== 'usd') {
    throw new Error(
      `Non-USD refunds not yet supported (charge ${charge.id} currency=${charge.currency})`,
    );
  }

  const refundsList = charge.refunds;
  if (!refundsList || refundsList.data.length === 0) {
    return { entries: [], schedule: null };
  }

  // Emit one entry per refund whose `created` matches the event's `created` time.
  // Stripe redelivers prior refunds in the list; matching by created timestamp
  // isolates the new refund(s) this event is about. If clock skew causes no match,
  // throwing is safer than silently re-posting all refunds (would double-count
  // on every subsequent refund event for the same charge).
  const targetRefunds = refundsList.data.filter((r) => r.created === event.created);
  if (targetRefunds.length === 0) {
    throw new Error(
      `charge.refunded event ${event.id} has no refund matching event.created=${String(event.created)}; ` +
        `refunds.data has ${String(refundsList.data.length)} item(s) with created times ` +
        `[${refundsList.data.map((r) => String(r.created)).join(', ')}]`,
    );
  }

  const entries: JournalEntry[] = targetRefunds.map((refund) => {
    const bt = requireExpanded<Stripe.BalanceTransaction>(
      refund.balance_transaction,
      `refund[${refund.id}].balance_transaction`,
      event.id,
    );

    // Sanity invariant: the BT for a refund should net to the inverse of the refund amount.
    // If they differ, Stripe is doing something we don't yet model (e.g., partial fee clawback).
    if (bt.net !== -refund.amount) {
      throw new Error(
        `Refund ${refund.id} balance_transaction net (${String(bt.net)}) does not equal ` +
          `-amount (${String(-refund.amount)}); fee clawback or unmodeled case`,
      );
    }

    const amount = cents(refund.amount);
    const lines: ReadonlyArray<JournalLine> = sortLines([
      { accountCode: '4900', side: 'debit', amount, memo: 'Refund issued' },
      { accountCode: '1010', side: 'credit', amount, memo: 'Refund deducted from Stripe balance' },
    ]);

    return {
      date: epochToUtcDate(refund.created),
      currency: 'USD',
      memo: refundMemo(charge, refund.id),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: refund.id,
      lines,
    };
  });

  return { entries, schedule: null };
}
