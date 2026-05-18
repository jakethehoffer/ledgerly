import { describe, it, expect } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createServer } from '../../src/server/index.js';
import { silentLogger } from '../../src/server/logger.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';
import { cents } from '../../src/money.js';
import type { JournalEntry, MapResult } from '../../src/journal.js';
import type { Storage } from '../../src/server/storage/types.js';

const ADMIN_TOKEN = 'a'.repeat(48);
const stripe = new Stripe('sk_test_dummy');

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    date: '2026-05-16',
    currency: 'USD',
    memo: 'test',
    sourceEventId: 'evt_test_1',
    sourceEventType: 'charge.succeeded',
    sourceObjectId: 'ch_test_1',
    lines: [
      { accountCode: '1010', side: 'debit', amount: cents(10000) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ],
    ...overrides,
  };
}

function seedImmediate(storage: Storage, n: number): void {
  for (let i = 0; i < n; i++) {
    const entry = makeEntry({
      memo: `imm-${String(i)}`,
      sourceEventId: `evt_imm_${String(i)}`,
    });
    const result: MapResult = { entries: [entry], schedule: null };
    storage.persistMapResult(`evt_imm_${String(i)}`, result);
  }
}

function seedFailedScheduled(storage: Storage): number {
  const saved = storage.entries.saveScheduled(
    makeEntry({ date: '2026-05-01', memo: 'failed-one' }),
    { subscriptionId: 'sub_fail', sourceEventId: 'evt_fail' },
  );
  storage.entries.recordScheduledAttempt(
    saved.id,
    10,
    5_000_000,
    null,
    'oauth revoked',
    'failed',
  );
  return saved.id;
}

describe('Admin endpoints', () => {
  describe('when adminToken is unset', () => {
    it('returns 404 for every admin route', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
      });
      for (const path of [
        '/admin/entries',
        '/admin/scheduled',
        '/admin/scheduled/1',
      ]) {
        const res = await request(app).get(path);
        expect(res.status).toBe(404);
      }
      const post = await request(app).post('/admin/scheduled/1/retry');
      expect(post.status).toBe(404);
    });
  });

  describe('auth', () => {
    it('401 when bearer is missing', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app).get('/admin/entries');
      expect(res.status).toBe(401);
      expect((res.body as { error?: string }).error).toMatch(/missing bearer/i);
    });

    it('401 when bearer length differs from expected (timing-safe path)', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/entries')
        .set('Authorization', 'Bearer short');
      expect(res.status).toBe(401);
    });

    it('401 when bearer length matches but contents differ', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/entries')
        .set('Authorization', `Bearer ${'b'.repeat(ADMIN_TOKEN.length)}`);
      expect(res.status).toBe(401);
    });

    it('200 when bearer matches', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/entries')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entries: [] });
    });
  });

  describe('GET /admin/entries', () => {
    it('returns recent immediate entries newest-first', async () => {
      const storage = inMemoryStorage();
      seedImmediate(storage, 3);
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage,
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/entries')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      const body = res.body as { entries: Array<{ id: number; entry: JournalEntry }> };
      expect(body.entries).toHaveLength(3);
      const ids = body.entries.map((e) => e.id);
      expect(ids).toEqual([...ids].sort((a, b) => b - a));
    });

    it('respects ?limit', async () => {
      const storage = inMemoryStorage();
      seedImmediate(storage, 5);
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage,
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/entries?limit=2')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      const body = res.body as { entries: unknown[] };
      expect(body.entries).toHaveLength(2);
    });

    it('400 on non-numeric ?limit', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/entries?limit=abc')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /admin/scheduled', () => {
    it('defaults to status=pending', async () => {
      const storage = inMemoryStorage();
      seedImmediate(storage, 2); // these enqueue pending immediate-dispatch rows
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage,
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/scheduled')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      const body = res.body as { entries: Array<{ status: string }> };
      expect(body.entries).toHaveLength(2);
      for (const e of body.entries) expect(e.status).toBe('pending');
    });

    it('filters by status=failed', async () => {
      const storage = inMemoryStorage();
      const failedId = seedFailedScheduled(storage);
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage,
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/scheduled?status=failed')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      const body = res.body as { entries: Array<{ id: number; status: string }> };
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0]?.id).toBe(failedId);
      expect(body.entries[0]?.status).toBe('failed');
    });

    it('400 on invalid status', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/scheduled?status=bogus')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /admin/scheduled/:id', () => {
    it('returns the entry', async () => {
      const storage = inMemoryStorage();
      const failedId = seedFailedScheduled(storage);
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage,
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get(`/admin/scheduled/${String(failedId)}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      const body = res.body as { entry: { id: number; status: string; lastError: string } };
      expect(body.entry.id).toBe(failedId);
      expect(body.entry.status).toBe('failed');
      expect(body.entry.lastError).toBe('oauth revoked');
    });

    it('404 when not found', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/scheduled/9999')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
    });

    it('400 on non-numeric id', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .get('/admin/scheduled/abc')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(400);
    });
  });

  describe('POST /admin/scheduled/:id/retry', () => {
    it('flips a failed entry back to pending with cleared retry fields', async () => {
      const storage = inMemoryStorage();
      const failedId = seedFailedScheduled(storage);
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage,
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .post(`/admin/scheduled/${String(failedId)}/retry`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(200);
      const body = res.body as {
        entry: {
          id: number;
          status: string;
          attempts: number;
          lastError: string | null;
          nextAttemptAt: number | null;
        };
      };
      expect(body.entry.id).toBe(failedId);
      expect(body.entry.status).toBe('pending');
      expect(body.entry.attempts).toBe(0);
      expect(body.entry.lastError).toBeNull();
      expect(body.entry.nextAttemptAt).toBeNull();
      // And the scheduler-eligible query now picks it up.
      expect(storage.entries.countPendingScheduled()).toBe(1);
      expect(storage.entries.countFailedScheduled()).toBe(0);
    });

    it('404 on unknown id', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .post('/admin/scheduled/9999/retry')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(404);
    });

    it('400 on non-numeric id', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        storage: inMemoryStorage(),
        adminToken: ADMIN_TOKEN,
      });
      const res = await request(app)
        .post('/admin/scheduled/abc/retry')
        .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
      expect(res.status).toBe(400);
    });
  });
});
