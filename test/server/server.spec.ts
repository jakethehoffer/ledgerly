import { describe, it, expect, beforeEach, vi } from 'vitest';
import Stripe from 'stripe';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from '../../src/server/index.js';
import { silentLogger } from '../../src/server/logger.js';
import { inMemoryMetrics } from '../../src/server/metrics.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';
import type { Storage } from '../../src/server/storage/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_DIR = join(__dirname, '..', 'fixtures');
const WEBHOOK_SECRET = 'whsec_test_dummy_secret_value';

// Stripe's webhook utilities live on the SDK prototype and don't need an
// API key, but instantiating the SDK requires one. Use a throwaway value.
const stripe = new Stripe('sk_test_dummy');

// Stub `stripe.payouts.retrieve` to return the fixture's payout object
// directly. The server tests use payout_paid_standard for the
// "processes a known event" cases precisely because it kept the test
// off the Stripe network — but v0.1.11 expand.ts now requests
// `expand: ['destination']` on payout events so the engine can detect
// cross-currency payouts. The stub preserves the no-network test
// setup; it returns the original payout object (with destination still
// a string ID), so the engine treats it as same-currency and produces
// the same entries the older test suite expected.
const payoutFixturePath = join(FIXTURE_DIR, 'payout_paid_standard.event.json');
const payoutFixtureEvent = JSON.parse(
  readFileSync(payoutFixturePath, 'utf8'),
) as Stripe.Event;
const payoutFixtureObject = payoutFixtureEvent.data.object as Stripe.Payout;
type RetrieveFn = typeof stripe.payouts.retrieve;
(
  stripe.payouts as unknown as { retrieve: RetrieveFn }
).retrieve = vi.fn().mockResolvedValue(payoutFixtureObject) as unknown as RetrieveFn;

function loadFixture(name: string): { raw: string; parsed: Stripe.Event } {
  const path = join(FIXTURE_DIR, `${name}.event.json`);
  // Re-stringify so we know the exact bytes that will be sent over the wire.
  // The fixture file is pretty-printed; what matters is that the signed
  // payload and the request body are byte-identical.
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Stripe.Event;
  const raw = JSON.stringify(parsed);
  return { raw, parsed };
}

function signPayload(rawBody: string, secret: string = WEBHOOK_SECRET): string {
  return stripe.webhooks.generateTestHeaderString({
    payload: rawBody,
    secret,
  });
}

