import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import Stripe from 'stripe';
import request, { type Response } from 'supertest';
import { mapEvent } from '../../src/engine.js';
import { createServer } from '../../src/server/index.js';
import { silentLogger } from '../../src/server/logger.js';
import { createScheduler } from '../../src/server/scheduler.js';
import { inMemoryDeduplicator, inMemoryStorage } from '../../src/server/storage/inMemory.js';
import { openSqliteDatabase, sqliteStorage } from '../../src/server/storage/sqlite.js';
import type { Storage } from '../../src/server/storage/types.js';
import { buildReducedSchedule } from '../../src/server/deferredSchedule.js';

const secret = 'whsec_review_local_only';
const adminToken = 'local-review-admin-token-32-characters';
const databases: Database.Database[] = [];

function fixture(name: string): Stripe.Event {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.event.json`, import.meta.url), 'utf8'),
  ) as Stripe.Event;
}

function database(): Database.Database {
  const db = openSqliteDatabase(':memory:');
  databases.push(db);
  return db;
}

function setup(kind: 'memory' | 'sqlite' | 'legacy'): ReturnType<typeof createServer> & {
  stripe: Stripe;
  db: Database.Database | undefined;
  deliver: (event: Stripe.Event) => Promise<Response>;
} {
  const stripe = new Stripe('sk_test_local_only');
  const db = kind === 'sqlite' ? database() : undefined;
  const backing = db ? sqliteStorage(db) : inMemoryStorage();
  const server = createServer({
    stripe,
    webhookSecret: secret,
    adminToken,
    log: silentLogger(),
    ...(kind === 'legacy' ? { dedup: inMemoryDeduplicator() } : { storage: backing }),
  });
  async function deliver(event: Stripe.Event): Promise<Response> {
    const payload = JSON.stringify(event);
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
    return request(server.app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('Stripe-Signature', signature)
      .send(payload);
  }
  return { ...server, stripe, deliver, db };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

describe.each(['memory', 'sqlite', 'legacy'] as const)('review fixes with %s storage', (kind) => {
  it.each([false, true])(
    'books one payment once in either notice order (charge first: %s)',
    async (chargeFirst) => {
      const server = setup(kind);
      const paid = fixture('invoice_payment_succeeded_monthly');
      const invoice = paid.data.object as Stripe.Invoice;
      const charge = { ...(invoice.charge as Stripe.Charge), invoice: invoice.id };
      const charged = {
        ...paid,
        id: 'evt_related_charge',
        type: 'charge.succeeded',
        data: { object: charge },
      } as Stripe.Event;
      vi.spyOn(server.stripe.invoices, 'retrieve').mockResolvedValue(
        invoice as Stripe.Response<Stripe.Invoice>,
      );
      vi.spyOn(server.stripe.charges, 'retrieve').mockResolvedValue(
        charge as Stripe.Response<Stripe.Charge>,
      );
      for (const event of chargeFirst ? [charged, paid] : [paid, charged]) {
        expect((await server.deliver(event)).status).toBe(200);
      }
      expect(server.storage.entries.countImmediate()).toBe(1);
      expect(server.storage.entries.countPendingScheduled()).toBe(1);
      const income = server.storage.entries
        .findByEventId(paid.id)[0]
        ?.entry.lines.find((line) => line.accountCode === '4000' && line.side === 'credit')?.amount;
      expect(income).toBe(5000);
    },
  );

  it.each([false, true])(
    'does not double-book same-second refunds (deferred: %s)',
    async (deferred) => {
      const server = setup(kind);
      const event = fixture('charge_refunded_multi_second');
      const charge = event.data.object as Stripe.Charge;
      for (const refund of charge.refunds?.data ?? []) refund.created = event.created;
      if (deferred) {
        const paid = fixture('invoice_payment_succeeded_annual');
        server.storage.persistMapResult(paid.id, mapEvent(paid));
        charge.invoice = paid.data.object as Stripe.Invoice;
      }
      vi.spyOn(server.stripe.charges, 'retrieve').mockResolvedValue(
        charge as Stripe.Response<Stripe.Charge>,
      );
      const results = await Promise.all([
        server.deliver(event),
        server.deliver({ ...event, id: 'evt_second_notice' }),
      ]);
      expect(results.map((result) => result.status)).toEqual([200, 200]);
      expect(server.storage.entries.countImmediate()).toBe(deferred ? 3 : 2);
      for (const refund of charge.refunds?.data ?? []) {
        expect(server.storage.entries.findImmediateBySourceObject(refund.id)).toHaveLength(1);
      }
      if (deferred) {
        const pending = server.storage.entries
          .findScheduledBySubscription('sub_test_annual_001')
          .filter((row) => row.status === 'pending');
        expect(pending).toHaveLength(12);
        expect(
          pending
            .flatMap((row) => row.entry.lines)
            .filter((line) => line.accountCode === '4000')
            .reduce((sum, line) => sum + line.amount, 0),
        ).toBe(115000);
      }
    },
  );

  it('retains a failed notice and retries it through the protected admin route', async () => {
    const server = setup(kind);
    const paid = fixture('invoice_payment_succeeded_monthly');
    const retrieve = vi
      .spyOn(server.stripe.invoices, 'retrieve')
      .mockRejectedValueOnce(new Error('network failure'));
    expect((await server.deliver(paid)).status).toBe(500);
    expect(server.storage.dedup.has(paid.id)).toBe(false);
    expect(server.storage.inbox.get(paid.id)?.status).toBe('failed');
    expect((await request(server.app).get('/admin/webhooks')).status).toBe(401);
    expect((await request(server.app).post(`/admin/webhooks/${paid.id}/retry`)).status).toBe(401);
    const list = await request(server.app)
      .get('/admin/webhooks')
      .auth(adminToken, { type: 'bearer' });
    expect(list.body.events).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('cus_test');
    retrieve.mockResolvedValue(paid.data.object as Stripe.Response<Stripe.Invoice>);
    const retry = await request(server.app)
      .post(`/admin/webhooks/${paid.id}/retry`)
      .auth(adminToken, { type: 'bearer' });
    expect(retry.status).toBe(200);
    expect(server.storage.inbox.count()).toBe(0);
    expect(server.storage.entries.countImmediate()).toBe(1);
    expect((await server.deliver(paid)).body).toEqual({ duplicate: true });
    expect(server.storage.entries.countImmediate()).toBe(1);
  });

  it.each([false, true])(
    'keeps cumulative cents when a later same-second refund sorts before the first (FX: %s)',
    async (fx) => {
      const server = setup(kind);
      const event = fixture('charge_refunded_full');
      const charge = event.data.object as Stripe.Charge;
      const template = charge.refunds!.data[0]!;
      charge.amount = 100;
      charge.currency = fx ? 'eur' : 'usd';
      const transaction = template.balance_transaction as Stripe.BalanceTransaction;
      charge.balance_transaction = { ...transaction, amount: fx ? 1 : 100, net: fx ? 1 : 100 };
      charge.invoice = {
        ...(fixture('invoice_payment_succeeded_monthly').data.object as Stripe.Invoice),
        tax: fx ? 0 : 1,
      };
      const first = {
        ...template,
        id: 're_z',
        amount: 50,
        currency: charge.currency,
        balance_transaction: { ...transaction, amount: fx ? -1 : -50, net: fx ? -1 : -50 },
      };
      const second = { ...first, id: 're_a' };
      charge.refunds!.data = [first];
      vi.spyOn(server.stripe.charges, 'retrieve').mockImplementation(() =>
        Promise.resolve(charge as Stripe.Response<Stripe.Charge>),
      );
      expect((await server.deliver(event)).status).toBe(200);
      charge.refunds!.data = [second, first];
      const later = { ...event, id: 'evt_later_same_second' };
      expect((await server.deliver(later)).status).toBe(200);
      const entries = [event.id, later.id].flatMap((id) =>
        server.storage.entries.findByEventId(id),
      );
      const total = (account: string): number =>
        entries
          .flatMap((row) => row.entry.lines)
          .filter((line) => line.accountCode === account && line.side === 'debit')
          .reduce((sum, line) => sum + line.amount, 0);
      expect(total('2000')).toBe(fx ? 0 : 1);
      expect(total('4900')).toBe(fx ? 1 : 99);
      expect(total('7000')).toBe(fx ? 1 : 0);
    },
  );

  it('books a complete invoice with eleven items', async () => {
    const server = setup(kind);
    const event = fixture('invoice_payment_succeeded_monthly');
    const invoice = event.data.object as Stripe.Invoice;
    const lines = Array.from({ length: 11 }, (_, index) => ({
      ...invoice.lines.data[0]!,
      id: `il_${String(index)}`,
      amount: 500,
    }));
    invoice.total = invoice.amount_due = invoice.amount_paid = 5500;
    invoice.lines = { ...invoice.lines, data: lines.slice(0, 10), has_more: true };
    const charge = invoice.charge as Stripe.Charge;
    const transaction = charge.balance_transaction as Stripe.BalanceTransaction;
    charge.amount = transaction.amount = 5500;
    transaction.net = 5500 - transaction.fee;
    vi.spyOn(server.stripe.invoices, 'retrieve').mockResolvedValue(
      invoice as Stripe.Response<Stripe.Invoice>,
    );
    vi.spyOn(server.stripe.invoices, 'listLineItems')
      .mockResolvedValueOnce({
        ...invoice.lines,
        data: lines.slice(0, 10),
        has_more: true,
      } as Stripe.Response<Stripe.ApiList<Stripe.InvoiceLineItem>>)
      .mockResolvedValueOnce({
        ...invoice.lines,
        data: lines.slice(10),
        has_more: false,
      } as Stripe.Response<Stripe.ApiList<Stripe.InvoiceLineItem>>);
    expect((await server.deliver(event)).status).toBe(200);
    const entry = server.storage.entries.findByEventId(event.id)[0]!.entry;
    expect(entry.lines.find((line) => line.accountCode === '4000')?.amount).toBe(5500);
    expect(server.storage.inbox.count()).toBe(0);
  });

  it('does not book pending or failed refunds and can retry after settlement', async () => {
    const server = setup(kind);
    const event = fixture('charge_refunded_full');
    const charge = event.data.object as Stripe.Charge;
    const refund = charge.refunds!.data[0]!;
    refund.status = 'pending';
    vi.spyOn(server.stripe.charges, 'retrieve').mockImplementation(() =>
      Promise.resolve(charge as Stripe.Response<Stripe.Charge>),
    );
    expect((await server.deliver(event)).status).toBe(500);
    expect(server.storage.entries.countImmediate()).toBe(0);
    expect(server.storage.inbox.count()).toBe(1);
    refund.status = 'succeeded';
    expect((await server.deliver(event)).status).toBe(200);
    expect(server.storage.entries.countImmediate()).toBe(1);
    expect(server.storage.inbox.count()).toBe(0);
    refund.id = 're_failed';
    refund.status = 'failed';
    expect((await server.deliver({ ...event, id: 'evt_failed_refund' })).status).toBe(200);
    expect(server.storage.entries.countImmediate()).toBe(1);
  });
});

describe('storage failure containment', () => {
  it('preserves currency-conversion history when a refund reduces a recognition schedule', () => {
    const event = fixture('invoice_payment_succeeded_annual_fx');
    const schedule = mapEvent(event).schedule!;
    const oldDeferred = schedule.entries
      .flatMap((entry) => entry.lines)
      .filter((line) => line.accountCode === '4000')
      .reduce((sum, line) => sum + line.amount, 0);
    const newDeferred = Math.floor(oldDeferred / 2);
    const reduced = buildReducedSchedule(schedule.entries, newDeferred, {
      subscriptionId: schedule.subscriptionId,
      sourceEventId: 'evt_reduce',
      sourceEventType: 'charge.refunded',
      invoiceId: (event.data.object as Stripe.Invoice).id,
      currency: schedule.entries[0]!.currency,
    })!;
    expect(reduced.entries).toHaveLength(schedule.entries.length);
    for (const entry of reduced.entries) {
      expect(entry.fxContext?.customerCurrency).toBe('USD');
      expect(entry.fxContext?.settlementCurrency).toBe('CAD');
      expect(entry.fxContext?.settlementAmount).toBe(
        entry.lines.find((line) => line.accountCode === '4000')?.amount,
      );
    }
    expect(reduced.entries.reduce((sum, entry) => sum + entry.fxContext!.customerAmount, 0)).toBe(
      Math.round(
        (schedule.entries.reduce((sum, entry) => sum + entry.fxContext!.customerAmount, 0) *
          newDeferred) /
          oldDeferred,
      ),
    );
  });

  it('keeps the receiver alive when a read throws outside the mapper', async () => {
    const server = setup('memory');
    const spy = vi.spyOn(server.storage.dedup, 'has').mockImplementation(() => {
      throw new Error('private broken record');
    });
    const res = await server.deliver(fixture('charge_failed_informational'));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Processing failed' });
    expect(server.storage.inbox.count()).toBe(1);
    spy.mockRestore();
    expect((await request(server.app).get('/health')).status).toBe(200);
    expect((await server.deliver(fixture('charge_failed_informational'))).status).toBe(200);
  });

  it('keeps unreadable scheduled data for repair and dispatches healthy rows', async () => {
    const db = database();
    const storage = sqliteStorage(db);
    const event = fixture('charge_succeeded_standard');
    storage.persistMapResult(event.id, mapEvent(event));
    storage.persistMapResult('evt_healthy', mapEvent({ ...event, id: 'evt_healthy' }));
    db.prepare(
      "UPDATE scheduled_entries SET payload = '{broken private record' WHERE id = 1",
    ).run();
    const dispatch = vi.fn();
    const scheduler = createScheduler({
      storage,
      dispatcher: dispatch,
      today: () => '2030-01-01',
      log: silentLogger(),
    });
    expect((await scheduler.tick()).posted).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(storage.entries.countFailedScheduled()).toBe(1);
    expect(db.prepare('SELECT payload FROM scheduled_entries WHERE id = 1').get()).toEqual({
      payload: '{broken private record',
    });
    const { app } = createServer({
      stripe: new Stripe('sk_test_local'),
      webhookSecret: secret,
      storage,
      adminToken,
      log: silentLogger(),
    });
    const res = await request(app).get('/admin/scheduled/1').auth(adminToken, { type: 'bearer' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Processing failed' });
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('keeps refused events across fresh SQLite storage instances', () => {
    const db = database();
    const first: Storage = sqliteStorage(db);
    const event = fixture('invoice_payment_succeeded_monthly');
    first.inbox.receive(event);
    first.inbox.fail(event.id, 'Processing failed');
    const fresh = sqliteStorage(db);
    expect(fresh.inbox.get(event.id)?.event).toEqual(event);
    expect(fresh.inbox.get(event.id)?.status).toBe('failed');
    expect(fresh.inbox.count()).toBe(1);
  });
});
