import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
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
  if (dispute.currency !== 'usd') {
    throw new Error(
      `Non-USD disputes not yet supported (dispute ${dispute.id} currency=${dispute.currency})`,
    );
  }
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

  const amount = cents(dispute.amount);

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
    currency: 'USD',
    memo: disputeMemo(dispute, 'funds reinstated'),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: dispute.id,
    lines,
  };

  return { entries: [entry], schedule: null };
}
