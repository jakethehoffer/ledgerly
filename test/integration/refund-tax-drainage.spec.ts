import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from '../../src/engine.js';
import { checkBalance } from '../../src/journal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

// Clone the known-good single-refund-with-tax fixture for its fully-valid
// expanded-invoice shape, then synthesize multi-refund sequences. The base
// fixture refunds 5500 of 11000 with tax 1000 — and 5500*1000/11000 = 500.0
// exactly, so it never exercises tax-rounding drift. No fixture covers a
// *taxed* charge refunded across *multiple* partial refunds, which is where
// independent per-refund rounding can over/under-drain 2000 Sales Tax Payable.
const BASE: Stripe.Event = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'charge_refunded_with_tax.event.json'), 'utf8'),
) as Stripe.Event;

interface RefundShape {
  id: string;
  object: 'refund';
  amount: number;
  currency: string;
  charge: string;
  created: number;
  reason: string;
  status: string;
  balance_transaction: {
    id: string;
    object: 'balance_transaction';
    amount: number;
    net: number;
    currency: string;
    exchange_rate: null;
    fee: number;
    fee_details: [];
    reporting_category: 'refund';
    status: 'available';
    type: 'refund';
    created: number;
    available_on: number;
  };
}

interface MutableCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  balance_transaction: string;
  currency: string;
  invoice: { tax: number; amount_paid: number; amount_due: number; total: number; currency: string };
  refunds: { object: 'list'; data: RefundShape[]; has_more: boolean; total_count: number; url: string };
}

function makeRefund(id: string, amount: number, created: number): RefundShape {
  return {
    id,
    object: 'refund',
    amount,
    currency: 'usd',
    charge: 'ch_drain',
    created,
    reason: 'requested_by_customer',
    status: 'succeeded',
    balance_transaction: {
      id: `txn_${id}`,
      object: 'balance_transaction',
      amount: -amount,
      net: -amount,
      currency: 'usd',
      exchange_rate: null,
      fee: 0,
      fee_details: [],
      reporting_category: 'refund',
      status: 'available',
      type: 'refund',
      created,
      available_on: created + 216000,
    },
  };
}

/**
 * Build the sequence of `charge.refunded` events for a charge of `chargeAmount`
 * (tax-inclusive) carrying `tax`, refunded in `splits` order. Event i carries
 * the cumulative refund list through refund i (as Stripe redelivers it) and is
 * stamped with refund i's `created` time, so the handler isolates refund i.
 */
function buildRefundEvents(chargeAmount: number, tax: number, splits: number[]): Stripe.Event[] {
  const refunds = splits.map((amount, i) => makeRefund(`re_${String(i + 1)}`, amount, 1000 + i * 1000));
  return splits.map((_, i) => {
    const ev = structuredClone(BASE);
    const charge = ev.data.object as unknown as MutableCharge;
    charge.id = 'ch_drain';
    charge.amount = chargeAmount;
    charge.balance_transaction = 'txn_drain'; // string id → originalRate falls back to 1.0 (same currency)
    charge.amount_refunded = splits.slice(0, i + 1).reduce((s, a) => s + a, 0);
    charge.invoice.tax = tax;
    charge.invoice.amount_paid = chargeAmount;
    charge.invoice.amount_due = chargeAmount;
    charge.invoice.total = chargeAmount;
    charge.refunds.data = refunds.slice(0, i + 1);
    charge.refunds.total_count = i + 1;
    ev.id = `evt_drain_${String(i + 1)}`;
    (ev as unknown as { created: number }).created = refunds[i]!.created;
    return ev;
  });
}

function taxDebitsAcross(events: Stripe.Event[]): number {
  let total = 0;
  for (const ev of events) {
    const result = mapEvent(ev);
    for (const e of result.entries) {
      expect(checkBalance(e).balanced).toBe(true);
      for (const l of e.lines) {
        if (l.accountCode === '2000' && l.side === 'debit') total += l.amount;
      }
    }
  }
  return total;
}

interface Case {
  chargeAmount: number;
  tax: number;
  splits: number[];
  desc: string;
}

// Each charge is fully refunded (splits sum to chargeAmount), so the tax
// reversed across 2000 debits MUST equal the tax collected at charge time —
// otherwise Sales Tax Payable never returns to zero on a fully-refunded sale.
const CASES: ReadonlyArray<Case> = [
  { chargeAmount: 11000, tax: 825, splits: [5500, 5500], desc: 'two halves, each tax lands on x.5 (drifts +1)' },
  { chargeAmount: 11000, tax: 1000, splits: [3667, 3667, 3666], desc: 'three thirds (drifts -1)' },
  { chargeAmount: 10000, tax: 500, splits: [3333, 3333, 3334], desc: 'three thirds at 5% (drifts +1)' },
  { chargeAmount: 11000, tax: 1000, splits: [5500, 5500], desc: 'two halves, exact (control: no drift)' },
  { chargeAmount: 12000, tax: 960, splits: [4000, 4000, 4000], desc: 'three even, exact (control)' },
];

