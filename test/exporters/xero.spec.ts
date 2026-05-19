import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from '../../src/engine.js';
import { toXero, toXeroSchedule } from '../../src/exporters/xero.js';
import { TEST_XERO_ACCOUNT_MAP } from '../fixtures/test-account-maps.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

const FIXTURES = [
  'charge_succeeded_standard',
  'charge_succeeded_eur',
  'charge_succeeded_jpy',
  'charge_succeeded_fx',
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

describe('toXero (cash entry)', () => {
  for (const name of FIXTURES) {
    it(`${name}: matches golden Xero output`, () => {
      const event = loadJson(`${name}.event.json`) as Stripe.Event;
      const expectedXero = loadJson(`${name}.xero.json`);
      const result = mapEvent(event);
      expect(result.entries.length).toBeGreaterThan(0);
      const firstEntry = result.entries[0];
      expect(firstEntry).toBeDefined();
      const xero = toXero(firstEntry!, TEST_XERO_ACCOUNT_MAP);
      expect(xero).toEqual(expectedXero);
    });

    it(`${name}: Xero line amounts sum to zero`, () => {
      const event = loadJson(`${name}.event.json`) as Stripe.Event;
      const result = mapEvent(event);
      if (result.entries.length === 0) return;
      const firstEntry = result.entries[0];
      expect(firstEntry).toBeDefined();
      const xero = toXero(firstEntry!, TEST_XERO_ACCOUNT_MAP);
      const sum = xero.JournalLines.reduce((acc, l) => acc + l.LineAmount, 0);
      expect(Math.round(sum * 100)).toBe(0);
    });
  }
});

describe('toXeroSchedule', () => {
  it('invoice_payment_succeeded_annual: matches the golden schedule output', () => {
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as Stripe.Event;
    const expected = loadJson('invoice_payment_succeeded_annual.schedule.xero.json');
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const xeroEntries = toXeroSchedule(result.schedule!, TEST_XERO_ACCOUNT_MAP);
    expect(xeroEntries).toEqual(expected);
  });

  it('invoice_payment_succeeded_annual: 12 entries each sum to zero', () => {
    // Cheap per-entry invariant in addition to the golden diff above: catches
    // a future change that produces a structurally valid but unbalanced entry
    // that the golden also reflects.
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as Stripe.Event;
    const result = mapEvent(event);
    const xeroEntries = toXeroSchedule(result.schedule!, TEST_XERO_ACCOUNT_MAP);
    expect(xeroEntries).toHaveLength(12);
    for (const xero of xeroEntries) {
      const sum = xero.JournalLines.reduce((acc, l) => acc + l.LineAmount, 0);
      expect(Math.round(sum * 100)).toBe(0);
    }
  });

  it('invoice_payment_succeeded_annual_with_tax: matches the golden schedule output', () => {
    // Tax-aware annual: the schedule recognizes the preTax portion ($1000)
    // across 12 months. Months 1-11 get 83.33; month 12 absorbs the 4-cent
    // rounding remainder (83.37) so the schedule sums to preTax exactly.
    const event = loadJson(
      'invoice_payment_succeeded_annual_with_tax.event.json',
    ) as Stripe.Event;
    const expected = loadJson(
      'invoice_payment_succeeded_annual_with_tax.schedule.xero.json',
    );
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const xeroEntries = toXeroSchedule(result.schedule!, TEST_XERO_ACCOUNT_MAP);
    expect(xeroEntries).toEqual(expected);
  });

  it('invoice_payment_succeeded_annual_with_tax: 12 entries each sum to zero', () => {
    const event = loadJson(
      'invoice_payment_succeeded_annual_with_tax.event.json',
    ) as Stripe.Event;
    const result = mapEvent(event);
    const xeroEntries = toXeroSchedule(result.schedule!, TEST_XERO_ACCOUNT_MAP);
    expect(xeroEntries).toHaveLength(12);
    for (const xero of xeroEntries) {
      const sum = xero.JournalLines.reduce((acc, l) => acc + l.LineAmount, 0);
      expect(Math.round(sum * 100)).toBe(0);
    }
  });

  it('invoice_payment_succeeded_annual_fx: matches the golden schedule output', () => {
    // FX annual: USD-1200 invoice settled in CAD at rate 1.30. Engine output
    // schedule entries are exercised by the engine spec via the new
    // expected.json; here we additionally confirm the Xero exporter passes
    // the per-month CAD amounts through without dropping the fxContext or
    // mis-converting amounts.
    const event = loadJson(
      'invoice_payment_succeeded_annual_fx.event.json',
    ) as Stripe.Event;
    const expected = loadJson(
      'invoice_payment_succeeded_annual_fx.schedule.xero.json',
    );
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const xeroEntries = toXeroSchedule(result.schedule!, TEST_XERO_ACCOUNT_MAP);
    expect(xeroEntries).toEqual(expected);
  });
});
