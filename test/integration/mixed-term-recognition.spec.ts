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

// Clone the known-good annual fixture and bolt a one-time (instant-period)
// line onto it, so the invoice mixes a deferred annual subscription line with
// an immediately-earned setup fee — a common SaaS invoice shape. The one-time
// portion must be recognized NOW (4000) and only the subscription portion
// deferred (2100) and drawn down over the term. The pre-fix engine deferred
// the WHOLE invoice over 12 months.
const BASE: Stripe.Event = JSON.parse(
  fs.readFileSync(path.join(FIXTURE_DIR, 'invoice_payment_succeeded_annual.event.json'), 'utf8'),
) as Stripe.Event;

interface MixedCase {
  annual: number; // deferred subscription line (customer, pre-tax)
  oneTime: number; // immediate setup-fee line (customer, pre-tax)
  fee: number; // Stripe processing fee (settlement)
  tax: number; // invoice tax (customer); 0 = none
}

function makeEvent(c: MixedCase): Stripe.Event {
  const ev = structuredClone(BASE);
  const gross = c.annual + c.oneTime + c.tax; // amount_paid (customer == settlement here)
  const inv = ev.data.object as unknown as {
    id: string;
    amount_due: number;
    amount_paid: number;
    total: number;
    tax: number | null;
    charge: { amount: number; balance_transaction: { amount: number; fee: number; net: number } };
    lines: { data: Array<Record<string, unknown>> };
  };
  inv.id = 'in_mixed_term_001';
  inv.amount_due = gross;
  inv.amount_paid = gross;
  inv.total = gross;
  inv.tax = c.tax > 0 ? c.tax : null;
  inv.charge.amount = gross;
  inv.charge.balance_transaction.amount = gross;
  inv.charge.balance_transaction.fee = c.fee;
  inv.charge.balance_transaction.net = gross - c.fee;

  const annualLine = inv.lines.data[0] as Record<string, unknown>;
  annualLine['amount'] = c.annual; // keep its 365-day period from the base fixture
  inv.lines.data.push({
    id: 'il_onetime_setup_001',
    object: 'line_item',
    amount: c.oneTime,
    currency: 'usd',
    period: { start: 1736942400, end: 1736942400 }, // instant → one-time item
    proration: false,
    type: 'invoiceitem',
  });
  ev.id = 'evt_mixed_term_001';
  return ev;
}

function creditOf(entry: JournalEntry, code: string): number {
  return entry.lines
    .filter((l) => l.accountCode === code && l.side === 'credit')
    .reduce((s, l) => s + l.amount, 0);
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

describe('integration: mixed-term invoice recognition (annual sub + one-time fee)', () => {
  it('recognizes the one-time fee now and defers only the subscription portion', () => {
    const c: MixedCase = { annual: 120000, oneTime: 30000, fee: 4500, tax: 0 };
    const result = mapEvent(makeEvent(c));

    const cash = result.entries[0];
    if (!cash) throw new Error('expected a cash entry');
    expect(checkBalance(cash).balanced).toBe(true);

    // One-time fee recognized immediately; subscription portion deferred.
    expect(creditOf(cash, '4000')).toBe(c.oneTime); // $300 earned now
    expect(creditOf(cash, '2100')).toBe(c.annual); // $1200 deferred

    // Schedule drains exactly the deferred subscription portion — no more, no less.
    const schedule = result.schedule;
    if (!schedule) throw new Error('expected a recognition schedule');
    expect(schedule.entries.length).toBe(12);
    expect(sumLine(schedule.entries, '2100', 'debit')).toBe(c.annual);
    expect(sumLine(schedule.entries, '4000', 'credit')).toBe(c.annual);
    for (const e of schedule.entries) expect(checkBalance(e).balanced).toBe(true);

    // Total revenue recognized across the whole lifecycle = pre-tax invoice.
    const totalRevenue = creditOf(cash, '4000') + sumLine(schedule.entries, '4000', 'credit');
    expect(totalRevenue).toBe(c.annual + c.oneTime);
  });

  it('splits pre-tax revenue but keeps tax fully in 2000 at collection', () => {
    const c: MixedCase = { annual: 120000, oneTime: 30000, fee: 4500, tax: 12000 };
    const result = mapEvent(makeEvent(c));

    const cash = result.entries[0];
    if (!cash) throw new Error('expected a cash entry');
    expect(checkBalance(cash).balanced).toBe(true);

    // Tax is owed now regardless of recognition timing.
    expect(creditOf(cash, '2000')).toBe(c.tax);
    // Pre-tax splits into immediate (one-time) + deferred (subscription).
    expect(creditOf(cash, '4000')).toBe(c.oneTime);
    expect(creditOf(cash, '2100')).toBe(c.annual);

    const schedule = result.schedule;
    if (!schedule) throw new Error('expected a recognition schedule');
    expect(sumLine(schedule.entries, '4000', 'credit')).toBe(c.annual);

    // Immediate revenue + deferred revenue + tax == gross (all balanced).
    const gross = c.annual + c.oneTime + c.tax;
    expect(creditOf(cash, '4000') + creditOf(cash, '2100') + creditOf(cash, '2000')).toBe(gross);
  });
});
