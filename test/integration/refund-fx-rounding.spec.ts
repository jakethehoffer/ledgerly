import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from '../../src/engine.js';
import type { JournalEntry } from '../../src/journal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadBaseEvent(): Stripe.Event {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, 'charge_refunded_fx.event.json'), 'utf8'),
  ) as Stripe.Event;
}

function buildSplitRefundEvents(): Stripe.Event[] {
  const base = loadBaseEvent();
  const baseCharge = base.data.object as Stripe.Charge;
  const refundsList = baseCharge.refunds;
  const template = refundsList?.data[0];
  const originalBt = baseCharge.balance_transaction;

  if (!refundsList || !template || typeof originalBt !== 'object' || originalBt === null) {
    throw new Error('FX refund fixture is missing expanded Stripe objects');
  }

  const templateBt = template.balance_transaction;
  if (typeof templateBt !== 'object' || templateBt === null) {
    throw new Error('FX refund fixture is missing the expanded refund balance transaction');
  }

  // Three equal customer-currency refunds divide a 4-cent settlement basis.
  // Stripe's actual settlement pieces still total the original 4 cents, with
  // the middle refund carrying the rounding remainder.
  const actualSettlementParts = [133, 134, 133];
  const refunds: Stripe.Refund[] = actualSettlementParts.map((amount, index) => {
    const created = 1_737_104_400 + index;
    return {
      ...template,
      id: `re_fx_round_${String(index + 1)}`,
      amount: 100,
      created,
      balance_transaction: {
        ...templateBt,
        id: `txn_fx_round_${String(index + 1)}`,
        amount: -amount,
        fee: 0,
        net: -amount,
        exchange_rate: amount / 100,
      },
    };
  });

  return refunds.map((refund, index) => {
    const charge: Stripe.Charge = {
      ...baseCharge,
      id: 'ch_fx_round',
      amount: 300,
      amount_refunded: (index + 1) * 100,
      balance_transaction: {
        ...originalBt,
        amount: 400,
        fee: 0,
        net: 400,
        exchange_rate: 4 / 3,
      },
      refunds: {
        ...refundsList,
        data: refunds.slice(0, index + 1),
      },
    };

    return {
      ...base,
      id: `evt_fx_round_${String(index + 1)}`,
      created: refund.created,
      data: { ...base.data, object: charge },
    } as Stripe.Event;
  });
}

function sumAccount(entries: ReadonlyArray<JournalEntry>, accountCode: string): number {
  return entries
    .flatMap((entry) => entry.lines)
    .filter((line) => line.accountCode === accountCode)
    .reduce((sum, line) => sum + line.amount, 0);
}

describe('FX refund rounding across split refunds', () => {
  it('returns the full original settlement basis without inventing an FX loss', () => {
    const entries = buildSplitRefundEvents().flatMap((event) => mapEvent(event).entries);

    expect(sumAccount(entries, '4900')).toBe(400);
    expect(sumAccount(entries, '1010')).toBe(400);
    expect(sumAccount(entries, '7000')).toBe(0);
  });

  it('stops when Stripe supplies an incomplete refund list', () => {
    const event = buildSplitRefundEvents().at(-1);
    if (!event) throw new Error('Split-refund test event is missing');

    const charge = event.data.object as Stripe.Charge;
    if (!charge.refunds) throw new Error('Split-refund test charge is missing refunds');

    charge.refunds = { ...charge.refunds, has_more: true };

    expect(() => mapEvent(event)).toThrow(/complete refund list/i);
  });

  it('does not let a failed refund shift the next successful refund by a cent', () => {
    const event = buildSplitRefundEvents()[1];
    if (!event) throw new Error('Second split-refund test event is missing');

    const charge = event.data.object as Stripe.Charge;
    const refunds = charge.refunds?.data;
    const failedRefund = refunds?.[0];
    const successfulRefund = refunds?.[1];
    if (!failedRefund || !successfulRefund) {
      throw new Error('Failed-refund rounding test is missing refunds');
    }

    failedRefund.status = 'failed';
    successfulRefund.status = 'succeeded';
    const successfulBt = successfulRefund.balance_transaction;
    if (typeof successfulBt !== 'object' || successfulBt === null) {
      throw new Error('Failed-refund rounding test is missing a balance transaction');
    }
    successfulBt.amount = -133;
    successfulBt.net = -133;

    const entries = mapEvent(event).entries;

    expect(sumAccount(entries, '4900')).toBe(133);
    expect(sumAccount(entries, '1010')).toBe(133);
    expect(sumAccount(entries, '7000')).toBe(0);
  });
});
