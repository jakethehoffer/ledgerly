#!/usr/bin/env node
import Stripe from 'stripe';
import { createServer } from './index.js';
import { inMemoryStorage } from './storage/inMemory.js';
import { openSqliteDatabase, sqliteStorage } from './storage/sqlite.js';
import type { Storage } from './storage/types.js';

const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET'];

if (!stripeSecretKey || !webhookSecret) {
  // eslint-disable-next-line no-console
  console.error(
    'Missing STRIPE_SECRET_KEY or STRIPE_WEBHOOK_SECRET environment variables',
  );
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey);

const dbPath = process.env['LEDGERLY_DB_PATH'];
let storage: Storage;
if (dbPath !== undefined && dbPath !== '') {
  const db = openSqliteDatabase(dbPath);
  storage = sqliteStorage(db);
  // eslint-disable-next-line no-console
  console.log(`Using SQLite storage at ${dbPath}`);
} else {
  storage = inMemoryStorage();
  // eslint-disable-next-line no-console
  console.warn(
    'LEDGERLY_DB_PATH not set; using in-memory storage. Data will be lost on restart.',
  );
}

const { app } = createServer({ stripe, webhookSecret, storage });

const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`ledgerly webhook receiver listening on http://localhost:${String(port)}`);
  // eslint-disable-next-line no-console
  console.log('POST /webhook  -> Stripe webhook endpoint');
  // eslint-disable-next-line no-console
  console.log('GET  /health   -> health + dedup size');
});
