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
  'charge_refunded_partial',
  'dispute_closed_lost',
  'dispute_funds_reinstated_won',
  'dispute_funds_withdrawn_standard',
  'invoice_payment_succeeded_monthly',
  'invoice_payment_succeeded_monthly_with_tax',
  'invoice_payment_succeeded_annual',
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
  it('invoice_payment_succeeded_annual: produces 12 future-dated QBO entries', () => {
    const event = loadJson('invoice_payment_succeeded_annual.event.json') as Stripe.Event;
    const result = mapEvent(event);
    expect(result.schedule).not.toBeNull();
    const qboEntries = toQboSchedule(result.schedule!, TEST_QBO_ACCOUNT_MAP);
    expect(qboEntries).toHaveLength(12);
    expect(qboEntries[0]!.TxnDate).toBe('2025-02-15');
    expect(qboEntries[11]!.TxnDate).toBe('2026-01-15');
    // Each entry must have one Debit + one Credit summing to zero net.
    for (const qbo of qboEntries) {
      expect(qbo.Line).toHaveLength(2);
      const debit = qbo.Line.find((l) => l.JournalEntryLineDetail.PostingType === 'Debit');
      const credit = qbo.Line.find((l) => l.JournalEntryLineDetail.PostingType === 'Credit');
      expect(debit).toBeDefined();
      expect(credit).toBeDefined();
      expect(debit!.Amount).toBe(100);
      expect(credit!.Amount).toBe(100);
    }
  });
});
