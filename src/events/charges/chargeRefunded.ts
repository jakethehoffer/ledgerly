import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { buildFxContext, withFx } from '../../util/fxContext.js';
import { sortLines } from '../../util/lines.js';
import { refundMemo } from '../../util/memo.js';

export function handleChargeRefunded(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.refunded') {
    throw new Error(`handleChargeRefunded received wrong event type: ${event.type}`);
  }
  const charge = event.data.object;

  const refundsList = charge.refunds;
  if (!refundsList || refundsList.data.length === 0) {
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

  // Cumulative tax allocation. Order every refund on the charge by creation so
  // each refund's sales-tax share is computed as
  //   round(cumulativeThrough * taxRatio) - round(cumulativeBefore * taxRatio)
  // rather than rounding each refund's tax independently. Independent rounding
  // drifts: two 5500 refunds of an 11000 / tax-825 charge each round 412.5 -> 413,
  // reversing 826 against the 825 collected and stranding -1 in 2000 Sales Tax
  // Payable after a full refund. The cumulative form telescopes to exactly the
  // collected tax once the charge is fully refunded, and reduces to the previous
  // per-refund value for the single-refund and no-tax cases (cumulativeBefore = 0
  // or taxRatio = 0) — so existing fixtures stay byte-identical.
  const expectedSettlementOf = (r: Stripe.Refund): number =>
    Math.round(r.amount * originalRate);
  const cumulativeBeforeById = new Map<string, number>();
  {
    const ordered = [...refundsList.data].sort((a, b) =>
      a.created !== b.created ? a.created - b.created : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    let running = 0;
    for (const r of ordered) {
      cumulativeBeforeById.set(r.id, running);
      running += expectedSettlementOf(r);
    }
  }

  const entries: JournalEntry[] = targetRefunds.map((refund) => {
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
    const actualSettlement = Math.abs(bt.amount);
    const expectedSettlement = expectedSettlementOf(refund);
    const fxDelta = actualSettlement - expectedSettlement;

    // Tax share via cumulative rounding (see cumulativeBeforeById above) so the
    // 2000 reversals across a multi-refund sequence sum to exactly the tax
    // collected at charge time. Reduces to the prior per-refund value when
    // there's no tax (taxRatio = 0) or this is the first/only refund.
    const cumulativeBefore = cumulativeBeforeById.get(refund.id) ?? 0;
    const taxPortion =
      taxRatio > 0
        ? Math.round((cumulativeBefore + expectedSettlement) * taxRatio) -
          Math.round(cumulativeBefore * taxRatio)
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