describe('createServer', () => {
  beforeEach(() => {
    // Each test creates its own server so dedup state is fresh.
  });

  describe('GET /health', () => {
    it('returns ok and storage counters', async () => {
      const { app } = createServer({ stripe, webhookSecret: WEBHOOK_SECRET });
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        dedupSize: 0,
        journalEntries: 0,
        pendingScheduled: 0,
        failedScheduled: 0,
      });
    });
  });

  describe('GET /readyz', () => {
    it('returns 200 with ready=true when storage.ping succeeds', async () => {
      const { app } = createServer({ stripe, webhookSecret: WEBHOOK_SECRET });
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ready: true, checks: { storage: 'ok' } });
    });

    it('returns 503 with ready=false and the error message when ping throws', async () => {
      // Stub a Storage whose ping fails — everything else delegates to a real
      // in-memory backend so the other routes still work and the test setup
      // is minimal.
      const real = inMemoryStorage();
      const broken: Storage = {
        ...real,
        ping(): void {
          throw new Error('disk unreachable');
        },
      };
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        storage: broken,
        log: silentLogger(),
      });
      const res = await request(app).get('/readyz');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({
        ready: false,
        checks: { storage: 'disk unreachable' },
      });
    });
  });

  describe('POST /webhook', () => {
    it('rejects requests with no Stripe-Signature header (400)', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw } = loadFixture('payout_paid_standard');
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .send(raw);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Missing Stripe-Signature header' });
    });

    it('rejects bad signatures (400)', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw } = loadFixture('payout_paid_standard');
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', 't=1700000000,v1=deadbeef')
        .send(raw);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Signature verification failed' });
    });

    it('processes a known event type successfully (200)', async () => {
      const { app, dedup } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw } = loadFixture('payout_paid_standard');
      const sig = signPayload(raw);
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
      expect(res.body.entries).toBeGreaterThan(0);
      expect(dedup.size()).toBe(1);
    });

    it('treats duplicate event IDs as duplicates (200 with duplicate:true)', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw } = loadFixture('payout_paid_standard');

      const sig1 = signPayload(raw);
      const first = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig1)
        .send(raw);
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ ok: true });

      // Sign again — same payload, valid signature, but Stripe sometimes
      // redelivers. The second call must be detected as a duplicate.
      const sig2 = signPayload(raw);
      const second = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig2)
        .send(raw);
      expect(second.status).toBe(200);
      expect(second.body).toEqual({ duplicate: true });
    });

    it('acknowledges unhandled event types with 200 and unhandled:true', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const unknownEvent = {
        id: 'evt_test_unknown_001',
        object: 'event',
        api_version: '2024-12-18.acacia',
        created: 1_700_000_000,
        type: 'payment_intent.succeeded',
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        data: { object: { id: 'pi_test' } },
      };
      const raw = JSON.stringify(unknownEvent);
      const sig = signPayload(raw);
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, unhandled: true });
    });

    it('persists journal entries via the storage layer on success', async () => {
      const { app, storage } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw, parsed } = loadFixture('payout_paid_standard');
      const sig = signPayload(raw);
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      expect(res.status).toBe(200);
      expect(storage.entries.countImmediate()).toBeGreaterThan(0);
      const found = storage.entries.findByEventId(parsed.id);
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]?.entry.sourceEventId).toBe(parsed.id);
    });

    it('increments webhook_received + webhook_processed counters on success', async () => {
      const metrics = inMemoryMetrics();
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
        metrics,
      });
      const { raw } = loadFixture('payout_paid_standard');
      const sig = signPayload(raw);
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      expect(res.status).toBe(200);
      const out = metrics.render();
      expect(out).toContain('ledgerly_webhook_received_total 1');
      expect(out).toContain('ledgerly_webhook_processed_total{type="payout.paid"} 1');
    });

    it('increments webhook_duplicate counter on a duplicate POST', async () => {
      const metrics = inMemoryMetrics();
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
        metrics,
      });
      const { raw } = loadFixture('payout_paid_standard');
      const sig1 = signPayload(raw);
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig1)
        .send(raw);
      const sig2 = signPayload(raw);
      const dup = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig2)
        .send(raw);
      expect(dup.status).toBe(200);
      const out = metrics.render();
      expect(out).toContain('ledgerly_webhook_received_total 2');
      expect(out).toContain('ledgerly_webhook_duplicate_total 1');
    });

    it('increments webhook_signature_error on a bad signature', async () => {
      const metrics = inMemoryMetrics();
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
        metrics,
      });
      const { raw } = loadFixture('payout_paid_standard');
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', 't=1700000000,v1=deadbeef')
        .send(raw);
      expect(metrics.render()).toContain('ledgerly_webhook_signature_error_total 1');
    });

    it('increments webhook_unhandled for unhandled event types', async () => {
      const metrics = inMemoryMetrics();
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
        metrics,
      });
      const unknownEvent = {
        id: 'evt_test_unknown_metrics_001',
        object: 'event',
        api_version: '2024-12-18.acacia',
        created: 1_700_000_000,
        type: 'payment_intent.succeeded',
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        data: { object: { id: 'pi_test' } },
      };
      const raw = JSON.stringify(unknownEvent);
      const sig = signPayload(raw);
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      expect(res.status).toBe(200);
      expect(metrics.render()).toContain(
        'ledgerly_webhook_unhandled_total{type="payment_intent.succeeded"} 1',
      );
    });

    it('returns 500 when expansion throws', async () => {
      // Inject a stripe stub that uses the real Webhooks instance for signing
      // but a charges.retrieve that throws. This avoids real network I/O while
      // still exercising the error path.
      const stubStripe = {
        webhooks: stripe.webhooks,
        charges: {
          retrieve: () => Promise.reject(new Error('boom')),
        },
      } as unknown as Stripe;
      const { app } = createServer({
        stripe: stubStripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw } = loadFixture('charge_succeeded_standard');
      const sig = signPayload(raw);
      const res = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Expansion failed' });
    });

    it('increments webhook_expansion_error counter when expansion throws', async () => {
      const stubStripe = {
        webhooks: stripe.webhooks,
        charges: {
          retrieve: () => Promise.reject(new Error('boom')),
        },
      } as unknown as Stripe;
      const metrics = inMemoryMetrics();
      const { app } = createServer({
        stripe: stubStripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
        metrics,
      });
      const { raw } = loadFixture('charge_succeeded_standard');
      const sig = signPayload(raw);
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      expect(metrics.render()).toContain('ledgerly_webhook_expansion_error_total 1');
    });
  });

  describe('GET /metrics', () => {
    it('returns 200 with text/plain content type', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/plain/);
    });

    it('includes at least one # TYPE line after any metric is recorded', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      // Hit /metrics once: refreshes the gauges so we have something to render.
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('# TYPE');
    });

    it('reflects webhook counters after a successful POST', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw } = loadFixture('payout_paid_standard');
      const sig = signPayload(raw);
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('ledgerly_webhook_received_total 1');
      expect(res.text).toContain(
        'ledgerly_webhook_processed_total{type="payout.paid"} 1',
      );
    });

    it('reflects webhook_duplicate counter after a duplicate POST', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw } = loadFixture('payout_paid_standard');
      const sig1 = signPayload(raw);
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig1)
        .send(raw);
      const sig2 = signPayload(raw);
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig2)
        .send(raw);
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('ledgerly_webhook_duplicate_total 1');
    });

    it('refreshes storage-backed gauges on every scrape', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: silentLogger(),
      });
      const { raw } = loadFixture('payout_paid_standard');
      const sig = signPayload(raw);
      await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', sig)
        .send(raw);
      const res = await request(app).get('/metrics');
      expect(res.text).toContain('ledgerly_dedup_size 1');
      expect(res.text).toContain('ledgerly_journal_entries ');
    });
  });
});
