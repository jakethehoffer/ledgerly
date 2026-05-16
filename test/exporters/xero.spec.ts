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
  'charge_succeeded_trial_conversion',
  'charge_succeeded_with_app_fee',
  'charge_refunded_full',
  'charge_refunded_multi_first',
  'charge_refunded_multi_second',
  'charge_refunded_partial',
  'dispute_closed_lost',
  'dispute_funds_reinstated_won',
  'dispute_funds_withdrawn_standard',
  'invoice_payment_succeeded_monthly',
  'invoice_payment_succeeded_monthly_with_tax',
  'invoice_payment_succeeded_annual',
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
  it('invoice_payment_succeeded_annual: produces 12 future-dated Xero entries', () => {
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as Stripe.Event;
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const xeroEntries = toXeroSchedule(result.schedule!, TEST_XERO_ACCOUNT_MAP);
    expect(xeroEntries).toHaveLength(12);
    const first = xeroEntries[0];
    const last = xeroEntries[11];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(first!.Date).toBe('2025-02-15');
    expect(last!.Date).toBe('2026-01-15');
    for (const xero of xeroEntries) {
      expect(xero.JournalLines).toHaveLength(2);
      const sum = xero.JournalLines.reduce((acc, l) => acc + l.LineAmount, 0);
      expect(Math.round(sum * 100)).toBe(0);
    }
  });
});
