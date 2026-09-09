import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import request, { type Response } from 'supertest';
import type { JournalEntry } from '../../src/journal.js';
import { mapEvent } from '../../src/engine.js';
import { createServer } from '../../src/server/index.js';
import { silentLogger } from '../../src/server/logger.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';
import {
  buildRefundReconcileInput,
  refundNeedsReconcile,
} from '../../src/server/refundReconciler.js';
import { buildSubscriptionCancellationInput } from '../../src/server/subscriptionCancellationReconciler.js';
import type { SavedScheduledEntry } from '../../src/server/storage/types.js';
import { computeBalances } from '../helpers/balances.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadEvent(name: string): Stripe.Event {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${name}.event.json`), 'utf8'),
  ) as Stripe.Event;
}

const SUB_ID = 'sub_test_annual_001';
const INVOICE_ID = 'in_test_annual_001';
const CHARGE_ID = 'ch_test_annual_001';
const WEBHOOK_SECRET = 'whsec_deferred_refund_test';

/**
 * Build a `charge.refunded` event for the charge that paid the annual invoice
 * (`invoice_payment_succeeded_annual`), with that invoice expanded on the charge
 * exactly as the receiver's `expandEvent` delivers it. The refund is
 * same-currency and fee-free, so the engine's FX and tax arithmetic reduces to
 * the simple case and the test is about the deferred draw-down alone.
 */
function refundAgainstAnnual(opts: {
  eventId: string;
  amount: number;
  created?: number;
  invoiceTax?: number;
  priorRefunds?: ReadonlyArray<{ id: string; amount: number; created: number }>;
}): Stripe.Event {
  const paid = loadEvent('invoice_payment_succeeded_annual');
  const invoice = JSON.parse(JSON.stringify(paid.data.object)) as Stripe.Invoice;
  if (opts.invoiceTax !== undefined) {
    (invoice as { tax: number }).tax = opts.invoiceTax;
  }
  const created = opts.created ?? 1744000000;

  const refundOf = (id: string, amount: number, at: number): unknown => ({
    id,
    object: 'refund',
    amount,
    charge: CHARGE_ID,
    created: at,
    currency: 'usd',
    reason: 'requested_by_customer',
    status: 'succeeded',
    balance_transaction: {
      id: `txn_${id}`,
      object: 'balance_transaction',
      amount: -amount,
      available_on: at,
      created: at,
      currency: 'usd',
      exchange_rate: null,
      fee: 0,
      fee_details: [],
      net: -amount,
      reporting_category: 'refund',
      status: 'available',
      type: 'refund',
    },
  });

  const priors = (opts.priorRefunds ?? []).map((r) => refundOf(r.id, r.amount, r.created));
  const data = [...priors, refundOf(`re_${opts.eventId}`, opts.amount, created)];

  return {
    id: opts.eventId,
    object: 'event',
    type: 'charge.refunded',
    created,
    data: {
      object: {
        id: CHARGE_ID,
        object: 'charge',
        amount: 120000,
        currency: 'usd',
        paid: true,
        status: 'succeeded',
        invoice,
        balance_transaction: {
          id: 'txn_test_annual_001',
          object: 'balance_transaction',
          amount: 120000,
          currency: 'usd',
          exchange_rate: null,
          fee: 3600,
          fee_details: [],
          net: 116400,
          reporting_category: 'charge',
          status: 'available',
          type: 'charge',
          created: 1736942400,
          available_on: 1737158400,
        },
        refunds: {
          object: 'list',
          data,
          has_more: false,
          total_count: data.length,
          url: `/v1/charges/${CHARGE_ID}/refunds`,
        },
      },
    },
  } as unknown as Stripe.Event;
}

function scheduleRows(storage: ReturnType<typeof inMemoryStorage>): SavedScheduledEntry[] {
  return storage.entries
    .findScheduledBySubscription(SUB_ID)
    .filter((row) => row.entry.sourceObjectId === INVOICE_ID);
}

function recognitionTotal(rows: ReadonlyArray<SavedScheduledEntry>): number {
  return rows.reduce(
    (sum, row) =>
      sum +
      row.entry.lines
        .filter((l) => l.accountCode === '4000' && l.side === 'credit')
        .reduce((a, l) => a + l.amount, 0),
    0,
  );
}

