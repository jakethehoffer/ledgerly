import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from '../../src/engine.js';
import { toQbo, toQboSchedule } from '../../src/exporters/qbo.js';
import { TEST_QBO_ACCOUNT_MAP } from '../fixtures/test-account-maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

const FIXTURES = [
  'charge_succeeded_standard',
  'charge_succeeded_eur',
  'charge_succeeded_jpy',
  'charge_succeeded_trial_conversion',
  'charge_succeeded_with_app_fee',
  'charge_refunded_full',
  'charge_refunded_multi_first',
  'charge_refunded_multi_second',
  'charge_refunded_partial',
  'charge_refunded_with_tax',
  'charge_refunded_fx',
  'dispute_closed_lost',
  'dispute_funds_reinstated_won',
  'dispute_funds_withdrawn_standard',
  'dispute_funds_withdrawn_fx',
  'dispute_funds_withdrawn_fx_rate_drift',
  'invoice_payment_succeeded_monthly',
  'invoice_payment_succeeded_monthly_with_tax',
  'invoice_payment_succeeded_annual',
  'invoice_payment_succeeded_annual_with_tax',
  'invoice_payment_succeeded_annual_fx',
  'invoice_payment_succeeded_prorated_upgrade',
  'invoice_payment_succeeded_prorated_downgrade',
  'invoice_payment_succeeded_with_app_fee',
  'payout_failed_standard',
  'payout_paid_standard',
];

describe('toQbo (cash entry)', () => {
  for (const name of FIXTURES) {
    it(`${name}: matches golden QBO output`, () => {
      const event = loadJson(`${name}.event.json`) as Stripe.Event;
      const expectedQbo = loadJson(`${name}.qbo.json`);
      const result = mapEvent(event);
      expect(result.entries.length).toBeGreaterThan(0);
      const qbo = toQbo(result.entries[0]!, TEST_QBO_ACCOUNT_MAP);
      expect(qbo).toEqual(expectedQbo);
    });
  }
});

describe('toQboSchedule', () => {
  it('invoice_payment_succeeded_annual: matches the golden schedule output', () => {
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as Stripe.Event;
    const expected = loadJson('invoice_payment_succeeded_annual.schedule.qbo.json');
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const qboEntries = toQboSchedule(result.schedule!, TEST_QBO_ACCOUNT_MAP);
    expect(qboEntries).toEqual(expected);
  });

  it('invoice_payment_succeeded_annual: 12 entries each balance debit==credit', () => {
    // Cheap per-entry invariant in addition to the golden diff above: catches
    // the case where a future change accidentally produces a structurally
    // valid but unbalanced entry that the golden also reflects.
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as Stripe.Event;
    const result = mapEvent(event);
    const qboEntries = toQboSchedule(result.schedule!, TEST_QBO_ACCOUNT_MAP);
    expect(qboEntries).toHaveLength(12);
    for (const qbo of qboEntries) {
      const debit = qbo.Line.find((l) => l.JournalEntryLineDetail.PostingType === 'Debit');
      const credit = qbo.Line.find((l) => l.JournalEntryLineDetail.PostingType === 'Credit');
      expect(debit).toBeDefined();
      expect(credit).toBeDefined();
      expect(debit!.Amount).toBe(credit!.Amount);
    }
  });

  it('invoice_payment_succeeded_annual: each entry has a unique DocNumber', () => {
    // Schedule entries share the same sourceEventId, so default DocNumber
    // truncation would collide. Verify the disambiguation pattern produces
    // 12 distinct values within QBO's 21-char limit.
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as Stripe.Event;
    const result = mapEvent(event);
    const qboEntries = toQboSchedule(result.schedule!, TEST_QBO_ACCOUNT_MAP);
    const docNumbers = qboEntries.map((e) => e.DocNumber);
    expect(new Set(docNumbers).size).toBe(12);
    for (const d of docNumbers) {
      expect(d).toBeDefined();
      expect(d!.length).toBeLessThanOrEqual(21);
    }
  });

  it('invoice_payment_succeeded_annual_with_tax: matches the golden schedule output', () => {
    // Tax-aware annual: gross 110000 = preTax 100000 (revenue) + 10000 (tax).
    // The schedule recognizes the preTax portion across 12 months: floor(100000/12)
    // = 8333 per month for the first 11 months, with month 12 absorbing the
    // 100000 - 8333*12 = 4-cent remainder so the schedule sums to 100000 exactly.
    // The golden captures this rounding pattern.
    const event = loadJson(
      'invoice_payment_succeeded_annual_with_tax.event.json',
    ) as Stripe.Event;
    const expected = loadJson(
      'invoice_payment_succeeded_annual_with_tax.schedule.qbo.json',
    );
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const qboEntries = toQboSchedule(result.schedule!, TEST_QBO_ACCOUNT_MAP);
    expect(qboEntries).toEqual(expected);
  });

  it('invoice_payment_succeeded_annual_fx: matches the golden schedule output (per-month fxContext)', () => {
    // FX annual: USD-1200 invoice settled in CAD at rate 1.30 → CAD 1560.
    // Each of the 12 recognition entries posts CAD 130 (2100 debit / 4000
    // credit) and carries pro-rated fxContext { USD 100 / CAD 130 } so
    // downstream tools can compute home-currency FX revaluation per month.
    const event = loadJson(
      'invoice_payment_succeeded_annual_fx.event.json',
    ) as Stripe.Event;
    const expected = loadJson(
      'invoice_payment_succeeded_annual_fx.schedule.qbo.json',
    );
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const qboEntries = toQboSchedule(result.schedule!, TEST_QBO_ACCOUNT_MAP);
    expect(qboEntries).toEqual(expected);
  });

  it('invoice_payment_succeeded_annual_with_tax: schedule sums to preTax exactly', () => {
    // The remainder-absorption pattern means every per-month amount differs
    // slightly. Sum them and assert the total matches the pre-tax portion
    // (1000 dollars major-unit) — this is what makes the schedule a valid
    // drawdown of the 2100 Deferred Revenue posting.
    const event = loadJson(
      'invoice_payment_succeeded_annual_with_tax.event.json',
    ) as Stripe.Event;
    const result = mapEvent(event);
    const qboEntries = toQboSchedule(result.schedule!, TEST_QBO_ACCOUNT_MAP);
    expect(qboEntries).toHaveLength(12);
    const debitTotal = qboEntries.reduce((acc, qbo) => {
      const debit = qbo.Line.find((l) => l.JournalEntryLineDetail.PostingType === 'Debit');
      return acc + (debit?.Amount ?? 0);
    }, 0);
    // Round through integer cents to avoid IEEE-754 sum drift.
    expect(Math.round(debitTotal * 100)).toBe(100000);
  });
});
