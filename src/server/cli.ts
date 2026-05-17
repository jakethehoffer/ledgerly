#!/usr/bin/env node
import Stripe from 'stripe';
import { consoleDispatcher } from './dispatchers/console.js';
import { createServer } from './index.js';
import { createScheduler } from './scheduler.js';
import type { Scheduler } from './scheduler.js';
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

// Optional background scheduler. Disabled by default; enable by setting
// LEDGERLY_SCHEDULER_ENABLED=true. Polls `scheduled_entries` for rows due on or
// before today and dispatches each via the default console dispatcher.
const scheduleEnabled = process.env['LEDGERLY_SCHEDULER_ENABLED'] === 'true';
const scheduleInterval = Number(
  process.env['LEDGERLY_SCHEDULER_INTERVAL_MS'] ?? 60_000,
);

let scheduler: Scheduler | null = null;
if (scheduleEnabled) {
  if (dbPath === undefined || dbPath === '') {
    // eslint-disable-next-line no-console
    console.warn(
      'LEDGERLY_SCHEDULER_ENABLED=true but LEDGERLY_DB_PATH is unset; scheduler will find no pending entries (in-memory store starts empty on every restart).',
    );
  }
  scheduler = createScheduler({
    storage,
    dispatcher: consoleDispatcher(),
    intervalMs: scheduleInterval,
  });
  scheduler.start();
  // eslint-disable-next-line no-console
  console.log(`Scheduler enabled, polling every ${String(scheduleInterval)}ms`);
}

const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`ledgerly webhook receiver listening on http://localhost:${String(port)}`);
  // eslint-disable-next-line no-console
  console.log('POST /webhook  -> Stripe webhook endpoint');
  // eslint-disable-next-line no-console
  console.log('GET  /health   -> health + dedup size');
});

// Graceful shutdown: stop the scheduler so the polling loop unhooks cleanly.
function shutdown(signal: string): void {
  // eslint-disable-next-line no-console
  console.log(`Received ${signal}; stopping...`);
  scheduler?.stop();
  process.exit(0);
}
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
