import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { payoutMemo } from '../../util/memo.js';
import { rejectCrossCurrencyPayout } from './crossCurrency.js';

export function handlePayoutPaid(event: Stripe.Event): MapResult {
  if (event.type !== 'payout.paid') {
    throw new Error(`handlePayoutPaid received wrong event type: ${event.type}`);
  }
  const payout = event.data.object;
  // Detect a cross-currency payout (Stripe converting between settlement
  // and destination bank currency) and throw before doing any accounting
  // work — the alternative would be silently producing a 1000/1010
  // transfer in the source currency that doesn't account for the FX fee
  // or the destination amount. See ./crossCurrency.ts for the detection
  // and the deferred-implementation rationale.
  rejectCrossCurrencyPayout(payout);
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
    currency: payout.currency.toUpperCase(),
    memo: payoutMemo(payout),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: payout.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
