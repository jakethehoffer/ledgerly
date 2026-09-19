import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { buildFxContext, withFx } from '../../util/fxContext.js';
import { sortLines } from '../../util/lines.js';
import { refundMemo } from '../../util/memo.js';

export function handleChargeRefunded(
  event: Stripe.Event,
  bookedRefundIds: ReadonlySet<string> = new Set(),
): MapResult {
  if (event.type !== 'charge.refunded') {
    throw new Error(`handleChargeRefunded received wrong event type: ${event.type}`);
  }
  const charge = event.data.object;

  const refundsList = charge.refunds;
  if (!refundsList) {
    return { entries: [], schedule: null };
  }
  if (refundsList.has_more) {
    throw new Error(
      `Charge ${charge.id} has paginated refunds (refunds.has_more=true); ` +
        'complete refund list required for exact cumulative basis allocation',
    );
  }
  if (refundsList.data.length === 0) {
    return { entries: [], schedule: null };
  }

  // Emit one entry per refund whose `created` matches the event's `created` time.
  // Stripe redelivers prior refunds in the list; matching by created timestamp
  // isolates the new refund(s) this event is about. If clock skew causes no match,
  // throwing is safer than silently re-posting all refunds (would double-count
  // on every subsequent refund event for the same charge).
  const targetRefunds = refundsList.data.filter((r) => r.created === event.created);
  if (targetRefunds.length === 0) {
    throw new Error(
      `charge.refunded event ${event.id} has no refund matching event.created=${String(event.created)}; ` +
        `refunds.data has ${String(refundsList.data.length)} item(s) with created times ` +
        `[${refundsList.data.map((r) => String(r.created)).join(', ')}]`,
    );
  }

  // Detect tax info from the expanded invoice, if present. When the caller has
  // expanded `charge.invoice` and the invoice had Stripe Tax applied, refunds
  // must drain 2000 Sales Tax Payable proportionally — otherwise the books
  // accumulate phantom tax liability on refunded sales. If the invoice is not
  // expanded (string ID), absent, or has no tax, fall back to the 2-line shape.
  let taxRatio = 0;
  const invoice = charge.invoice;
  if (invoice && typeof invoice === 'object' && charge.amount > 0) {
    const invoiceTax = invoice.tax;
    if (invoiceTax !== null && invoiceTax > 0) {
      taxRatio = invoiceTax / charge.amount;
    }
  }

  // The original charge's BT carries the FX rate Stripe used at charge time.
  // When available (the production receiver's expand.ts always requests it),
  // we compare each refund BT's effective rate against this baseline to
  // recognize realized FX gain/loss on rate movement between charge and
  // refund. When the BT isn't expanded (string ID — happens in legacy
  // fixtures and any caller that skips expansion), we default to rate=1.0
  // and produce no 7000 line; same-currency books are unaffected because
  // their true rate is 1.0 anyway, and the FX gain/loss is simply not
  // recognized for FX cases that bypass expansion. For same-currency
  // charges with expansion, the rate is also 1.0 and fxDelta = 0, so the
  // existing fixtures stay byte-identical.
  const chargeBt = charge.balance_transaction;
  const originalRate =
    typeof chargeBt === 'object' && chargeBt !== null && charge.amount > 0
      ? Math.abs(chargeBt.amount) / charge.amount
      : 1;

  // Cumulative original-basis and tax allocation. Order every refund on the
  // charge by creation so both shares are computed as
  //   round(cumulativeThrough * rate) - round(cumulativeBefore * rate)
  // and, for tax,
  //   round(cumulativeThrough * rate * taxRatio) - round(cumulativeBefore * rate * taxRatio)
  // rather than rounding each refund independently. Independent rounding can
  // strand a cent in either 4900 Refunds Issued or 2000 Sales Tax Payable and
  // mislabel that cent as FX movement after a full split refund.
  //
  // The cumulative basis is the CUSTOMER-currency amount (`refund.amount`), not
  // the per-refund settlement amount. Customer amounts sum EXACTLY to
  // charge.amount on a full refund, so the telescoped total is
  //   round(charge.amount * originalRate * taxRatio)
  //     = round(chargeBt.amount * taxRatio)
  //     = the settlement-currency tax booked at charge time.
  // Telescoping on the per-refund settlement amounts instead (Σ round(r*rate))
  // can drift a cent from chargeBt.amount under FX and strand it in 2000. For
  // same-currency (originalRate = 1) the customer cumulative equals the
  // settlement cumulative, so this reduces to the previous expression and all
  // existing fixtures stay byte-identical.
  const cumulativeCustomerBeforeById = new Map<string, number>();
  {
    const ordered = [...refundsList.data].sort((a, b) => {
      if (a.created !== b.created) return a.created - b.created;
      // A later same-second refund must not move ahead of money whose rounded
      // tax/FX basis has already been booked from an earlier snapshot.
      if (bookedRefundIds.has(a.id) !== bookedRefundIds.has(b.id)) {
        return bookedRefundIds.has(a.id) ? -1 : 1;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    let running = 0;
    for (const r of ordered) {
      cumulativeCustomerBeforeById.set(r.id, running);
      // Failed and canceled refunds stay in Stripe's refund history even
      // though they did not leave a lasting refund against the charge. Do not
      // let those attempts shift the cumulative original basis for a later
      // refund. Pending and requires_action refunds are kept because Stripe
      // can already have removed their balance amount while they are open.
      if (r.status !== 'failed' && r.status !== 'canceled') {
        running += r.amount;
      }
    }
  }

  const unbookedRefunds = targetRefunds.filter((refund) => !bookedRefundIds.has(refund.id));
  // An unsettled earlier refund can still fail and change the tax/FX basis.
  // Hold dependent refunds too until that history is final.
  for (const refund of unbookedRefunds.length > 0 ? refundsList.data : []) {
    if (refund.status === 'pending' || refund.status === 'requires_action') {
      throw new Error(`Refund ${refund.id} has not succeeded yet; retry after it settles`);
    }
  }
  const entries: JournalEntry[] = unbookedRefunds
    .filter((refund) => refund.status !== 'failed' && refund.status !== 'canceled')
    .map((refund) => {
      const bt = requireExpanded<Stripe.BalanceTransaction>(
        refund.balance_transaction,
        `refund[${refund.id}].balance_transaction`,
        event.id,
      );

      // Sanity invariant: a refund BT should have no fee (net == amount). If
      // they differ, Stripe is doing something we don't yet model (e.g.,
      // partial fee clawback). Comparing within the BT currency stays valid
      // under FX, where comparing bt.net to -refund.amount would not.
      if (bt.net !== bt.amount) {
        throw new Error(
          `Refund ${refund.id} balance_transaction net (${String(bt.net)}) does not equal ` +
            `amount (${String(bt.amount)}); fee clawback or unmodeled case`,
        );
      }

      // FX-aware refund booking. The revenue offset (4900) and tax drain
      // (2000) post at the ORIGINAL rate so they cleanly offset the
      // original revenue/tax booking. The cash leg (1010) posts at the
      // refund-time rate (what Stripe actually clawed back from the
      // balance). The difference between expected and actual settlement
      // is realized FX gain/loss → account 7000.
      //
      // Same-currency case: originalRate = refundRate = 1.0 (both ratios
      // are |bt.amount| / refund.amount in matching units), so
      // expectedSettlement = actualSettlement and fxDelta = 0 → no 7000
      // line, byte-identical to the pre-FX-gain/loss behavior. The
      // existing same-currency refund fixtures pass unchanged.
      const cumCustomerBefore = cumulativeCustomerBeforeById.get(refund.id) ?? 0;
      const cumCustomerThrough = cumCustomerBefore + refund.amount;
      const actualSettlement = Math.abs(bt.amount);
      const expectedSettlement =
        Math.round(cumCustomerThrough * originalRate) -
        Math.round(cumCustomerBefore * originalRate);
      const fxDelta = actualSettlement - expectedSettlement;

      // Tax share uses the same cumulative customer basis, folding the settlement
      // rate into the factor so the 2000 reversals across a multi-refund sequence
      // sum to exactly the tax collected at charge time — under FX as well as
      // same-currency.
      const taxPortion =
        taxRatio > 0
          ? Math.round(cumCustomerThrough * originalRate * taxRatio) -
            Math.round(cumCustomerBefore * originalRate * taxRatio)
          : 0;
      const revenuePortion = expectedSettlement - taxPortion;

      const draft: JournalLine[] = [];
      if (revenuePortion > 0) {
        draft.push({
          accountCode: '4900',
          side: 'debit',
          amount: cents(revenuePortion),
          memo: 'Refund issued',
        });
      }
      if (taxPortion > 0) {
        draft.push({
          accountCode: '2000',
          side: 'debit',
          amount: cents(taxPortion),
          memo: 'Sales tax portion refunded',
        });
      }
      draft.push({
        accountCode: '1010',
        side: 'credit',
        amount: cents(actualSettlement),
        memo: 'Refund deducted from Stripe balance',
      });

      if (fxDelta !== 0) {
        // Positive fxDelta means we paid back MORE settlement-currency than
        // the original revenue booking (rate moved against us between charge
        // and refund) — realized FX loss → 7000 debit. Negative means we
        // paid back less — realized FX gain → 7000 credit. Either way, the
        // magnitude is the absolute delta; the side balances the entry.
        draft.push({
          accountCode: '7000',
          side: fxDelta > 0 ? 'debit' : 'credit',
          amount: cents(Math.abs(fxDelta)),
          memo:
            fxDelta > 0
              ? 'FX loss on refund (rate moved against us)'
              : 'FX gain on refund (rate moved in our favor)',
        });
      }

      const lines: ReadonlyArray<JournalLine> = sortLines(draft);

      // FX provenance: settlementAmount is the actual refund clawback in
      // settlement currency (refund-time rate), customerAmount is the
      // refund's customer-facing amount. For same-currency refunds the
      // helper returns undefined and the entry omits the field.
      const fxContext = buildFxContext(
        refund.currency,
        refund.amount,
        bt.currency,
        Math.abs(bt.amount),
      );

      return withFx(
        {
          date: epochToUtcDate(refund.created),
          currency: bt.currency.toUpperCase(),
          memo: refundMemo(charge, refund.id),
          sourceEventId: event.id,
          sourceEventType: event.type,
          sourceObjectId: refund.id,
          lines,
        },
        fxContext,
      );
    });

  return { entries, schedule: null };
}
