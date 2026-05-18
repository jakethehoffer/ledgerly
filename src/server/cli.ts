#!/usr/bin/env node
// Auto-load .env (if present) into process.env before any config reads.
// Library consumers of ledgerly are unaffected — this only runs in the CLI entry point.
import 'dotenv/config';
import Stripe from 'stripe';
import type { QboAccountMap, XeroAccountMap } from '../exporters/types.js';
import { consoleDispatcher } from './dispatchers/console.js';
import { managedQboDispatcher } from './dispatchers/managedQbo.js';
import type { ManagedQboDispatcherConfig } from './dispatchers/managedQbo.js';
import { managedXeroDispatcher } from './dispatchers/managedXero.js';
import type { ManagedXeroDispatcherConfig } from './dispatchers/managedXero.js';
import { qboDispatcher } from './dispatchers/qbo.js';
import type { QboDispatcherConfig } from './dispatchers/qbo.js';
import { xeroDispatcher } from './dispatchers/xero.js';
import type { XeroDispatcherConfig } from './dispatchers/xero.js';
import { createServer } from './index.js';
import type { OAuthServerConfig } from './index.js';
import { consoleLogger, jsonLogger } from './logger.js';
import type { ConsoleLoggerOptions, JsonLoggerOptions, Logger } from './logger.js';
import { inMemoryMetrics } from './metrics.js';
import type { InMemoryMetricsOptions, Metrics } from './metrics.js';
import type { OAuthClientConfig } from './oauth/types.js';
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
  // Format dispatcher: 'json' produces one JSON object per line (for log
  // aggregators); anything else (including unset) uses the pretty-print
  // console logger. Unknown values fall back to console with a warning
  // emitted on the resulting logger so the operator notices.
  const formatRaw = process.env['LEDGERLY_LOG_FORMAT'];
  const wantJson = formatRaw === 'json';
  const wantConsole = formatRaw === undefined || formatRaw === '' || formatRaw === 'console';
  const unknownFormat = !wantJson && !wantConsole;

  const levelRaw = process.env['LEDGERLY_LOG_LEVEL'];
  const level = levelRaw !== undefined && levelRaw !== '' && isLogLevel(levelRaw)
    ? levelRaw
    : undefined;
  const unknownLevel = levelRaw !== undefined && levelRaw !== '' && level === undefined;

  let logger: Logger;
  if (wantJson) {
    const opts: JsonLoggerOptions = level !== undefined ? { level } : {};
    logger = jsonLogger(opts);
  } else {
    const opts: ConsoleLoggerOptions = level !== undefined ? { level } : {};
    logger = consoleLogger(opts);
  }

  if (unknownLevel) {
    logger.warn('Invalid LEDGERLY_LOG_LEVEL; falling back to info', {
      value: levelRaw,
      valid: VALID_LOG_LEVELS,
    });
  }
  if (unknownFormat) {
    logger.warn('Invalid LEDGERLY_LOG_FORMAT; falling back to console', {
      value: formatRaw,
      valid: ['console', 'json'],
    });
  }
  return logger;
}

const log = buildLogger();

function buildMetrics(): Metrics {
  const raw = process.env['LEDGERLY_METRICS_NAMESPACE'];
  if (raw === undefined || raw === '') {
    return inMemoryMetrics();
  }
  const opts: InMemoryMetricsOptions = { namespace: raw };
  return inMemoryMetrics(opts);
}

const metrics = buildMetrics();

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

/**
 * Build an `OAuthClientConfig` from the env vars for one provider. Returns
 * `null` when none of the vars are set (the provider is simply disabled);
 * exits with code 1 when only some are set (operator misconfiguration).
 */