describe('integration: refund sales-tax drainage invariant', () => {
  for (const c of CASES) {
    it(`reverses exactly the collected tax — ${c.desc}`, () => {
      const events = buildRefundEvents(c.chargeAmount, c.tax, c.splits);
      expect(taxDebitsAcross(events)).toBe(c.tax);
    });
  }
});

// FX variant: the charge settled in a different currency than it was billed in,
// so tax was collected in SETTLEMENT currency at charge time
// (taxInBT = round(chargeBt * tax / chargeAmount)). A multi-refund sequence must
// drain exactly that settlement tax — otherwise Sales Tax Payable strands a cent
// under FX the same way it did same-currency before the cumulative fix. The
// refund BTs post at the original charge rate (no rate drift), so 7000 stays out
// of it and this isolates the tax-rounding path.
interface FxCase {
  chargeAmount: number; // customer-currency total
  chargeBt: number; // settlement-currency charge BT amount (defines the rate)
  tax: number; // customer-currency tax
  custSplits: number[]; // per-refund customer amounts (sum to chargeAmount)
  desc: string;
}

function buildFxRefundEvents(fx: FxCase): Stripe.Event[] {
  const rate = fx.chargeBt / fx.chargeAmount;
  const settleSplits = fx.custSplits.map((a) => Math.round(a * rate));
  const refunds = fx.custSplits.map((amount, i) => {
    const r = makeRefund(`re_fx_${String(i + 1)}`, amount, 2000 + i * 1000);
    // Settlement-currency BT: clawback posts in CAD at the original rate.
    r.balance_transaction.amount = -settleSplits[i]!;
    r.balance_transaction.net = -settleSplits[i]!;
    r.balance_transaction.currency = 'cad';
    return r;
  });
  return fx.custSplits.map((_, i) => {
    const ev = structuredClone(BASE);
    const charge = ev.data.object as unknown as MutableCharge & {
      balance_transaction: { amount: number; currency: string };
    };
    charge.id = 'ch_fx_drain';
    charge.amount = fx.chargeAmount;
    charge.currency = 'usd';
    // Expanded charge BT (object, not string) so the handler recovers the rate.
    (charge as unknown as { balance_transaction: unknown }).balance_transaction = {
      id: 'txn_fx_charge',
      object: 'balance_transaction',
      amount: fx.chargeBt,
      net: fx.chargeBt,
      fee: 0,
      currency: 'cad',
      exchange_rate: rate,
      reporting_category: 'charge',
      type: 'charge',
      status: 'available',
      created: 1000,
      available_on: 1000,
    };
    charge.amount_refunded = fx.custSplits.slice(0, i + 1).reduce((s, a) => s + a, 0);
    charge.invoice.tax = fx.tax;
    charge.invoice.amount_paid = fx.chargeAmount;
    charge.invoice.amount_due = fx.chargeAmount;
    charge.invoice.total = fx.chargeAmount;
    charge.invoice.currency = 'usd';
    charge.refunds.data = refunds.slice(0, i + 1);
    charge.refunds.total_count = i + 1;
    ev.id = `evt_fx_drain_${String(i + 1)}`;
    (ev as unknown as { created: number }).created = refunds[i]!.created;
    return ev;
  });
}

const FX_CASES: ReadonlyArray<FxCase> = [
  // rate 1.3344; Σround(split*rate)=13345 ≠ chargeBt 13344, and 13344*0.10=1334.4
  // rounds to 1334 while the drifted 13345*0.10=1334.5 rounds to 1335 — so the
  // old settlement-cumulative basis over-drains by a cent.
  {
    chargeAmount: 10000,
    chargeBt: 13344,
    tax: 1000,
    custSplits: [3334, 3333, 3333],
    desc: 'rate 1.3344, three thirds, settlement rounding drifts the tax',
  },
  // Control: clean rate, drainage already exact on old and new code.
  {
    chargeAmount: 10000,
    chargeBt: 13000,
    tax: 1000,
    custSplits: [5000, 5000],
    desc: 'rate 1.30, two halves, exact (control)',
  },
];

describe('integration: refund sales-tax drainage invariant under FX', () => {
  for (const fx of FX_CASES) {
    it(`drains exactly the settlement-currency tax — ${fx.desc}`, () => {
      const events = buildFxRefundEvents(fx);
      const expectedSettlementTax = Math.round((fx.chargeBt * fx.tax) / fx.chargeAmount);
      expect(taxDebitsAcross(events)).toBe(expectedSettlementTax);
    });
  }
});
