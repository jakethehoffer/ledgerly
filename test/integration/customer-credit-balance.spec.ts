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

function replayAll(events: Stripe.Event[]): Partial<Record<string, number>> {
  const all: JournalEntry[] = [];
  for (const ev of events) all.push(...flattenMapResult(mapEvent(ev)));
  return computeBalances(all);
}

function replay(names: string[]): Partial<Record<string, number>> {
  return replayAll(names.map(loadEvent));
}

describe('integration: customer credit balance (2200) issue + consume lifecycle', () => {
  it('issue leg: a post-payment credit note to balance reverses revenue and books the 2200 liability', () => {
    const balances = replay(['credit_note_created_post_payment_to_balance']);

    // Liability accrues the full credit owed (credit balance → negative).
    expect(balances['2200']).toBe(-5500);
    // Revenue reversed (the paid invoice's recognition is unwound — debit → positive).
    expect(balances['4000']).toBe(5000);
    // Sales tax reversed too.
    expect(balances['2000']).toBe(500);

    const total = Object.values(balances).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('consume leg: an invoice paid from the credit balance recognizes revenue and drains 2200', () => {
    const balances = replay(['invoice_payment_succeeded_paid_from_credit_balance']);

    // Liability drains as the credit is spent (debit → positive).
    expect(balances['2200']).toBe(5500);
    // Revenue recognized now — the service the credit funds is delivered.
    expect(balances['4000']).toBe(-5000);
    expect(balances['2000']).toBe(-500);

    const total = Object.values(balances).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('full lifecycle: 2200 nets to zero across issue+consume and revenue is recognized exactly once', () => {
    // The economic story, in order:
    //   1. An invoice is paid by card → revenue recognized (Cr 4000).
    //   2. A post-payment credit note returns that money as account credit → the
    //      premature recognition is reversed (Dr 4000) and the liability booked
    //      (Cr 2200). The cash already collected stays put.
    //   3. A later invoice is paid from that credit → the service is delivered,
    //      so revenue is recognized (Cr 4000) and the liability drains (Dr 2200).
    // Net across all three: revenue lands exactly ONCE (at consume, when the
    // service is delivered), not double-counted against the original paid invoice.
    const balances = replay([
      'invoice_payment_succeeded_monthly_with_tax',
      'credit_note_created_post_payment_to_balance',
      'invoice_payment_succeeded_paid_from_credit_balance',
    ]);

    // 2200 issued (Cr 5500) then consumed (Dr 5500) → nets to zero.
    expect(balances['2200']).toBeUndefined();
    // Revenue recognized exactly once: -5000 (orig) +5000 (reversed) -5000 (consume).
    expect(balances['4000']).toBe(-5000);
    // Sales tax likewise owed exactly once.
    expect(balances['2000']).toBe(-500);
    // The original card payment's cash and fee stay booked (they are real).
    expect(balances['1010']).toBe(5307);
    expect(balances['6000']).toBe(193);

    const total = Object.values(balances).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('issue then void: voiding the credit note claws back the credit and restores revenue', () => {
    const balances = replay([
      'credit_note_created_post_payment_to_balance',
      'credit_note_voided_post_payment_to_balance',
    ]);

    // The issue leg booked 2200/4000/2000; voiding it un-books them exactly.
    expect(balances['2200']).toBeUndefined();
    expect(balances['4000']).toBeUndefined();
    expect(balances['2000']).toBeUndefined();

    const total = Object.values(balances).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('out-of-band paid invoice (charge null, balance untouched) is a no-op — no fabricated revenue', () => {
    const result = mapEvent(loadEvent('invoice_payment_succeeded_out_of_band'));
    expect(result.entries).toHaveLength(0);
    expect(result.schedule).toBeNull();
  });

  it('partial credit balance (credit does not cover the whole invoice) is a no-op — proportioning not modeled', () => {
    // Same credit-balance invoice, but only part of the total came from balance
    // (ending_balance short of a full draw-down): booking the covered slice alone
    // would drop the rest of the revenue, so refuse until the split is modeled.
    const ev = loadEvent('invoice_payment_succeeded_paid_from_credit_balance');
    const inv = ev.data.object as unknown as { ending_balance: number };
    inv.ending_balance = -2000; // applied = -2000 - (-5500) = 3500 < total 5500
    const result = mapEvent(ev);
    expect(result.entries).toHaveLength(0);
    expect(result.schedule).toBeNull();
  });

  it('refund-backed post-payment credit note stays a no-op (booked by charge.refunded)', () => {
    const result = mapEvent(loadEvent('credit_note_created_post_payment'));
    expect(result.entries).toHaveLength(0);
    expect(result.schedule).toBeNull();
  });

  it('a B2B (send_invoice) invoice fully funded by balance recognizes revenue once, without double-counting or stranding 1100', () => {
    // A net-terms invoice recognizes revenue at finalization (Dr 1100 / Cr 4000).
    // The consume leg does not check collection_method — but it can only fire when
    // the credit covers the WHOLE invoice, which means amount_due was 0 at
    // finalization, and invoice.finalized no-ops on amount_due 0. So finalization
    // books nothing, the consume leg is the sole recognizer, and there is no
    // double-count and no receivable left stranded — for either collection method.
    const finalized = loadEvent('invoice_payment_succeeded_paid_from_credit_balance');
    (finalized as { type: string }).type = 'invoice.finalized';
    const finInv = finalized.data.object as unknown as {
      collection_method: string;
      amount_due: number;
    };
    finInv.collection_method = 'send_invoice';
    finInv.amount_due = 0;
    expect(mapEvent(finalized).entries).toHaveLength(0);

    const consume = loadEvent('invoice_payment_succeeded_paid_from_credit_balance');
    (consume.data.object as unknown as { collection_method: string }).collection_method =
      'send_invoice';
    const balances = computeBalances(flattenMapResult(mapEvent(consume)));
    // Revenue recognized exactly once, at consume; no 1100 receivable touched.
    expect(balances['4000']).toBe(-5000);
    expect(balances['2000']).toBe(-500);
    expect(balances['2200']).toBe(5500);
    expect(balances['1100']).toBeUndefined();
  });
});
