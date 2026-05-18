import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { disputeMemo } from '../../util/memo.js';

export function handleDisputeFundsReinstated(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.dispute.funds_reinstated') {
    throw new Error(
      `handleDisputeFundsReinstated received wrong event type: ${event.type}`,
    );
  }
  const dispute = event.data.object;
  if (dispute.amount === 0) {
    return { entries: [], schedule: null };
  }

  // Confirm balance_transactions is present as an array. Stripe's typed API
  // already declares this, but the runtime payload could in principle omit it.
  if (!Array.isArray(dispute.balance_transactions)) {
    throw new Error(
      `dispute.balance_transactions missing or not an array on ${event.id}`,
    );
  }

  // Expand and use the reinstatement BTs as the FX-safe basis. A reinstated
  // dispute posts one or more positive-amount BTs whose net sums to the
  // amount returned to the Stripe balance in the account's settlement
  // currency. dispute.amount is in dispute.currency (customer-facing) and
  // would mismatch under FX (e.g., Canadian-based account, USD dispute).
  // For same-currency disputes, the sum of bt.net equals dispute.amount —
  // existing USD fixtures see no behavior change.
  const balanceTransactions = dispute.balance_transactions.map((bt, idx) =>
    requireExpanded<Stripe.BalanceTransaction>(
      bt,
      `dispute.balance_transactions[${String(idx)}]`,
      event.id,
    ),
  );
  const [firstBt] = balanceTransactions;
  if (!firstBt) {
    throw new Error(
      `dispute.balance_transactions empty on funds_reinstated event ${event.id}`,
    );
  }
  const btCurrencies = new Set(balanceTransactions.map((bt) => bt.currency));
  if (btCurrencies.size > 1) {
    throw new Error(
      `dispute.balance_transactions span multiple currencies on ${event.id}: ` +
        `[${[...btCurrencies].join(', ')}]`,
    );
  }
  const netSum = balanceTransactions.reduce((s, bt) => s + bt.net, 0);
  const amount = cents(Math.abs(netSum));
  const btCurrency = firstBt.currency.toUpperCase();

  const rawLines: JournalLine[] = [
    {
      accountCode: '1010',
      side: 'debit',
      amount,
      memo: 'Funds reinstated to Stripe balance',
    },
    {
      accountCode: '1200',
      side: 'credit',
      amount,
      memo: 'Release receivable on dispute win',
    },
  ];

  const lines: ReadonlyArray<JournalLine> = sortLines(rawLines);

  const entry: JournalEntry = {
    date: epochToUtcDate(event.created),
    currency: btCurrency,
    memo: disputeMemo(dispute, 'funds reinstated'),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: dispute.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
