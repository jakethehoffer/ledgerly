import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import type { JournalEntry } from '../../src/journal.js';
import { mapEvent } from '../../src/engine.js';
import { checkBalance } from '../../src/journal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

// Clone the known-good annual fixture once and mutate only the amount and
// term, so each case reuses a fully-valid invoice/charge/BT shape. The base
// fixture recognizes 120000 over exactly 12 months (remainder 0), so the
// remainder-absorption branch — the single highest-risk line in the
// recognition math — is otherwise never exercised by a fixture.
const BASE: Stripe.Event = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'invoice_payment_succeeded_annual.event.json'), 'utf8'),
) as Stripe.Event;

const SECONDS_PER_DAY = 86400;

interface Case {
  readonly gross: number; // settlement-currency smallest units (same-currency: == amount_paid)
  readonly months: number;
  readonly tax?: number; // customer-currency tax; same-currency so taxInBT === tax
}

function makeEvent({ gross, months, tax = 0 }: Case): Stripe.Event {
  const ev = structuredClone(BASE);
  const inv = ev.data.object as unknown as {
    id: string;
    amount_due: number;
    amount_paid: number;
    total: number;
    tax: number | null;
    currency: string;
    charge: {
      amount: number;
      balance_transaction: { amount: number; fee: number; net: number; currency: string };
    };
    lines: { data: Array<{ amount: number; period: { start: number; end: number } }> };
  };

  // Same-currency (USD/USD), no Stripe fee, so net == gross and the deferred
  // basis is gross - tax. Keeps the test purely about recognition rounding.
  inv.id = `in_recog_${String(gross)}_${String(months)}`;
  inv.amount_due = gross;
  inv.amount_paid = gross;
  inv.total = gross;
  inv.tax = tax > 0 ? tax : null;
  inv.charge.amount = gross;
  inv.charge.balance_transaction.amount = gross;
  inv.charge.balance_transaction.fee = 0;
  inv.charge.balance_transaction.net = gross;

  const line = inv.lines.data[0];
  if (!line) throw new Error('base fixture lost its line item');
  // periodMonths = max(1, round(days / 30)); 30*months + 5 days lands cleanly
  // on `months` (the +5/30 ≈ 0.17 never rounds up).
  line.amount = gross;
  line.period.end = line.period.start + SECONDS_PER_DAY * (30 * months + 5);

  ev.id = `evt_recog_${String(gross)}_${String(months)}`;
  return ev;
}

function sumLine(entries: ReadonlyArray<JournalEntry>, code: string, side: 'debit' | 'credit'): number {
  let total = 0;
  for (const e of entries) {
    for (const l of e.lines) {
      if (l.accountCode === code && l.side === side) total += l.amount;
    }
  }
  return total;
}

// Each case picks an amount/term whose per-period split is NOT exact, so the
// remainder branch actually runs. Comments give floor base + remainder.
const CASES: ReadonlyArray<Case> = [
  { gross: 120000, months: 12 }, // base 10000, remainder 0 (divisible baseline)
  { gross: 120001, months: 12 }, // base 10000, remainder 1
  { gross: 120011, months: 12 }, // base 10000, remainder 11 (max for 12)
  { gross: 100000, months: 12 }, // base 8333,  remainder 4
  { gross: 99999, months: 12 }, // base 8333,  remainder 3
  { gross: 123457, months: 12 }, // base 10288, remainder 1
  { gross: 250000, months: 6 }, // base 41666, remainder 4
  { gross: 500011, months: 24 }, // base 20833, remainder 19
  { gross: 120000, months: 12, tax: 9611 }, // preTax 110389 → base 9199, remainder 1
];

describe('integration: revenue recognition rounding invariant', () => {
  for (const c of CASES) {
    const label = c.tax
      ? `${String(c.gross)} (tax ${String(c.tax)}) over ${String(c.months)} months`
      : `${String(c.gross)} over ${String(c.months)} months`;

    it(`recognizes ${label} with no penny lost and a balanced ledger`, () => {
      const result = mapEvent(makeEvent(c));

      // Annual/multi-month invoices defer then recognize on a schedule.
      expect(result.schedule).not.toBeNull();
      const schedule = result.schedule;
      if (!schedule) throw new Error('expected a recognition schedule');
      expect(schedule.entries.length).toBe(c.months);

      // The cash entry defers `preTax` to 2100; the schedule must drain exactly
      // that — no more (revenue invented), no less (penny stranded in deferred).
      const cash = result.entries[0];
      if (!cash) throw new Error('expected a cash entry');
      expect(checkBalance(cash).balanced).toBe(true);
      const deferred = sumLine([cash], '2100', 'credit');
      expect(deferred).toBeGreaterThan(0);

      const recognized = sumLine(schedule.entries, '2100', 'debit');
      const revenue = sumLine(schedule.entries, '4000', 'credit');
      expect(recognized).toBe(deferred); // 2100 nets to exactly zero across the lifecycle
      expect(revenue).toBe(deferred); // every recognized cent becomes revenue

      // Every schedule entry is itself balanced (2100 debit === 4000 credit).
      for (const e of schedule.entries) {
        expect(checkBalance(e).balanced).toBe(true);
      }

      // The remainder lands on the FINAL period; earlier periods are the floor.
      const base = Math.floor(deferred / c.months);
      const remainder = deferred - base * c.months;
      schedule.entries.forEach((e, i) => {
        const debit = e.lines.find((l) => l.accountCode === '2100' && l.side === 'debit');
        expect(debit?.amount).toBe(i === c.months - 1 ? base + remainder : base);
      });
    });
  }
});
