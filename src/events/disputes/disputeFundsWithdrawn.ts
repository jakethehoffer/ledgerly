import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { disputeMemo } from '../../util/memo.js';

export function handleDisputeFundsWithdrawn(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.dispute.funds_withdrawn') {
    throw new Error(
      `handleDisputeFundsWithdrawn received wrong event type: ${event.type}`,
    );
  }
  const dispute = event.data.object;
  if (dispute.currency !== 'usd') {
    throw new Error(
      `Non-USD disputes not yet supported (dispute ${dispute.id} currency=${dispute.currency})`,
    );
  }
  if (dispute.amount === 0) {
    return { entries: [], schedule: null };
  }

  // Validate every balance_transaction is expanded (not a string ID).
  // Stripe's typed API already declares this as Array<BalanceTransaction>, but
  // the runtime payload may still contain strings if the caller forgot to expand.
  const balanceTransactions = dispute.balance_transactions.map((bt, idx) =>
    requireExpanded<Stripe.BalanceTransaction>(
      bt,
      `dispute.balance_transactions[${String(idx)}]`,
      event.id,
    ),
  );

  // Sum the non-refundable dispute fee across any BTs Stripe classifies as
  // payment_dispute_fee. Stripe's BalanceTransaction.Type union in stripe@16
  // does not yet enumerate 'payment_dispute_fee', so compare via String() to
  // satisfy strict-type-checked without an unsafe cast.
  const feeTotal = balanceTransactions
    .filter((bt) => String(bt.type) === 'payment_dispute_fee')
    .reduce((sum, bt) => sum + Math.abs(bt.amount), 0);

  const disputedAmount = dispute.amount;
  const totalWithdrawn = disputedAmount + feeTotal;

  const rawLines: JournalLine[] = [
    {
      accountCode: '1200',
      side: 'debit',
      amount: cents(disputedAmount),
      memo: 'Funds held pending dispute outcome',
    },
    {
      accountCode: '1010',
      side: 'credit',
      amount: cents(totalWithdrawn),
      memo: 'Funds withdrawn from Stripe balance',
    },
  ];
  if (feeTotal > 0) {
    rawLines.push({
      accountCode: '6100',
      side: 'debit',
      amount: cents(feeTotal),
      memo: 'Non-refundable dispute fee',
    });
  }

  const lines: ReadonlyArray<JournalLine> = sortLines(rawLines);

  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency: 'USD',
    memo: disputeMemo(dispute, 'funds withdrawn'),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: dispute.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
