#!/usr/bin/env node
import Stripe from 'stripe';
import type { QboAccountMap, XeroAccountMap } from '../exporters/types.js';
import { consoleDispatcher } from './dispatchers/console.js';
import { qboDispatcher } from './dispatchers/qbo.js';
import type { QboDispatcherConfig } from './dispatchers/qbo.js';
import { xeroDispatcher } from './dispatchers/xero.js';
import type { XeroDispatcherConfig } from './dispatchers/xero.js';
import { createServer } from './index.js';
import { consoleLogger } from './logger.js';
import type { ConsoleLoggerOptions, Logger } from './logger.js';
import { createScheduler } from './scheduler.js';
import type { Dispatcher, Scheduler } from './scheduler.js';
import { inMemoryStorage } from './storage/inMemory.js';
import { openSqliteDatabase, sqliteStorage } from './storage/sqlite.js';
import type { Storage } from './storage/types.js';

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
type LogLevel = (typeof VALID_LOG_LEVELS)[number];

function isLogLevel(value: string): value is LogLevel {
  return (VALID_LOG_LEVELS as readonly string[]).includes(value);
}

function buildLogger(): Logger {
  const raw = process.env['LEDGERLY_LOG_LEVEL'];
  if (raw === undefined || raw === '') {
    return consoleLogger();
  }
  if (isLogLevel(raw)) {
    const opts: ConsoleLoggerOptions = { level: raw };
    return consoleLogger(opts);
  }
  // Bootstrap: build a default logger to emit the warning, then return it.
  const fallback = consoleLogger();
  fallback.warn('Invalid LEDGERLY_LOG_LEVEL; falling back to info', {
    value: raw,
    valid: VALID_LOG_LEVELS,
  });
  return fallback;
}

const log = buildLogger();

const stripeSecretKey = process.env['STRIPE_SECRET_KEY'];
const webhookSecret = process.env['STRIPE_WEBHOOK_SECRET'];

