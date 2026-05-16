import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { payoutMemo } from '../../util/memo.js';

export function handlePayoutPaid(event: Stripe.Event): MapResult {
  if (event.type !== 'payout.paid') {
    throw new Error(`handlePayoutPaid received wrong event type: ${event.type}`);
  }
  const payout = event.data.object;
  if (payout.currency !== 'usd') {
    throw new Error(
      `Non-USD payouts not yet supported (payout ${payout.id} currency=${payout.currency})`,
    );
  }
  if (payout.amount === 0) {
    return { entries: [], schedule: null };
  }

  const amount = cents(payout.amount);
  const lines: ReadonlyArray<JournalLine> = sortLines([
    { accountCode: '1000', side: 'debit',  amount, memo: 'Funds arrived in bank' },
    { accountCode: '1010', side: 'credit', amount, memo: 'Funds left Stripe balance' },
  ]);

  const entry: JournalEntry = {
    date: epochToUtcDate(payout.arrival_date),
    currency: 'USD',
    memo: payoutMemo(payout),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: payout.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
