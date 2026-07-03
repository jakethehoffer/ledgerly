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

describe('integration: dispute won lifecycle under FX (rate drift)', () => {
  // Same dispute as dispute_funds_withdrawn_fx_rate_drift (dp_test_fx_drift_001):
  // USD 5000 charge settled in CAD at rate 1.30 (1200 parked at 6500 CAD), then
  // reinstated at a drifted rate 1.35 (6750 CAD actually returned). The clearing
  // account 1200 must still net to zero — it releases at the ORIGINAL rate (6500),
  // and the 250 CAD rate-movement delta lands in 7000 as an FX gain.
  it('charge clawed back then reinstated at a drifted rate still clears 1200 to zero', () => {
    const { balances } = replayAll([
      'dispute_funds_withdrawn_fx_rate_drift',
      'dispute_funds_reinstated_fx_rate_drift',
    ]);

    expect(balances['1200']).toBeUndefined(); // receivable fully cleared despite rate drift
    expect(balances['1010']).toBe(-2250);     // -9000 withdrawn + 6750 reinstated
    expect(balances['6100']).toBe(2000);      // non-refundable dispute fee (CAD)
    expect(balances['7000']).toBe(250);       // net FX: 500 loss at withdrawal - 250 gain at reinstatement

    const total = Object.values(balances).reduce<number>((acc, v) => acc + (v ?? 0), 0);
    expect(total).toBe(0);
  });
});

describe('integration: dispute lost lifecycle under FX', () => {
  // Alternate ending of the same withdrawn dispute: lost instead of won. The
  // receivable was parked at 6500 CAD (original rate); the writeoff to 6100 must
  // release it at that same carried value and in the settlement currency (CAD),
  // not the customer-facing 5000 USD — otherwise 1200 strands and the account
  // mixes currencies.
  it('charge clawed back then closed lost writes off the receivable at its carried CAD value', () => {
    const { balances } = replayAll([
      'dispute_funds_withdrawn_fx_rate_drift',
      'dispute_closed_lost_fx',
    ]);

    expect(balances['1200']).toBeUndefined(); // receivable cleared via writeoff (no currency mixing)
    expect(balances['1010']).toBe(-9000);     // funds withdrawn, never returned
    expect(balances['6100']).toBe(8500);      // dispute fee 2000 + writeoff 6500 (CAD)
    expect(balances['7000']).toBe(500);       // FX loss realized at withdrawal; close adds none

    const total = Object.values(balances).reduce<number>((acc, v) => acc + (v ?? 0), 0);
    expect(total).toBe(0);
  });
});

describe('integration: small-value dispute lifecycle (fee > disputed amount)', () => {
  // A $9.99 charge disputed incurs a ~$15 dispute fee, so Stripe's shape-2
  // withdrawal has a fee BT (1500) LARGER than the clawback BT (999). The
  // withdrawal must still park exactly the disputed principal (999) in 1200 and
  // expense the fee (1500) to 6100 — otherwise the receivable strands when the
  // dispute later resolves against dispute.amount (999). Build the reinstated /
  // closed events from the same dispute so the whole lifecycle is exercised.
  const withdrawn = loadEvent('dispute_funds_withdrawn_small_amount');
  const disputeOf = (ev: Stripe.Event): Record<string, unknown> =>
    (ev.data.object as unknown as Record<string, unknown>);

  function buildReinstated(): Stripe.Event {
    const ev = structuredClone(withdrawn);
    ev.id = 'evt_test_dispute_reinstated_small_001';
    (ev as unknown as { type: string }).type = 'charge.dispute.funds_reinstated';
    const dispute = disputeOf(ev);
    dispute['status'] = 'won';
    dispute['balance_transactions'] = [
      {
        id: 'txn_dispute_small_reinstate_001',
        object: 'balance_transaction',
        amount: 999,
        net: 999,
        fee: 0,
        fee_details: [],
        currency: 'usd',
        reporting_category: 'dispute',
        type: 'adjustment',
        status: 'available',
        created: 1737201600,
        available_on: 1737417600,
      },
    ];
    return ev;
  }

  function buildClosedLost(): Stripe.Event {
    const ev = structuredClone(withdrawn);
    ev.id = 'evt_test_dispute_closed_small_001';
    (ev as unknown as { type: string }).type = 'charge.dispute.closed';
    const dispute = disputeOf(ev);
    dispute['status'] = 'lost';
    return ev;
  }

  it('withdrawn parks the disputed principal (not the larger fee) in 1200', () => {
    const result = mapEvent(withdrawn);
    const entry = result.entries[0];
    if (!entry) throw new Error('expected an entry');
    const receivable = entry.lines.find((l) => l.accountCode === '1200');
    const feeExpense = entry.lines.find((l) => l.accountCode === '6100');
    expect(receivable?.amount).toBe(999); // disputed principal, not the 1500 fee
    expect(feeExpense?.amount).toBe(1500); // non-refundable dispute fee
    // No phantom 7000 line: same-currency, so no FX delta once the split is right.
    expect(entry.lines.some((l) => l.accountCode === '7000')).toBe(false);
  });

  it('withdrawn -> reinstated (won) clears 1200 to zero, only the fee remains as loss', () => {
    const allEntries: JournalEntry[] = [];
    for (const ev of [withdrawn, buildReinstated()]) {
      allEntries.push(...flattenMapResult(mapEvent(ev)));
    }
    const balances: Partial<Record<string, number>> = computeBalances(allEntries);
    expect(balances['1200']).toBeUndefined(); // receivable fully cleared
    expect(balances['1010']).toBe(-1500);     // -2499 withdrawn + 999 reinstated
    expect(balances['6100']).toBe(1500);      // only the non-refundable fee
    const total = Object.values(balances).reduce<number>((acc, v) => acc + (v ?? 0), 0);
    expect(total).toBe(0);
  });

  it('withdrawn -> closed_lost clears 1200 and posts principal + fee to 6100', () => {
    const allEntries: JournalEntry[] = [];
    for (const ev of [withdrawn, buildClosedLost()]) {
      allEntries.push(...flattenMapResult(mapEvent(ev)));
    }
    const balances: Partial<Record<string, number>> = computeBalances(allEntries);
    expect(balances['1200']).toBeUndefined(); // receivable written off to zero
    expect(balances['1010']).toBe(-2499);     // funds withdrawn, never returned
    expect(balances['6100']).toBe(2499);      // fee 1500 + writeoff of principal 999
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
