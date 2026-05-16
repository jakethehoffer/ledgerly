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

  // Emit one entry per refund created at this event's `created` time.
  // Stripe redelivers prior refunds in the list; we only post the ones with
  // created === event.created to avoid double-posting on subsequent refunds.
  const newRefunds = refundsList.data.filter((r) => r.created === event.created);
  const targetRefunds = newRefunds.length > 0 ? newRefunds : refundsList.data;

  const entries: JournalEntry[] = targetRefunds.map((refund) => {
    requireExpanded<Stripe.BalanceTransaction>(
      refund.balance_transaction,
      `refund[${refund.id}].balance_transaction`,
      event.id,
    );

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
