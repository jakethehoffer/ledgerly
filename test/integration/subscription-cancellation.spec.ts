import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import request, { type Response } from 'supertest';
import { mapEvent } from '../../src/engine.js';
import { createServer } from '../../src/server/index.js';
import { silentLogger } from '../../src/server/logger.js';
import { createScheduler } from '../../src/server/scheduler.js';
import {
  buildSubscriptionCancellationInput,
  subscriptionCancellationNeedsReconcile,
} from '../../src/server/subscriptionCancellationReconciler.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');
const WEBHOOK_SECRET = 'whsec_subscription_cancellation_test';
const SUBSCRIPTION_ID = 'sub_test_annual_001';

function loadEvent(name: string): Stripe.Event {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${name}.event.json`), 'utf8'),
  ) as Stripe.Event;
}

function cancellationEvent(
  effectiveEnd: string,
  eventId = 'evt_test_annual_cancelled_001',
): Stripe.Event {
  const event = loadEvent('subscription_deleted_informational');
  const subscription = event.data.object as Stripe.Subscription;
  const endedAt = Math.floor(Date.parse(effectiveEnd) / 1000);
  (event as { id: string }).id = eventId;
  (event as { created: number }).created = endedAt;
  (subscription as { id: string }).id = SUBSCRIPTION_ID;
  (subscription as { current_period_end: number }).current_period_end = endedAt;
  (subscription as { canceled_at: number }).canceled_at = endedAt;
  (subscription as { ended_at: number }).ended_at = endedAt;
  return event;
}

describe('integration: subscription cancellation schedule close-out', () => {
  it('acts only on an ended subscription and uses the actual end date', () => {
    const ended = cancellationEvent('2025-07-15T12:00:00Z');
    expect(subscriptionCancellationNeedsReconcile(ended)).toBe(true);
    expect(buildSubscriptionCancellationInput(ended)).toEqual({
      subscriptionId: SUBSCRIPTION_ID,
      effectiveEndDate: '2025-07-15',
    });

    const scheduled = loadEvent('subscription_updated_informational');
    const subscription = scheduled.data.object as Stripe.Subscription;
    (subscription as { id: string }).id = SUBSCRIPTION_ID;
    (subscription as { cancel_at_period_end: boolean }).cancel_at_period_end = true;
    (subscription as { cancel_at: number }).cancel_at = Math.floor(
      Date.parse('2026-01-15T12:00:00Z') / 1000,
    );
    expect(subscriptionCancellationNeedsReconcile(scheduled)).toBe(false);
    expect(mapEvent(scheduled)).toEqual({ entries: [], schedule: null });

    // Removing a planned cancellation is also informational. No schedule rows
    // were stopped early, so there is nothing risky to restore.
    (scheduled as { id: string }).id = 'evt_test_cancel_removed_001';
    (subscription as { cancel_at_period_end: boolean }).cancel_at_period_end = false;
    (subscription as { cancel_at: null }).cancel_at = null;
    expect(subscriptionCancellationNeedsReconcile(scheduled)).toBe(false);
    expect(mapEvent(scheduled)).toEqual({ entries: [], schedule: null });
  });

  it('keeps earned months and the end-date month, then holds only later rows', () => {
    const storage = inMemoryStorage();
    const original = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(original.id, mapEvent(original));
    const rows = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    for (const row of rows.slice(0, 5)) storage.entries.markScheduledPosted(row.id);

    const cancellation = cancellationEvent('2025-07-15T12:00:00Z');
    const first = storage.persistSubscriptionCancellation(
      cancellation.id,
      buildSubscriptionCancellationInput(cancellation),
    );
    expect(first).toEqual({ duplicate: false });

    const after = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    expect(after.filter((row) => row.status === 'posted')).toHaveLength(5);
    expect(after.filter((row) => row.status === 'pending').map((row) => row.entry.date)).toEqual([
      '2025-07-15',
    ]);
    expect(after.filter((row) => row.status === 'held').map((row) => row.entry.date)).toEqual([
      '2025-08-15',
      '2025-09-15',
      '2025-10-15',
      '2025-11-15',
      '2025-12-15',
      '2026-01-15',
    ]);
    expect(storage.entries.findByEventId(cancellation.id)).toHaveLength(0);

    // A Stripe redelivery cannot change the rows again.
    expect(
      storage.persistSubscriptionCancellation(
        cancellation.id,
        buildSubscriptionCancellationInput(cancellation),
      ),
    ).toEqual({ duplicate: true });
  });

  it('leaves a full paid-term schedule alone when cancellation happens at period end', () => {
    const storage = inMemoryStorage();
    const original = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(original.id, mapEvent(original));

    const cancellation = cancellationEvent(
      '2026-01-15T12:00:00Z',
      'evt_test_period_end_cancelled_001',
    );
    storage.persistSubscriptionCancellation(
      cancellation.id,
      buildSubscriptionCancellationInput(cancellation),
    );

    const rows = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    expect(rows.filter((row) => row.status === 'pending')).toHaveLength(12);
    expect(rows.filter((row) => row.status === 'cancelled')).toHaveLength(0);
    expect(storage.dedup.has(cancellation.id)).toBe(true);
  });

  it('closes through a signed webhook and the scheduler sends only the kept end-date month', async () => {
    const original = loadEvent('invoice_payment_succeeded_annual');
    const stripe = new Stripe('sk_test_subscription_cancellation');
    type InvoiceRetrieve = typeof stripe.invoices.retrieve;
    (stripe.invoices as unknown as { retrieve: InvoiceRetrieve }).retrieve = ((
      id: string,
    ): Promise<Stripe.Invoice> => {
      if (id !== 'in_test_annual_001') throw new Error(`Missing test invoice ${id}`);
      return Promise.resolve(original.data.object as Stripe.Invoice);
    }) as InvoiceRetrieve;

    const storage = inMemoryStorage();
    const { app } = createServer({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      storage,
      log: silentLogger(),
    });
    async function send(event: Stripe.Event): Promise<Response> {
      const raw = JSON.stringify(event);
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: raw,
        secret: WEBHOOK_SECRET,
      });
      return request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(raw);
    }

    expect((await send(original)).status).toBe(200);
    const originalCashDispatch = storage.entries
      .listScheduledByStatus('pending')
      .find((row) => row.subscriptionId === `immediate:${original.id}`);
    if (!originalCashDispatch) throw new Error('Original cash entry was not queued');
    storage.entries.markScheduledPosted(originalCashDispatch.id);
    const rows = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    for (const row of rows.slice(0, 5)) storage.entries.markScheduledPosted(row.id);

    const cancellation = cancellationEvent('2025-07-15T12:00:00Z');
    const response = await send(cancellation);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, entries: 0, schedule: false });

    const kept = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .find((row) => row.status === 'pending');
    if (!kept) throw new Error('Cancellation lost the end-date recognition row');
    const sentIds: number[] = [];
    const scheduler = createScheduler({
      storage,
      dispatcher(entry) {
        sentIds.push(entry.id);
      },
      today: () => '2025-08-15',
      log: silentLogger(),
    });
    await scheduler.tick();

    expect(sentIds).toEqual([kept.id]);
    expect(storage.entries.getScheduledById(kept.id)?.status).toBe('posted');
    expect(storage.entries.listScheduledByStatus('held')).toHaveLength(6);
    expect((await send(cancellation)).body).toEqual({ duplicate: true });
  });
});
