import { describe, it, expect, beforeEach } from 'vitest';
import Stripe from 'stripe';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from '../../src/server/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_DIR = join(__dirname, '..', 'fixtures');
const WEBHOOK_SECRET = 'whsec_test_dummy_secret_value';

// Stripe's webhook utilities live on the SDK prototype and don't need an
// API key, but instantiating the SDK requires one. Use a throwaway value.
const stripe = new Stripe('sk_test_dummy');

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
    it('returns ok and dedup size', async () => {
      const { app } = createServer({ stripe, webhookSecret: WEBHOOK_SECRET });
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, dedupSize: 0 });
    });
  });

  describe('POST /webhook', () => {
    it('rejects requests with no Stripe-Signature header (400)', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: WEBHOOK_SECRET,
        log: { info: () => undefined, error: () => undefined },
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
        log: { info: () => undefined, error: () => undefined },
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
        log: { info: () => undefined, error: () => undefined },
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
        log: { info: () => undefined, error: () => undefined },
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
        log: { info: () => undefined, error: () => undefined },
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
        log: { info: () => undefined, error: () => undefined },
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
  });
});
