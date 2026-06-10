import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { buildFxContext, withFx } from '../../util/fxContext.js';
import { sortLines } from '../../util/lines.js';
import { disputeMemo } from '../../util/memo.js';
import { originalChargeSettlement } from './disputeRate.js';

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

  // A reinstated dispute posts one or more positive-amount BTs whose net sums
  // to the funds actually returned to the Stripe balance, in the account's
  // settlement currency. That sum drives the 1010 cash leg below; the 1200
  // receivable release is computed separately from the original charge rate so
  // it mirrors what funds_withdrawn parked (see the block after the BTs). All
  // BTs must share one currency (the account-wide settlement currency).
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
  const actual = Math.abs(netSum);
  const settlementCurrencyRaw = firstBt.currency;
  const btCurrency = settlementCurrencyRaw.toUpperCase();

  // Release the 1200 receivable at the ORIGINAL charge rate so it exactly
  // mirrors what funds_withdrawn parked (same dispute.amount × same original
  // rate ⇒ same rounded integer, so 1200 clears to zero). The cash actually
  // returned — `actual`, at the reinstatement-time rate — posts to 1010, and
  // 7000 absorbs the rate-movement delta between the two moments.
  //
  // When the charge BT isn't expanded (string id) there's no original rate to
  // compare, so `expected === actual`, the 7000 line vanishes, and fxContext
  // is omitted — byte-identical to v0.1.6 and to same-currency disputes
  // (whose original rate is 1.0). Mirrors disputeFundsWithdrawn's fallback.
  const settlement = originalChargeSettlement(dispute);
  const expected =
    settlement !== null && dispute.amount > 0
      ? Math.round(dispute.amount * settlement.rate)
      : actual;
  const fxDelta = actual - expected;

  const rawLines: JournalLine[] = [
    {
      accountCode: '1010',
      side: 'debit',
      amount: cents(actual),
      memo: 'Funds reinstated to Stripe balance',
    },
    {
      accountCode: '1200',
      side: 'credit',
      amount: cents(expected),
      memo: 'Release receivable on dispute win',
    },
  ];
  if (fxDelta !== 0) {
    // The cash leg (1010) is a DEBIT here, so the 7000 side is the MIRROR of
    // funds_withdrawn's convention (where the cash leg is a credit): recovering
    // MORE than the parked receivable (actual > expected) is an FX gain →
    // credit 7000; recovering less is a loss → debit 7000.
    rawLines.push({
      accountCode: '7000',
      side: fxDelta > 0 ? 'credit' : 'debit',
      amount: cents(Math.abs(fxDelta)),
      memo:
        fxDelta > 0
          ? 'FX gain on dispute reinstatement (rate moved in our favor)'
          : 'FX loss on dispute reinstatement (rate moved against us)',
    });
  }

  const lines: ReadonlyArray<JournalLine> = sortLines(rawLines);

  // FX provenance describes the conversion that actually happened on this
  // event: customer-facing dispute amount → settlement funds returned. The
  // 7000 line already carries the rate-drift delta versus the original charge.
  const fxContext = buildFxContext(
    dispute.currency,
    dispute.amount,
    settlementCurrencyRaw,
    actual,
  );

  const entry: JournalEntry = withFx(
    {
      date: epochToUtcDate(event.created),
      currency: btCurrency,
      memo: disputeMemo(dispute, 'funds reinstated'),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: dispute.id,
      lines,
    },
    fxContext,
  );

  return { entries: [entry], schedule: null };
}
