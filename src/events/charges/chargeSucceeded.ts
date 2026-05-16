import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { chargeMemo } from '../../util/memo.js';

export function handleChargeSucceeded(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.succeeded') {
    throw new Error(`handleChargeSucceeded received wrong event type: ${event.type}`);
  }
  const charge = event.data.object;
  if (charge.currency !== 'usd') {
    throw new Error(
      `Non-USD charges not yet supported (charge ${charge.id} currency=${charge.currency})`,
    );
  }
  if (charge.amount === 0) {
    return { entries: [], schedule: null };
  }

  const bt = requireExpanded<Stripe.BalanceTransaction>(
    charge.balance_transaction,
    'charge.balance_transaction',
    event.id,
  );

  const gross = cents(charge.amount);
  const fee = cents(bt.fee);
  const net = cents(bt.net);

  const lines: ReadonlyArray<JournalLine> = sortLines([
    { accountCode: '1010', side: 'debit',  amount: net,   memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,   memo: 'Stripe processing fee' },
    { accountCode: '4000', side: 'credit', amount: gross, memo: 'Subscription revenue' },
  ]);

  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency: 'USD',
    memo: chargeMemo(charge),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: charge.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
