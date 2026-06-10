import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { buildFxContext, withFx } from '../../util/fxContext.js';
import { sortLines } from '../../util/lines.js';
import { disputeMemo } from '../../util/memo.js';
import { originalChargeSettlement } from './disputeRate.js';

export function handleDisputeFundsWithdrawn(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.dispute.funds_withdrawn') {
    throw new Error(
      `handleDisputeFundsWithdrawn received wrong event type: ${event.type}`,
    );
  }
  const dispute = event.data.object;
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

  // Filter to dispute-category BTs — Stripe sometimes attaches BTs for
  // related-but-distinct movements (e.g., a payout adjustment) that we
  // don't want to count toward the clawback or fee.
  const disputeBts = balanceTransactions.filter((bt) => bt.reporting_category === 'dispute');
  if (disputeBts.length === 0) {
    throw new Error(
      `dispute ${dispute.id} has no balance_transactions with reporting_category='dispute'`,
    );
  }

  // All dispute-category BTs MUST share a single currency — Stripe credits
  // and debits the settlement balance, which is one account-wide currency
  // per Stripe account, so a mixed-currency dispute BT array would mean
  // something more exotic than the FX scenario we model here. Bail loudly.
  const firstBt = disputeBts[0];
  if (firstBt === undefined) {
    throw new Error(`dispute ${dispute.id} unexpected: disputeBts emptied`);
  }
  const btCurrencies = new Set(disputeBts.map((bt) => bt.currency));
  if (btCurrencies.size > 1) {
    throw new Error(
      `dispute ${dispute.id} has mixed-currency balance_transactions: ` +
        `[${[...btCurrencies].join(', ')}]`,
    );
  }
  const btCurrency = firstBt.currency;

  // Stripe represents the non-refundable dispute fee in two shapes:
  //   (1) A single adjustment BT carrying the fee inline in bt.fee
  //       (amount = -|clawback|, fee = dispute_fee, net = amount - fee).
  //   (2) Multiple adjustment BTs, all with reporting_category='dispute':
  //       one large BT (the clawback) plus one or more smaller BTs that
  //       carry the dispute fee in bt.amount with bt.fee = 0.
  //
  // Same-currency case (BT currency == dispute.currency): the historical
  // heuristic was `|bt.amount| === dispute.amount` to spot the clawback,
  // but that breaks for FX disputes where bt.amount is in settlement
  // currency and dispute.amount is in customer-facing currency. The
  // currency-agnostic identification used here: the clawback BT is the
  // one with the LARGEST |bt.amount| within the dispute-category set.
  // Every remaining dispute-category BT is treated as a fee, contributing
  // both its |amount| and its inline `fee` to the fee total. This handles
  // both shapes above identically and works regardless of currency.
  const sortedBySize = [...disputeBts].sort(
    (a, b) => Math.abs(b.amount) - Math.abs(a.amount),
  );
  const clawbackBt = sortedBySize[0];
  if (clawbackBt === undefined) {
    // Unreachable: we already early-returned on disputeBts.length === 0.
    throw new Error(`dispute ${dispute.id} unexpected: sortedBySize empty`);
  }
  const otherBts = sortedBySize.slice(1);

  const actualClawback = Math.abs(clawbackBt.amount);
  const inlineFee = Math.abs(clawbackBt.fee);
  const splitFees = otherBts.reduce(
    (sum, bt) => sum + Math.abs(bt.amount) + Math.abs(bt.fee),
    0,
  );
  const feeTotal = inlineFee + splitFees;
  const totalWithdrawn = actualClawback + feeTotal;

  // FX gain/loss recognition. When the original charge's balance_transaction
  // is expanded (the receiver's expand.ts requests it on every dispute event;
  // legacy fixtures and other callers may bypass), compare what the clawback
  // SHOULD cost at the original charge's rate against what Stripe actually
  // withdrew. The difference is realized FX gain/loss → account 7000.
  //
  // Same pattern as chargeRefunded's FX gain/loss work: the 1200 receivable
  // releases at the ORIGINAL rate (so it cleanly mirrors what chargeSucceeded
  // booked when the original charge was settled), the 1010 cash leg posts at
  // the dispute-time rate (what Stripe really clawed back), and 7000 absorbs
  // the rate-movement delta.
  //
  // When `charge.balance_transaction` isn't expanded (string ID), the rate
  // can't be computed cross-currency, so we fall back to using the BT's
  // actual amount for both the 1200 receivable release and the cash leg —
  // identical to the v0.1.6 behavior. Same-currency disputes are also
  // identical because their original rate is exactly 1.0 and the
  // dispute-rate equivalent is `actualClawback / dispute.amount = 1.0`,
  // giving fxDelta = 0 either way.
  const originalRate = originalChargeSettlement(dispute)?.rate ?? null;
  const expectedClawback =
    originalRate !== null && dispute.amount > 0
      ? Math.round(dispute.amount * originalRate)
      : actualClawback;
  const fxDelta = actualClawback - expectedClawback;

  const rawLines: JournalLine[] = [
    {
      accountCode: '1200',
      side: 'debit',
      amount: cents(expectedClawback),
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
  if (fxDelta !== 0) {
    rawLines.push({
      accountCode: '7000',
      side: fxDelta > 0 ? 'debit' : 'credit',
      amount: cents(Math.abs(fxDelta)),
      memo:
        fxDelta > 0
          ? 'FX loss on dispute clawback (rate moved against us)'
          : 'FX gain on dispute clawback (rate moved in our favor)',
    });
  }

  const lines: ReadonlyArray<JournalLine> = sortLines(rawLines);

  // FX provenance: settlementAmount is the actual clawback at dispute time
  // (not expectedClawback — the 7000 line already captures the rate-drift
  // delta against original; fxContext describes the conversion that
  // actually happened on this event). Same-currency disputes omit
  // fxContext via the helper's undefined return.
  const fxContext = buildFxContext(
    dispute.currency,
    dispute.amount,
    btCurrency,
    actualClawback,
  );

  const entry: JournalEntry = withFx(
    {
      date: epochToUtcDate(event.created),
      // Use the settlement currency from the BTs, not dispute.currency. For
      // same-currency disputes they're identical; for FX disputes the entry
      // must post in settlement currency so it balances against the original
      // chargeSucceeded entry (which the FX-safe handler also posted in
      // settlement currency).
      currency: btCurrency.toUpperCase(),
      memo: disputeMemo(dispute, 'funds withdrawn'),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: dispute.id,
      lines,
    },
    fxContext,
  );

  return { entries: [entry], schedule: null };
}
