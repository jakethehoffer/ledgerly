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

  // FX dispute handling is deferred. The fee-detection logic below compares
  // |bt.amount| against disputedAmount, which only holds when the dispute
  // and the BTs share a currency. Under FX (e.g., Canadian-based account
  // disputing a USD charge), dispute.amount is in dispute.currency while
  // bt.amount/bt.fee are in settlement currency, so the comparison would
  // misidentify the split-fee BT and produce an unbalanced entry. Fail
  // loudly here rather than emit silently wrong journal lines.
  const allBtsAreSameCurrency = balanceTransactions.every(
    (bt) => bt.currency === dispute.currency,
  );
  if (!allBtsAreSameCurrency) {
    throw new Error(
      `FX disputes not yet supported (dispute ${dispute.id}: dispute.currency=${dispute.currency}, ` +
        `bt currencies=[${balanceTransactions.map((bt) => bt.currency).join(', ')}])`,
    );
  }

  // Stripe represents the non-refundable dispute fee in two shapes:
  //   (1) A single adjustment BT carrying the fee inline in bt.fee
  //       (amount = -dispute.amount, fee = dispute_fee, net = -(amount + fee)).
  //   (2) Two adjustment BTs, both with reporting_category='dispute': one
  //       whose |amount| equals dispute.amount (the clawback), and a separate
  //       fee BT whose |amount| is the dispute_fee.
  // Sum bt.fee on every dispute-category BT, and add |bt.amount| from any BT
  // whose magnitude doesn't equal the disputed amount (the split-fee BT).
  const disputedAmount = dispute.amount;
  const feeTotal = balanceTransactions
    .filter((bt) => bt.reporting_category === 'dispute')
    .reduce((sum, bt) => {
      const inlineFee = bt.fee;
      const splitFee = Math.abs(bt.amount) === disputedAmount ? 0 : Math.abs(bt.amount);
      return sum + inlineFee + splitFee;
    }, 0);

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
