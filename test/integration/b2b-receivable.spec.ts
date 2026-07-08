import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import type { JournalEntry } from '../../src/journal.js';
import { mapEvent } from '../../src/engine.js';
import { computeBalances, flattenMapResult } from '../helpers/balances.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadEvent(name: string): Stripe.Event {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${name}.event.json`), 'utf8'),
  ) as Stripe.Event;
}

function replayAll(names: string[]): Partial<Record<string, number>> {
  const all: JournalEntry[] = [];
  for (const name of names) all.push(...flattenMapResult(mapEvent(loadEvent(name))));
  return computeBalances(all);
}

describe('integration: B2B net-terms (send_invoice) accounts-receivable lifecycle', () => {
  it('monthly: finalize accrues 1100 + revenue, payment clears 1100 — recognized once', () => {
    const balances = replayAll([
      'invoice_finalized_send_invoice_monthly',
      'invoice_payment_succeeded_send_invoice',
    ]);

    // Receivable parked at finalization ($540) and cleared at payment → zero.
    expect(balances['1100']).toBeUndefined();
    // Revenue recognized exactly once, at finalization (credit → negative).
    expect(balances['4000']).toBe(-50000);
    // Tax owed at finalization, held for the authority.
    expect(balances['2000']).toBe(-4000);
    // Cash + fee land at payment.
    expect(balances['1010']).toBe(52400);
    expect(balances['6000']).toBe(1600);

    const total = Object.values(balances).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('annual: finalize defers to 2100 against 1100; schedule drains 2100 to zero', () => {
    // The finalized MapResult carries the cash entry + the 12-month schedule.
    const balances = replayAll(['invoice_finalized_send_invoice_annual']);

    // Receivable outstanding until the customer pays (no payment event here).
    expect(balances['1100']).toBe(120000);
    // Deferred revenue fully recognized across the schedule → nets to zero.
    expect(balances['2100']).toBeUndefined();
    // All $1,200 recognized to revenue over the 12 monthly entries.
    expect(balances['4000']).toBe(-120000);
  });

  it('uncollectible: finalize then write-off clears 1100 to bad debt; revenue stays recognized', () => {
    const balances = replayAll([
      'invoice_finalized_send_invoice_monthly',
      'invoice_marked_uncollectible_send_invoice',
    ]);

    // Receivable written off → zero.
    expect(balances['1100']).toBeUndefined();
    // The shortfall lands in bad-debt expense (the full gross, $540).
    expect(balances['6200']).toBe(54000);
    // Revenue stays recognized — you earned it; the customer just didn't pay.
    expect(balances['4000']).toBe(-50000);
    // Tax stays as booked at invoicing.
    expect(balances['2000']).toBe(-4000);

    const total = Object.values(balances).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('uncollectible on a charge_automatically invoice is a no-op (no receivable was booked)', () => {
    const result = mapEvent(loadEvent('invoice_marked_uncollectible_charge_automatically'));
    expect(result.entries).toHaveLength(0);
    expect(result.schedule).toBeNull();
  });

  it('voided (monthly): finalize then void reverses the receivable, revenue, and tax to zero', () => {
    const balances = replayAll([
      'invoice_finalized_send_invoice_monthly',
      'invoice_voided_send_invoice_monthly',
    ]);

    // Unlike an uncollectible write-off, a void reverses everything the
    // finalization booked — the invoice is treated as if never issued.
    expect(balances['1100']).toBeUndefined();
    expect(balances['4000']).toBeUndefined();
    expect(balances['2000']).toBeUndefined();
    // No bad-debt expense: a void is not a shortfall, it is a cancellation.
    expect(balances['6200']).toBeUndefined();

    const total = Object.values(balances).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('voided on a charge_automatically invoice is a no-op (no receivable was booked)', () => {
    const result = mapEvent(loadEvent('invoice_voided_charge_automatically'));
    expect(result.entries).toHaveLength(0);
    expect(result.schedule).toBeNull();
  });

  it('refuses to void a net-terms invoice with a deferred-revenue schedule (stateful reversal not modeled)', () => {
    // The annual finalized fixture defers to 2100 and builds a 12-month
    // recognition schedule. Voiding it would require reversing however much
    // has already been recognized and cancelling the unposted remainder —
    // state the stateless engine doesn't have. Refuse loudly rather than
    // mis-post, exactly as the cross-currency B2B payment path does.
    const ev = loadEvent('invoice_finalized_send_invoice_annual');
    (ev as { type: string }).type = 'invoice.voided';
    expect(() => mapEvent(ev)).toThrow(/deferred-revenue schedule/);
  });

  it('charge_automatically finalized is a no-op (revenue books at payment instead)', () => {
    const result = mapEvent(loadEvent('invoice_finalized_charge_automatically'));
    expect(result.entries).toHaveLength(0);
    expect(result.schedule).toBeNull();
  });

  it('rejects a cross-currency B2B payment rather than mixing currencies in 1100', () => {
    const ev = loadEvent('invoice_payment_succeeded_send_invoice');
    const inv = ev.data.object as unknown as {
      currency: string;
      charge: { balance_transaction: { currency: string } };
    };
    // Invoice billed in USD but settled in CAD — not modeled yet.
    inv.charge.balance_transaction.currency = 'cad';
    expect(() => mapEvent(ev)).toThrow(/cross-currency B2B/);
  });
});