/**
 * A cash refund against an invoice that deferred revenue. The stateless engine
 * books every refund as contra-revenue (4900), which is right only for revenue
 * that was actually recognized. Money returned for service not yet delivered is
 * repayment of the 2100 liability, so the bundled receiver reconciles it against
 * the ledger — deferred first, clawback only for the recognized excess.
 */
describe('integration: deferred-schedule refund reconciliation', () => {
  it('refunding the unrecognized remainder drains deferred revenue and leaves recognized revenue alone', () => {
    const storage = inMemoryStorage();

    // 1. Pay the annual invoice: Cr 2100 $1,200 + a 12-month $100/mo schedule.
    const paid = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(paid.id, mapEvent(paid));
    const rows = scheduleRows(storage);
    expect(rows).toHaveLength(12);

    // 2. Three months recognize: $300 → 4000, $900 still deferred across 9 rows.
    for (const row of rows.slice(0, 3)) storage.entries.markScheduledPosted(row.id);

    // 3. The customer is refunded the undelivered $900.
    const refund = refundAgainstAnnual({ eventId: 'evt_refund_annual_remainder', amount: 90000 });
    expect(refundNeedsReconcile(refund)).toBe(true);
    expect(storage.persistRefundReversal(refund.id, buildRefundReconcileInput(refund))).toEqual({
      duplicate: false,
    });

    // 4. The refund repays the liability. Nothing was recognized for that
    //    service, so there is no revenue to reverse and 4900 stays untouched.
    const rev = computeBalances(storage.entries.findByEventId(refund.id).map((r) => r.entry));
    expect(rev['2100']).toBe(90000); // Dr 2100 — deferred revenue repaid
    expect(rev['1010']).toBe(-90000); // Cr 1010 — cash left the Stripe balance
    expect(rev['4900']).toBeUndefined();

    // 5. Nothing remains deferred, so the 9 unposted months are cancelled and
    //    no reduced schedule is reissued.
    const after = scheduleRows(storage);
    expect(after.filter((r) => r.status === 'cancelled')).toHaveLength(9);
    expect(after.filter((r) => r.status === 'pending')).toHaveLength(0);

    // 6. Lifetime: 2100 fully drained and revenue is the $300 actually delivered
    //    — not the −$600 the unreconciled refund produced.
    const ledger: JournalEntry[] = [
      ...storage.entries.findByEventId(paid.id).map((r) => r.entry),
      ...storage.entries.findByEventId(refund.id).map((r) => r.entry),
      ...storage.entries.listScheduledByStatus('posted').map((r) => r.entry),
    ];
    const balances = computeBalances(ledger);
    expect(balances['2100']).toBeUndefined();
    expect(balances['4000']).toBe(-30000);
    expect(balances['4900']).toBeUndefined();
  });

  it('a partial refund re-spreads the still-deferred remainder over the unposted months', () => {
    const storage = inMemoryStorage();
    const paid = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(paid.id, mapEvent(paid));
    for (const row of scheduleRows(storage).slice(0, 3)) {
      storage.entries.markScheduledPosted(row.id);
    }

    // $450 of the $900 still deferred comes back.
    const refund = refundAgainstAnnual({ eventId: 'evt_refund_annual_partial', amount: 45000 });
    storage.persistRefundReversal(refund.id, buildRefundReconcileInput(refund));

    const rev = computeBalances(storage.entries.findByEventId(refund.id).map((r) => r.entry));
    expect(rev['2100']).toBe(45000);
    expect(rev['1010']).toBe(-45000);
    expect(rev['4900']).toBeUndefined();

    // The 9 old rows are replaced by 9 rows carrying the reduced $450.
    const after = scheduleRows(storage);
    expect(after.filter((r) => r.status === 'cancelled')).toHaveLength(9);
    const reissued = after.filter((r) => r.status === 'pending');
    expect(reissued).toHaveLength(9);
    expect(recognitionTotal(reissued)).toBe(45000);

    // Once they post, the invoice recognizes exactly what was kept: $300 + $450.
    for (const row of reissued) storage.entries.markScheduledPosted(row.id);
    const balances = computeBalances([
      ...storage.entries.findByEventId(paid.id).map((r) => r.entry),
      ...storage.entries.findByEventId(refund.id).map((r) => r.entry),
      ...storage.entries.listScheduledByStatus('posted').map((r) => r.entry),
    ]);
    expect(balances['2100']).toBeUndefined();
    expect(balances['4000']).toBe(-75000);
  });

  it('a refund larger than the remaining deferred claws the excess back through 4900', () => {
    const storage = inMemoryStorage();
    const paid = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(paid.id, mapEvent(paid));
    // Ten months recognize: $1,000 → 4000, $200 still deferred.
    for (const row of scheduleRows(storage).slice(0, 10)) {
      storage.entries.markScheduledPosted(row.id);
    }

    const refund = refundAgainstAnnual({ eventId: 'evt_refund_annual_clawback', amount: 30000 });
    storage.persistRefundReversal(refund.id, buildRefundReconcileInput(refund));

    const rev = computeBalances(storage.entries.findByEventId(refund.id).map((r) => r.entry));
    expect(rev['2100']).toBe(20000); // all remaining deferred repaid
    expect(rev['4900']).toBe(10000); // the $100 excess reverses recognized revenue
    expect(rev['1010']).toBe(-30000);
  });

  it('a refund against a fully recognized invoice books exactly what the engine books today', () => {
    const storage = inMemoryStorage();
    const paid = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(paid.id, mapEvent(paid));
    for (const row of scheduleRows(storage)) storage.entries.markScheduledPosted(row.id);

    const refund = refundAgainstAnnual({ eventId: 'evt_refund_annual_recognized', amount: 30000 });
    storage.persistRefundReversal(refund.id, buildRefundReconcileInput(refund));

    const rev = computeBalances(storage.entries.findByEventId(refund.id).map((r) => r.entry));
    expect(rev['2100']).toBeUndefined();
    expect(rev['4900']).toBe(30000);
    expect(rev['1010']).toBe(-30000);
  });

  it('reconciles a refund that follows a cancellation, clearing the held schedule and the phantom liability', () => {
    const storage = inMemoryStorage();
    const paid = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(paid.id, mapEvent(paid));
    // Months 1-3 (Feb/Mar/Apr) recognize, then the subscription ends 2025-04-15
    // and the remaining nine months are held pending a money event.
    for (const row of scheduleRows(storage).slice(0, 3)) {
      storage.entries.markScheduledPosted(row.id);
    }
    storage.persistSubscriptionCancellation('evt_cancel_annual', {
      ...buildSubscriptionCancellationInput({
        id: 'evt_cancel_annual',
        type: 'customer.subscription.deleted',
        created: Math.floor(Date.parse('2025-04-15T12:00:00Z') / 1000),
        data: {
          object: {
            id: SUB_ID,
            object: 'subscription',
            status: 'canceled',
            cancel_at_period_end: false,
            canceled_at: Math.floor(Date.parse('2025-04-15T12:00:00Z') / 1000),
            ended_at: Math.floor(Date.parse('2025-04-15T12:00:00Z') / 1000),
            current_period_end: Math.floor(Date.parse('2025-04-15T12:00:00Z') / 1000),
          },
        },
      } as unknown as Stripe.Event),
    });
    expect(scheduleRows(storage).filter((r) => r.status === 'held')).toHaveLength(9);

    // The money event finally arrives: the customer is refunded the $900.
    const refund = refundAgainstAnnual({ eventId: 'evt_refund_after_cancel', amount: 90000 });
    storage.persistRefundReversal(refund.id, buildRefundReconcileInput(refund));

    const rev = computeBalances(storage.entries.findByEventId(refund.id).map((r) => r.entry));
    expect(rev['2100']).toBe(90000);
    expect(rev['4900']).toBeUndefined();

    // The held rows are closed out and the phantom deferred balance is gone.
    expect(scheduleRows(storage).filter((r) => r.status === 'held')).toHaveLength(0);
    const balances = computeBalances([
      ...storage.entries.findByEventId(paid.id).map((r) => r.entry),
      ...storage.entries.findByEventId(refund.id).map((r) => r.entry),
      ...storage.entries.listScheduledByStatus('posted').map((r) => r.entry),
    ]);
    expect(balances['2100']).toBeUndefined();
    expect(balances['4000']).toBe(-30000);
  });

  it('re-holds the reissued months when a partial refund follows a cancellation', () => {
    const storage = inMemoryStorage();
    const paid = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(paid.id, mapEvent(paid));
    for (const row of scheduleRows(storage).slice(0, 3)) {
      storage.entries.markScheduledPosted(row.id);
    }
    storage.persistSubscriptionCancellation('evt_cancel_partial', {
      subscriptionId: SUB_ID,
      effectiveEndDate: '2025-04-15',
    });

    // Only half the undelivered $900 comes back, so $450 stays deferred. Those
    // months are still after the service end, so they must stay held rather than
    // becoming pending rows the scheduler would post.
    const refund = refundAgainstAnnual({ eventId: 'evt_refund_partial_cancel', amount: 45000 });
    storage.persistRefundReversal(refund.id, buildRefundReconcileInput(refund));

    const after = scheduleRows(storage);
    const held = after.filter((r) => r.status === 'held');
    expect(held).toHaveLength(9);
    expect(recognitionTotal(held)).toBe(45000);
    expect(after.filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  it('leaves a paginated invoice to the engine, which fails closed on it', () => {
    const refund = refundAgainstAnnual({ eventId: 'evt_refund_paginated', amount: 5000 });
    const charge = refund.data.object as Stripe.Charge;
    (charge.invoice as Stripe.Invoice).lines.has_more = true;
    expect(refundNeedsReconcile(refund)).toBe(false);
  });

  it('splits the deferred draw-down after the tax share, leaving the tax drain untouched', () => {
    const storage = inMemoryStorage();
    const paid = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(paid.id, mapEvent(paid));
    for (const row of scheduleRows(storage).slice(0, 3)) {
      storage.entries.markScheduledPosted(row.id);
    }

    // A 10% tax invoice: a $120 refund is $12 tax and $108 pre-tax revenue.
    const refund = refundAgainstAnnual({
      eventId: 'evt_refund_annual_tax',
      amount: 12000,
      invoiceTax: 12000,
    });
    storage.persistRefundReversal(refund.id, buildRefundReconcileInput(refund));

    const rev = computeBalances(storage.entries.findByEventId(refund.id).map((r) => r.entry));
    expect(rev['2000']).toBe(1200); // tax drain is the engine's, unchanged
    expect(rev['2100']).toBe(10800); // only the pre-tax slice draws down deferred
    expect(rev['4900']).toBeUndefined();
    expect(rev['1010']).toBe(-12000);
  });

  it('draws down an FX schedule in its own settlement currency, leaving the FX delta to 7000', () => {
    const storage = inMemoryStorage();
    const paid = loadEvent('invoice_payment_succeeded_annual_fx');
    storage.persistMapResult(paid.id, mapEvent(paid));
    const fxRows = (): SavedScheduledEntry[] =>
      storage.entries
        .findScheduledBySubscription('sub_test_annual_fx_001')
        .filter((row) => row.entry.sourceObjectId === 'in_test_annual_fx_001');
    // Three of twelve CAD 130.00 months recognize; CAD 1,170.00 stays deferred.
    for (const row of fxRows().slice(0, 3)) storage.entries.markScheduledPosted(row.id);

    // Refund USD 900 when the rate has moved from 1.30 to 1.34: Stripe claws back
    // CAD 1,206.00 for a booking made at CAD 1,170.00.
    const created = 1744000000;
    const invoice = JSON.parse(JSON.stringify(paid.data.object)) as Stripe.Invoice;
    const refund = {
      id: 'evt_refund_annual_fx',
      object: 'event',
      type: 'charge.refunded',
      created,
      data: {
        object: {
          id: 'ch_test_annual_fx_001',
          object: 'charge',
          amount: 120000,
          currency: 'usd',
          paid: true,
          status: 'succeeded',
          invoice,
          balance_transaction: (invoice as unknown as { charge: { balance_transaction: unknown } })
            .charge.balance_transaction,
          refunds: {
            object: 'list',
            has_more: false,
            total_count: 1,
            data: [
              {
                id: 're_test_annual_fx',
                object: 'refund',
                amount: 90000,
                charge: 'ch_test_annual_fx_001',
                created,
                currency: 'usd',
                reason: 'requested_by_customer',
                status: 'succeeded',
                balance_transaction: {
                  id: 'txn_re_test_annual_fx',
                  object: 'balance_transaction',
                  amount: -120600,
                  net: -120600,
                  currency: 'cad',
                  exchange_rate: 1.34,
                  fee: 0,
                  fee_details: [],
                  created,
                  available_on: created,
                  reporting_category: 'refund',
                  status: 'available',
                  type: 'refund',
                },
              },
            ],
          },
        },
      },
    } as unknown as Stripe.Event;

    expect(refundNeedsReconcile(refund)).toBe(true);
    storage.persistRefundReversal(refund.id, buildRefundReconcileInput(refund));

    const rev = computeBalances(storage.entries.findByEventId(refund.id).map((r) => r.entry));
    expect(rev['2100']).toBe(117000); // the whole CAD remainder, at the original rate
    expect(rev['4900']).toBeUndefined(); // nothing recognized was refunded
    expect(rev['7000']).toBe(3600); // the rate move stays realized FX loss
    expect(rev['1010']).toBe(-120600); // cash left at the refund-day rate

    // Deferred revenue lands exactly on zero across the whole invoice.
    const balances = computeBalances([
      ...storage.entries.findByEventId(paid.id).map((r) => r.entry),
      ...storage.entries.findByEventId(refund.id).map((r) => r.entry),
      ...storage.entries.listScheduledByStatus('posted').map((r) => r.entry),
    ]);
    expect(balances['2100']).toBeUndefined();
    expect(balances['4000']).toBe(-39000);
  });

  it('leaves refunds on invoices that never deferred revenue to the stateless engine', () => {
    const plain = loadEvent('charge_refunded_full');
    expect(refundNeedsReconcile(plain)).toBe(false);

    const monthly = loadEvent('charge_refunded_with_tax');
    expect(refundNeedsReconcile(monthly)).toBe(false);
  });

  it('routes a signed charge.refunded webhook through the reconciler end to end', async () => {
    const paid = loadEvent('invoice_payment_succeeded_annual');
    const refund = refundAgainstAnnual({ eventId: 'evt_refund_webhook', amount: 90000 });

    const stripe = new Stripe('sk_test_deferred_refund');
    type InvoiceRetrieve = typeof stripe.invoices.retrieve;
    (stripe.invoices as unknown as { retrieve: InvoiceRetrieve }).retrieve = ((
      id: string,
    ): Promise<Stripe.Invoice> => {
      if (id !== INVOICE_ID) throw new Error(`Missing test invoice ${id}`);
      return Promise.resolve(paid.data.object as Stripe.Invoice);
    }) as InvoiceRetrieve;
    type ChargeRetrieve = typeof stripe.charges.retrieve;
    (stripe.charges as unknown as { retrieve: ChargeRetrieve }).retrieve = ((
      id: string,
    ): Promise<Stripe.Charge> => {
      if (id !== CHARGE_ID) throw new Error(`Missing test charge ${id}`);
      return Promise.resolve(refund.data.object as Stripe.Charge);
    }) as ChargeRetrieve;

    const storage = inMemoryStorage();
    const { app } = createServer({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      storage,
      log: silentLogger(),
    });
    async function send(event: Stripe.Event): Promise<Response> {
      const raw = JSON.stringify(event);
      return request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set(
          'Stripe-Signature',
          stripe.webhooks.generateTestHeaderString({ payload: raw, secret: WEBHOOK_SECRET }),
        )
        .send(raw);
    }

    expect((await send(paid)).status).toBe(200);
    for (const row of scheduleRows(storage).slice(0, 3)) {
      storage.entries.markScheduledPosted(row.id);
    }

    const response = await send(refund);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, entries: 1, schedule: false });

    const rev = computeBalances(storage.entries.findByEventId(refund.id).map((r) => r.entry));
    expect(rev['2100']).toBe(90000);
    expect(rev['4900']).toBeUndefined();
    expect(scheduleRows(storage).filter((r) => r.status === 'pending')).toHaveLength(0);

    // A Stripe redelivery must not draw the schedule down twice.
    expect((await send(refund)).body).toEqual({ duplicate: true });
    expect(storage.entries.findByEventId(refund.id)).toHaveLength(1);
  });
});
