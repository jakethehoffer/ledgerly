import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import Stripe from 'stripe';
import request, { type Response } from 'supertest';
import { createServer } from '../../src/server/index.js';
import { silentLogger } from '../../src/server/logger.js';
import { inMemoryDeduplicator, inMemoryStorage } from '../../src/server/storage/inMemory.js';
import { openSqliteDatabase, sqliteStorage } from '../../src/server/storage/sqlite.js';
import { computeBalances } from '../helpers/balances.js';

const secret = 'whsec_refund_ordering_local_test';
const adminToken = 'refund-ordering-local-admin-token-32-characters';
const databases: Database.Database[] = [];

function fixture(name: string): Stripe.Event {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.event.json`, import.meta.url), 'utf8'),
  ) as Stripe.Event;
}

function setup(
  kind: 'memory' | 'sqlite' | 'legacy',
  amount: number,
): ReturnType<typeof createServer> & {
  paid: Stripe.Event;
  refundEvent: Stripe.Event;
  deliver: (event: Stripe.Event) => Promise<Response>;
} {
  const paid = fixture('invoice_payment_succeeded_annual');
  const invoice = paid.data.object as Stripe.Invoice;
  const refundEvent = fixture('charge_refunded_full');
  const charge = refundEvent.data.object as Stripe.Charge;
  const paidCharge = invoice.charge as Stripe.Charge;
  charge.id = paidCharge.id;
  charge.invoice = invoice;
  charge.amount = paidCharge.amount;
  charge.amount_refunded = amount;
  charge.balance_transaction = paidCharge.balance_transaction;
  const refund = charge.refunds!.data[0]!;
  refund.charge = charge.id;
  refund.amount = amount;
  const transaction = refund.balance_transaction as Stripe.BalanceTransaction;
  transaction.amount = transaction.net = -amount;

  const stripe = new Stripe('sk_test_refund_ordering_local');
  vi.spyOn(stripe.invoices, 'retrieve').mockResolvedValue(
    invoice as Stripe.Response<Stripe.Invoice>,
  );
  vi.spyOn(stripe.charges, 'retrieve').mockResolvedValue(charge as Stripe.Response<Stripe.Charge>);
  const db = kind === 'sqlite' ? openSqliteDatabase(':memory:') : undefined;
  if (db) databases.push(db);
  const server = createServer({
    stripe,
    webhookSecret: secret,
    adminToken,
    log: silentLogger(),
    ...(kind === 'legacy'
      ? { dedup: inMemoryDeduplicator() }
      : { storage: db ? sqliteStorage(db) : inMemoryStorage() }),
  });
  async function deliver(event: Stripe.Event): Promise<Response> {
    const payload = JSON.stringify(event);
    return request(server.app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', stripe.webhooks.generateTestHeaderString({ payload, secret }))
      .send(payload);
  }
  return { ...server, paid, refundEvent, deliver };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

describe.each(['memory', 'sqlite', 'legacy'] as const)(
  'refund ordering with %s storage',
  (kind) => {
    it.each([90000, 120000])(
      'retains an early %i-cent refund, then reduces deferred revenue exactly once',
      async (amount) => {
        const { app, storage, paid, refundEvent, deliver } = setup(kind, amount);

        // A valid signed refund can reach the receiver before the paid invoice.
        expect((await deliver(refundEvent)).status).toBe(500);
        expect(storage.entries.countImmediate()).toBe(0);
        expect(storage.entries.countPendingScheduled()).toBe(0);
        expect(storage.dedup.has(refundEvent.id)).toBe(false);
        expect(storage.inbox.get(refundEvent.id)?.status).toBe('failed');
        expect((await deliver(refundEvent)).status).toBe(500);
        expect(storage.inbox.count()).toBe(1);

        expect((await deliver(paid)).status).toBe(200);
        expect((await request(app).post(`/admin/webhooks/${refundEvent.id}/retry`)).status).toBe(
          401,
        );
        const retry = await request(app)
          .post(`/admin/webhooks/${refundEvent.id}/retry`)
          .set('Authorization', `Bearer ${adminToken}`);
        expect(retry.status).toBe(200);
        expect(storage.inbox.count()).toBe(0);
        expect(storage.dedup.has(refundEvent.id)).toBe(true);

        const entries = [paid, refundEvent].flatMap((event) =>
          storage.entries.findByEventId(event.id).map((row) => row.entry),
        );
        const balances = computeBalances(entries);
        expect(balances['2100'] ?? 0).toBe(amount - 120000);
        expect(balances['4900'] ?? 0).toBe(0);
        expect(balances['4000'] ?? 0).toBe(0);
        const remaining = storage.entries
          .findScheduledBySubscription('sub_test_annual_001')
          .filter((row) => row.status === 'pending');
        expect(computeBalances(remaining.map((row) => row.entry))['2100'] ?? 0).toBe(
          120000 - amount,
        );

        const beforeReplay = storage.entries.countPendingScheduled();
        expect((await deliver(refundEvent)).body).toEqual({ duplicate: true });
        expect((await deliver({ ...refundEvent, id: 'evt_refund_second_notice' })).status).toBe(
          200,
        );
        expect(storage.entries.countImmediate()).toBe(2);
        expect(storage.entries.countPendingScheduled()).toBe(beforeReplay);
      },
    );

    it('still refunds an invoice whose revenue has all been recognized', async () => {
      const { storage, paid, refundEvent, deliver } = setup(kind, 90000);
      expect((await deliver(paid)).status).toBe(200);
      for (const row of storage.entries.findScheduledBySubscription('sub_test_annual_001')) {
        storage.entries.markScheduledPosted(row.id);
      }
      expect((await deliver(refundEvent)).status).toBe(200);
      const balances = computeBalances(
        storage.entries.findByEventId(refundEvent.id).map((row) => row.entry),
      );
      expect(balances['4900']).toBe(90000);
      expect(balances['2100'] ?? 0).toBe(0);
    });
  },
);
