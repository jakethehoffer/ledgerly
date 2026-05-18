import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { payoutMemo } from '../../util/memo.js';

export function handlePayoutFailed(event: Stripe.Event): MapResult {
  if (event.type !== 'payout.failed') {
    throw new Error(`handlePayoutFailed received wrong event type: ${event.type}`);
  }
  const payout = event.data.object;
  if (payout.amount === 0) {
    return { entries: [], schedule: null };
  }

  const amount = cents(payout.amount);
  const lines: ReadonlyArray<JournalLine> = sortLines([
    { accountCode: '1010', side: 'debit',  amount, memo: 'Funds returned to Stripe balance' },
    { accountCode: '1000', side: 'credit', amount, memo: 'Failed payout reversal' },
  ]);

  // Date: use event.created (when Stripe detected the failure), NOT payout.arrival_date.
  // Real-world failure detection can lag the original arrival_date by days; posting the
  // reversal on the actual detection date keeps the bank ledger consistent with when
  // each cash movement was known.
  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency: payout.currency.toUpperCase(),
    memo: payoutMemo(payout, 'failed'),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: payout.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