if (!stripeSecretKey || !webhookSecret) {
  log.error(
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
  log.info('Using SQLite storage', { dbPath });
} else {
  storage = inMemoryStorage();
  log.warn(
    'LEDGERLY_DB_PATH not set; using in-memory storage. Data will be lost on restart.',
  );
}

const { app } = createServer({ stripe, webhookSecret, storage, log });

// Optional background scheduler. Disabled by default; enable by setting
// LEDGERLY_SCHEDULER_ENABLED=true. Polls `scheduled_entries` for rows due on or
// before today and dispatches each via the default console dispatcher.
const scheduleEnabled = process.env['LEDGERLY_SCHEDULER_ENABLED'] === 'true';
const scheduleInterval = Number(
  process.env['LEDGERLY_SCHEDULER_INTERVAL_MS'] ?? 60_000,
);

function buildDispatcher(): Dispatcher {
  const qboToken = process.env['LEDGERLY_QBO_ACCESS_TOKEN'];
  const qboRealm = process.env['LEDGERLY_QBO_REALM_ID'];
  const qboAccountMapJson = process.env['LEDGERLY_QBO_ACCOUNT_MAP_JSON'];
  const qboApiBase = process.env['LEDGERLY_QBO_API_BASE'];

  const anyQboVarSet =
    (qboToken !== undefined && qboToken !== '') ||
    (qboRealm !== undefined && qboRealm !== '') ||
    (qboAccountMapJson !== undefined && qboAccountMapJson !== '');
  const allQboVarsSet =
    qboToken !== undefined &&
    qboToken !== '' &&
    qboRealm !== undefined &&
    qboRealm !== '' &&
    qboAccountMapJson !== undefined &&
    qboAccountMapJson !== '';

  if (allQboVarsSet) {
    let accountMap: QboAccountMap;
    try {
      accountMap = JSON.parse(qboAccountMapJson) as QboAccountMap;
    } catch (err) {
      log.error('Failed to parse LEDGERLY_QBO_ACCOUNT_MAP_JSON', { err });
      process.exit(1);
    }
    log.info('QBO dispatcher enabled', {
      realm: qboRealm,
      apiBase: qboApiBase ?? 'production',
    });
    const cfg: QboDispatcherConfig = {
      accessToken: qboToken,
      realmId: qboRealm,
      accountMap,
      log,
      ...(qboApiBase !== undefined && qboApiBase !== '' ? { apiBase: qboApiBase } : {}),
    };
    return qboDispatcher(cfg);
  }

  if (anyQboVarSet) {
    log.warn(
      'Partial QBO configuration detected (need ALL of LEDGERLY_QBO_ACCESS_TOKEN, LEDGERLY_QBO_REALM_ID, LEDGERLY_QBO_ACCOUNT_MAP_JSON); falling back to console dispatcher.',
    );
    return consoleDispatcher(log);
  }

  const xeroToken = process.env['LEDGERLY_XERO_ACCESS_TOKEN'];
  const xeroTenant = process.env['LEDGERLY_XERO_TENANT_ID'];
  const xeroAccountMapJson = process.env['LEDGERLY_XERO_ACCOUNT_MAP_JSON'];
  const xeroApiBase = process.env['LEDGERLY_XERO_API_BASE'];
  const xeroStatusRaw = process.env['LEDGERLY_XERO_STATUS'];

  const anyXeroVarSet =
    (xeroToken !== undefined && xeroToken !== '') ||
    (xeroTenant !== undefined && xeroTenant !== '') ||
    (xeroAccountMapJson !== undefined && xeroAccountMapJson !== '');
  const allXeroVarsSet =
    xeroToken !== undefined &&
    xeroToken !== '' &&
    xeroTenant !== undefined &&
    xeroTenant !== '' &&
    xeroAccountMapJson !== undefined &&
    xeroAccountMapJson !== '';

  if (allXeroVarsSet) {
    let accountMap: XeroAccountMap;
    try {
      accountMap = JSON.parse(xeroAccountMapJson) as XeroAccountMap;
    } catch (err) {
      log.error('Failed to parse LEDGERLY_XERO_ACCOUNT_MAP_JSON', { err });
      process.exit(1);
    }
    const status: 'DRAFT' | 'POSTED' =
      xeroStatusRaw === 'POSTED' || xeroStatusRaw === 'DRAFT' ? xeroStatusRaw : 'DRAFT';
    log.info('Xero dispatcher enabled', {
      tenant: xeroTenant,
      status,
      apiBase: xeroApiBase ?? 'production',
    });
    const cfg: XeroDispatcherConfig = {
      accessToken: xeroToken,
      tenantId: xeroTenant,
      accountMap,
      status,
      log,
      ...(xeroApiBase !== undefined && xeroApiBase !== '' ? { apiBase: xeroApiBase } : {}),
    };
    return xeroDispatcher(cfg);
  }

  if (anyXeroVarSet) {
    log.warn(
      'Partial Xero configuration detected (need ALL of LEDGERLY_XERO_ACCESS_TOKEN, LEDGERLY_XERO_TENANT_ID, LEDGERLY_XERO_ACCOUNT_MAP_JSON); falling back to console dispatcher.',
    );
    return consoleDispatcher(log);
  }

  log.info('No QBO/Xero env vars set; using console dispatcher.');
  return consoleDispatcher(log);
}

let scheduler: Scheduler | null = null;
if (scheduleEnabled) {
  if (dbPath === undefined || dbPath === '') {
    log.warn(
      'LEDGERLY_SCHEDULER_ENABLED=true but LEDGERLY_DB_PATH is unset; scheduler will find no pending entries (in-memory store starts empty on every restart).',
    );
  }
  // Optional override for the dead-letter threshold. Defaults inside the
  // scheduler (currently 10) are reasonable for most deployments; expose this
  // so operators can dial it for noisy integrations without code changes.
  const maxAttemptsRaw = process.env['LEDGERLY_SCHEDULER_MAX_ATTEMPTS'];
  const parsedMaxAttempts =
    maxAttemptsRaw !== undefined && maxAttemptsRaw !== ''
      ? Number.parseInt(maxAttemptsRaw, 10)
      : undefined;
  const maxAttempts =
    parsedMaxAttempts !== undefined &&
    Number.isFinite(parsedMaxAttempts) &&
    parsedMaxAttempts > 0
      ? parsedMaxAttempts
      : undefined;
  if (maxAttemptsRaw !== undefined && maxAttemptsRaw !== '' && maxAttempts === undefined) {
    log.warn('LEDGERLY_SCHEDULER_MAX_ATTEMPTS is not a positive integer; using default', {
      value: maxAttemptsRaw,
    });
  }
  scheduler = createScheduler({
    storage,
    dispatcher: buildDispatcher(),
    intervalMs: scheduleInterval,
    log,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  });
  scheduler.start();
  log.info('Scheduler enabled', {
    intervalMs: scheduleInterval,
    ...(maxAttempts !== undefined ? { maxAttempts } : {}),
  });
}

const port = Number(process.env['PORT'] ?? 3000);
app.listen(port, () => {
  log.info('ledgerly webhook receiver listening', {
    url: `http://localhost:${String(port)}`,
  });
  log.info('POST /webhook  -> Stripe webhook endpoint');
  log.info('GET  /health   -> health + dedup size');
});

// Graceful shutdown: stop the scheduler so the polling loop unhooks cleanly.
function shutdown(signal: string): void {
  log.info('Received signal; stopping', { signal });
  scheduler?.stop();
  process.exit(0);
}
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