function buildOAuthClient(
  prefix: 'QBO' | 'XERO',
): OAuthClientConfig | null {
  const clientId = process.env[`LEDGERLY_${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`LEDGERLY_${prefix}_CLIENT_SECRET`];
  const redirectUri = process.env[`LEDGERLY_${prefix}_REDIRECT_URI`];
  const anySet =
    (clientId !== undefined && clientId !== '') ||
    (clientSecret !== undefined && clientSecret !== '') ||
    (redirectUri !== undefined && redirectUri !== '');
  const allSet =
    clientId !== undefined &&
    clientId !== '' &&
    clientSecret !== undefined &&
    clientSecret !== '' &&
    redirectUri !== undefined &&
    redirectUri !== '';
  if (!anySet) return null;
  if (!allSet) {
    log.error(
      `Partial ${prefix} OAuth configuration: need all of LEDGERLY_${prefix}_CLIENT_ID, LEDGERLY_${prefix}_CLIENT_SECRET, LEDGERLY_${prefix}_REDIRECT_URI`,
    );
    process.exit(1);
  }
  return { clientId, clientSecret, redirectUri };
}

const qboOAuthClient = buildOAuthClient('QBO');
const xeroOAuthClient = buildOAuthClient('XERO');
const oauthStateSecret = process.env['LEDGERLY_OAUTH_STATE_SECRET'];

const adminTokenRaw = process.env['LEDGERLY_ADMIN_TOKEN'];
let adminToken: string | undefined;
if (adminTokenRaw !== undefined && adminTokenRaw !== '') {
  if (adminTokenRaw.length < 32) {
    log.error(
      'LEDGERLY_ADMIN_TOKEN is too short; must be at least 32 characters. Generate one with `openssl rand -base64 48`.',
    );
    process.exit(1);
  }
  adminToken = adminTokenRaw;
}

let oauthConfig: OAuthServerConfig | undefined;
if (qboOAuthClient !== null || xeroOAuthClient !== null) {
  if (oauthStateSecret === undefined || oauthStateSecret === '') {
    log.error(
      'OAuth client config detected but LEDGERLY_OAUTH_STATE_SECRET is unset. Generate one with `openssl rand -base64 48`.',
    );
    process.exit(1);
  }
  if (oauthStateSecret.length < 32) {
    log.error(
      'LEDGERLY_OAUTH_STATE_SECRET is too short; must be at least 32 characters.',
    );
    process.exit(1);
  }
  oauthConfig = {
    stateSecret: oauthStateSecret,
    ...(qboOAuthClient !== null ? { qbo: qboOAuthClient } : {}),
    ...(xeroOAuthClient !== null ? { xero: xeroOAuthClient } : {}),
  };
  log.info('OAuth endpoints enabled', {
    providers: [
      qboOAuthClient !== null ? 'qbo' : null,
      xeroOAuthClient !== null ? 'xero' : null,
    ].filter((p): p is string => p !== null),
  });
}

const { app } = createServer({
  stripe,
  webhookSecret,
  storage,
  log,
  metrics,
  ...(oauthConfig !== undefined ? { oauth: oauthConfig } : {}),
  ...(adminToken !== undefined ? { adminToken } : {}),
});

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

  // OAuth path wins over the static-token path. If the operator has
  // configured a QBO OAuth client and there is an account map env var, use
  // the managed dispatcher — the token comes from storage and is refreshed
  // automatically.
  if (qboOAuthClient !== null && qboAccountMapJson !== undefined && qboAccountMapJson !== '') {
    let accountMap: QboAccountMap;
    try {
      accountMap = JSON.parse(qboAccountMapJson) as QboAccountMap;
    } catch (err) {
      log.error('Failed to parse LEDGERLY_QBO_ACCOUNT_MAP_JSON', { err });
      process.exit(1);
    }
    log.info('Managed QBO dispatcher enabled (OAuth + storage-backed tokens)', {
      apiBase: qboApiBase ?? 'production',
    });
    const cfg: ManagedQboDispatcherConfig = {
      oauthClient: qboOAuthClient,
      storage,
      accountMap,
      log,
      ...(qboApiBase !== undefined && qboApiBase !== '' ? { apiBase: qboApiBase } : {}),
    };
    return managedQboDispatcher(cfg);
  }

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

  if (xeroOAuthClient !== null && xeroAccountMapJson !== undefined && xeroAccountMapJson !== '') {
    let accountMap: XeroAccountMap;
    try {
      accountMap = JSON.parse(xeroAccountMapJson) as XeroAccountMap;
    } catch (err) {
      log.error('Failed to parse LEDGERLY_XERO_ACCOUNT_MAP_JSON', { err });
      process.exit(1);
    }
    const status: 'DRAFT' | 'POSTED' =
      xeroStatusRaw === 'POSTED' || xeroStatusRaw === 'DRAFT' ? xeroStatusRaw : 'DRAFT';
    log.info('Managed Xero dispatcher enabled (OAuth + storage-backed tokens)', {
      status,
      apiBase: xeroApiBase ?? 'production',
    });
    const cfg: ManagedXeroDispatcherConfig = {
      oauthClient: xeroOAuthClient,
      storage,
      accountMap,
      status,
      log,
      ...(xeroApiBase !== undefined && xeroApiBase !== '' ? { apiBase: xeroApiBase } : {}),
    };
    return managedXeroDispatcher(cfg);
  }

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
    metrics,
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
  log.info('GET  /metrics  -> Prometheus metrics');
  if (adminToken !== undefined) {
    log.info('GET  /admin/*  -> operational admin endpoints (bearer-gated)');
  }
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
