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

function replayAll(eventNames: string[]): {
  entries: JournalEntry[];
  balances: Partial<Record<string, number>>;
} {
  const allEntries: JournalEntry[] = [];
  for (const name of eventNames) {
    const result = mapEvent(loadEvent(name));
    allEntries.push(...flattenMapResult(result));
  }
  return { entries: allEntries, balances: computeBalances(allEntries) };
}

describe('integration: dispute won lifecycle', () => {
  it('charge -> funds_withdrawn -> funds_reinstated leaves clean books with only the fee as loss', () => {
    const { balances } = replayAll([
      'charge_succeeded_standard',
      'dispute_funds_withdrawn_standard',
      'dispute_funds_reinstated_won',
    ]);

    // Asset side
    expect(balances['1010']).toBe(8180); // Stripe Clearing: 9680 - 11500 + 10000 = 8180 ($81.80)
    expect(balances['1200']).toBeUndefined(); // Disputes Receivable resolved to zero (omitted by helper)

    // Expense side
    expect(balances['6000']).toBe(320);  // Stripe processing fee from original charge ($3.20)
    expect(balances['6100']).toBe(1500); // Dispute fee, non-refundable even on win ($15.00)

    // Revenue side (credit balances are negative under the helper's convention)
    expect(balances['4000']).toBe(-10000); // Original revenue recognized ($100.00 credit)

    // Cross-entry invariant: total debits === total credits, so sum must be zero
    const total = Object.values(balances).reduce<number>((acc, v) => acc + (v ?? 0), 0);
    expect(total).toBe(0);
  });
});

describe('integration: dispute lost lifecycle', () => {
  it('charge -> funds_withdrawn -> closed_lost drains Stripe balance and posts full loss to disputes expense', () => {
    const { balances } = replayAll([
      'charge_succeeded_standard',
      'dispute_funds_withdrawn_standard',
      'dispute_closed_lost',
    ]);

    // Asset side
    expect(balances['1010']).toBe(-1820); // 9680 - 11500 = -1820 (Stripe balance negative; real chargebacks exceed net collected)
    expect(balances['1200']).toBeUndefined(); // Receivable cleared via writeoff (resolved to zero)

    // Expense side
    expect(balances['6000']).toBe(320);   // Original Stripe processing fee
    expect(balances['6100']).toBe(11500); // Dispute fee (1500) + writeoff of disputed amount (10000) = 11500 ($115)

    // Revenue side
    expect(balances['4000']).toBe(-10000); // Revenue was recognized; the engine doesn't reverse it on chargeback (CPA decision: chargeback is a separate expense, not a contra-revenue, in this chart of accounts)

    // Cross-entry invariant: balanced books
    const total = Object.values(balances).reduce<number>((acc, v) => acc + (v ?? 0), 0);
    expect(total).toBe(0);
  });
});

describe('integration: annual subscription recognition', () => {
  it('invoice_payment_succeeded_annual drains deferred revenue to zero over 12 monthly recognitions', () => {
    const { balances } = replayAll([
      'invoice_payment_succeeded_annual',
    ]);

    // After all 13 entries (1 cash + 12 schedule):
    // - 1010 should hold the net cash: 120000 - 3600 = 116400 ($1164)
    // - 6000 should hold the fee: 3600 ($36)
    // - 2100 should be fully drained: 0 (omitted by helper)
    // - 4000 should hold the full recognized revenue: -120000 ($1200 credit)

    expect(balances['1010']).toBe(116400);
    expect(balances['6000']).toBe(3600);
    expect(balances['2100']).toBeUndefined(); // Deferred revenue fully recognized
    expect(balances['4000']).toBe(-120000);

    // Cross-entry invariant
    const total = Object.values(balances).reduce<number>((acc, v) => acc + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('produces 1 cash entry + 12 monthly recognition entries (13 total)', () => {
    const { entries } = replayAll(['invoice_payment_succeeded_annual']);
    expect(entries.length).toBe(13);
  });
});
