import express, { type Express, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { mapEvent } from '../engine.js';
import { UnhandledEventError } from '../errors.js';
import { expandEvent } from './expand.js';
import { consoleLogger } from './logger.js';
import type { Logger } from './logger.js';
import { inMemoryMetrics } from './metrics.js';
import type { Metrics } from './metrics.js';
import {
  buildQboAuthUrl,
  exchangeQboCode,
  type QboCallbackParams,
} from './oauth/qbo.js';
import { createStateSigner, type StateSigner } from './oauth/state.js';
import type { OAuthClientConfig, OAuthProvider } from './oauth/types.js';
import { OAuthError } from './oauth/types.js';
import {
  buildXeroAuthUrl,
  exchangeXeroCode,
  getXeroConnections,
} from './oauth/xero.js';
import { inMemoryStorage } from './storage/inMemory.js';
import type { Deduplicator, Storage } from './storage/types.js';

/**
 * OAuth client configuration block, attached to {@link ServerConfig.oauth}.
 *
 * `stateSecret` signs the CSRF `state` parameter on the authorize URL. It
 * must be ≥32 characters (enforced by {@link createStateSigner}). Generate it
 * with something like `openssl rand -base64 48` and treat it like any other
 * secret.
 *
 * `qbo` and `xero` are optional — set only the providers you've registered
 * an OAuth app with. If a provider's block is missing, its `/oauth/<provider>/*`
 * endpoints return 404.
 *
 * `fetch` is injectable for tests; defaults to `globalThis.fetch`.
 */
export interface OAuthServerConfig {
  readonly stateSecret: string;
  readonly qbo?: OAuthClientConfig;
  readonly xero?: OAuthClientConfig;
  readonly fetch?: typeof globalThis.fetch;
}

export interface ServerConfig {
  /** The Stripe SDK instance for signature verification and API expansion. */
  stripe: Stripe;
  /** The webhook signing secret from the Stripe dashboard. */
  webhookSecret: string;
  /**
   * Optional storage (dedup + journal entry persistence). Defaults to a fresh
   * `inMemoryStorage()` with 7-day dedup TTL.
   */
  storage?: Storage;
  /**
   * Deprecated. Pass `storage` instead. If provided (and `storage` is not),
   * the receiver builds an in-memory `Storage` that uses this deduplicator
   * and an in-memory journal entry store.
   */
  dedup?: Deduplicator;
  /** Optional logger. Defaults to {@link consoleLogger}. */
  log?: Logger;
  /** Optional metrics backend. Defaults to {@link inMemoryMetrics}. */
  metrics?: Metrics;
  /**
   * Optional OAuth configuration. When set, the receiver mounts
   * `/oauth/{qbo,xero}/{start,callback}` routes for the configured providers
   * and persists token sets via `storage.oauth`.
   */
  oauth?: OAuthServerConfig;
}

export interface ServerInstance {
  app: Express;
  storage: Storage;
  /** Deprecated alias for `storage.dedup`. Kept for callers that still read it. */
  dedup: Deduplicator;
  /** The metrics instance the receiver writes to. Exposed for advanced callers and tests. */
  metrics: Metrics;
}

/**
 * Build a `Storage` for the server. Resolution order:
 *
 *   1. Explicit `storage` (preferred).
 *   2. Legacy `dedup` — wrap it in an in-memory storage that delegates dedup
 *      to the caller's deduplicator and uses the in-memory journal entry store.
 *   3. Default to `inMemoryStorage()`.
 */
function resolveStorage(config: ServerConfig): Storage {
  if (config.storage) return config.storage;
  const base = inMemoryStorage();
  if (config.dedup) {
    const customDedup = config.dedup;
    return {
      dedup: customDedup,
      entries: base.entries,
      oauth: base.oauth,
      persistMapResult(eventId, result, now = Date.now()): void {
        for (const entry of result.entries) {
          base.entries.saveImmediate(entry, eventId);
        }
        if (result.schedule) {
          for (const entry of result.schedule.entries) {
            base.entries.saveScheduled(entry, result.schedule);
          }
        }
        customDedup.record(eventId, now);
      },
    };
  }
  return base;
}

/**
 * Tiny HTML page rendered after a successful OAuth callback. Intentionally
 * minimal — production deployments will want to customize this to match
 * their app's branding and to redirect somewhere useful.
 */
function renderConnectedPage(provider: OAuthProvider, tenantId: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${provider.toUpperCase()} connected</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.5rem}code{background:#f4f4f5;padding:0.1em 0.3em;border-radius:4px}</style>
</head><body>
<h1>${provider.toUpperCase()} connected</h1>
<p>ledgerly is now authorized against tenant <code>${tenantId}</code>. You can close this window.</p>
</body></html>`;
}

export function createServer(config: ServerConfig): ServerInstance {
  const storage = resolveStorage(config);
  const log: Logger = config.log ?? consoleLogger();
  const metrics: Metrics = config.metrics ?? inMemoryMetrics();
  const app = express();

  // OAuth wiring. `oauth.stateSecret` builds a state signer; per-provider
  // config controls whether the corresponding endpoints are mounted at all.
  // When a provider has no config, requests to its `/oauth/<provider>/*`
  // endpoints fall through to Express's default 404 handler.
  const oauthConfig = config.oauth;
  let stateSigner: StateSigner | null = null;
  if (oauthConfig) {
    stateSigner = createStateSigner(oauthConfig.stateSecret);
  }
  const oauthFetch = oauthConfig?.fetch ?? globalThis.fetch;

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      dedupSize: storage.dedup.size(),
      journalEntries: storage.entries.countImmediate(),
      pendingScheduled: storage.entries.countPendingScheduled(),
      failedScheduled: storage.entries.countFailedScheduled(),
    });
  });

  app.get('/metrics', (_req: Request, res: Response) => {
    // Refresh on-demand gauges from storage on every scrape so they reflect
    // the current state rather than the last time a counter happened to fire.
    metrics.setGauge('dedup_size', storage.dedup.size());
    metrics.setGauge('journal_entries', storage.entries.countImmediate());
    metrics.setGauge('scheduled_pending', storage.entries.countPendingScheduled());
    metrics.setGauge('scheduled_failed', storage.entries.countFailedScheduled());
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.status(200).send(metrics.render());
  });

  async function handleWebhook(req: Request, res: Response): Promise<void> {
    metrics.inc('webhook_received');
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string') {
      metrics.inc('webhook_signature_error');
      res.status(400).json({ error: 'Missing Stripe-Signature header' });
      return;
    }

    let event: Stripe.Event;
    try {
      event = config.stripe.webhooks.constructEvent(
        req.body as Buffer,
        sig,
        config.webhookSecret,
      );
    } catch (err) {
      metrics.inc('webhook_signature_error');
      log.error('Signature verification failed', { err });
      res.status(400).json({ error: 'Signature verification failed' });
      return;
    }

    // Cheap pre-check: if we've already processed this event, ack-and-skip
    // *before* spending an expansion call on it. The record happens later,
    // bundled with persistence, so a crash mid-flight doesn't poison the
    // dedup state.
    if (storage.dedup.has(event.id)) {
      metrics.inc('webhook_duplicate');
      log.info('Duplicate event ignored', { eventId: event.id });
      res.status(200).json({ duplicate: true });
      return;
    }

    let expanded: Stripe.Event;
    try {
      expanded = await expandEvent(config.stripe, event);
    } catch (err) {
      metrics.inc('webhook_expansion_error');
      log.error('Expansion failed', { eventId: event.id, err });
      res.status(500).json({ error: 'Expansion failed' });
      return;
    }

    try {
      const result = mapEvent(expanded);
      try {
        // Atomic per backend: persist all entries + record dedup, or roll back.
        storage.persistMapResult(event.id, result);
      } catch (err) {
        metrics.inc('webhook_error', { type: event.type });
        log.error('Persistence failed', { eventId: event.id, err });
        res.status(500).json({ error: 'Persistence failed' });
        return;
      }
      metrics.inc('webhook_processed', { type: event.type });
      log.info('Processed event', {
        eventId: event.id,
        eventType: event.type,
        entryCount: result.entries.length,
        scheduleEntryCount: result.schedule?.entries.length ?? 0,
      });
      res.status(200).json({
        ok: true,
        entries: result.entries.length,
        schedule: result.schedule !== null,
      });
    } catch (err) {
      if (err instanceof UnhandledEventError) {
        // Record the event as processed so we don't keep re-fetching it on
        // every Stripe redelivery — there's nothing to persist but we want
        // dedup to suppress repeats.
        try {
          storage.dedup.record(event.id);
        } catch (recordErr) {
          log.error('Dedup record failed for unhandled event', {
            eventId: event.id,
            err: recordErr,
          });
        }
        metrics.inc('webhook_unhandled', { type: event.type });
        log.info('Unhandled event type; acknowledging', {
          eventId: event.id,
          eventType: event.type,
        });
        res.status(200).json({ ok: true, unhandled: true });
        return;
      }
      metrics.inc('webhook_error', { type: event.type });
      log.error('mapEvent threw', { eventId: event.id, err });
      res.status(500).json({ error: 'Processing failed' });
    }
  }

  app.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    (req: Request, res: Response): void => {
      void handleWebhook(req, res);
    },
  );

  // ---- OAuth endpoints --------------------------------------------------
  //
  // Each provider gets two routes:
  //
  //   GET /oauth/<provider>/start    — generates a signed state token and
  //                                     302-redirects to the provider's
  //                                     consent screen.
  //   GET /oauth/<provider>/callback — verifies state, exchanges the code
  //                                     for tokens, persists them, and
  //                                     renders a tiny success page.
  //
  // Routes are only mounted when the corresponding `config.oauth.<provider>`
  // block is set. Otherwise the path falls through to Express's 404 handler.

  if (stateSigner !== null && oauthConfig?.qbo) {
    const signer = stateSigner;
    const qboClient = oauthConfig.qbo;

    app.get('/oauth/qbo/start', (_req: Request, res: Response): void => {
      const state = signer.sign({ provider: 'qbo' });
      const url = buildQboAuthUrl(qboClient, state);
      res.redirect(302, url);
    });

    app.get('/oauth/qbo/callback', (req: Request, res: Response): void => {
      void (async (): Promise<void> => {
        const params = req.query as Partial<QboCallbackParams>;
        const { code, state, realmId } = params;
        if (typeof code !== 'string' || code === '') {
          res.status(400).json({ error: 'Missing code parameter' });
          return;
        }
        if (typeof state !== 'string' || state === '') {
          res.status(400).json({ error: 'Missing state parameter' });
          return;
        }
        if (typeof realmId !== 'string' || realmId === '') {
          res.status(400).json({ error: 'Missing realmId parameter' });
          return;
        }
        try {
          const payload = signer.verify(state);
          if (payload.provider !== 'qbo') {
            res.status(400).json({ error: 'State payload provider mismatch' });
            return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('[oauth] QBO state verification failed', { err: msg });
          res.status(400).json({ error: 'Invalid or expired state' });
          return;
        }

        try {
          const tokens = await exchangeQboCode(qboClient, code, oauthFetch);
          storage.oauth.save({
            provider: 'qbo',
            tenantId: realmId,
            ...tokens,
          });
          log.info('[oauth] QBO tokens saved', { realmId });
          res
            .status(200)
            .setHeader('Content-Type', 'text/html; charset=utf-8')
            .send(renderConnectedPage('qbo', realmId));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('[oauth] QBO token exchange failed', { err: msg });
          if (err instanceof OAuthError) {
            res.status(502).json({ error: err.message });
            return;
          }
          res.status(500).json({ error: 'Token exchange failed' });
        }
      })();
    });
  }

  if (stateSigner !== null && oauthConfig?.xero) {
    const signer = stateSigner;
    const xeroClient = oauthConfig.xero;

    app.get('/oauth/xero/start', (_req: Request, res: Response): void => {
      const state = signer.sign({ provider: 'xero' });
      const url = buildXeroAuthUrl(xeroClient, state);
      res.redirect(302, url);
    });

    app.get('/oauth/xero/callback', (req: Request, res: Response): void => {
      void (async (): Promise<void> => {
        const codeRaw = req.query['code'];
        const stateRaw = req.query['state'];
        if (typeof codeRaw !== 'string' || codeRaw === '') {
          res.status(400).json({ error: 'Missing code parameter' });
          return;
        }
        if (typeof stateRaw !== 'string' || stateRaw === '') {
          res.status(400).json({ error: 'Missing state parameter' });
          return;
        }
        try {
          const payload = signer.verify(stateRaw);
          if (payload.provider !== 'xero') {
            res.status(400).json({ error: 'State payload provider mismatch' });
            return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn('[oauth] Xero state verification failed', { err: msg });
          res.status(400).json({ error: 'Invalid or expired state' });
          return;
        }

        try {
          const tokens = await exchangeXeroCode(xeroClient, codeRaw, oauthFetch);
          const connections = await getXeroConnections(tokens.accessToken, oauthFetch);
          if (connections.length === 0) {
            res.status(502).json({ error: 'Xero returned no connections' });
            return;
          }
          if (connections.length > 1) {
            log.warn('[oauth] Xero returned multiple connections; using first', {
              count: connections.length,
              tenantIds: connections.map((c) => c.tenantId),
            });
          }
          const primary = connections[0];
          if (!primary) {
            res.status(502).json({ error: 'Xero returned no connections' });
            return;
          }
          storage.oauth.save({
            provider: 'xero',
            tenantId: primary.tenantId,
            ...tokens,
          });
          log.info('[oauth] Xero tokens saved', {
            tenantId: primary.tenantId,
            tenantName: primary.tenantName,
          });
          res
            .status(200)
            .setHeader('Content-Type', 'text/html; charset=utf-8')
            .send(renderConnectedPage('xero', primary.tenantId));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.error('[oauth] Xero token exchange failed', { err: msg });
          if (err instanceof OAuthError) {
            res.status(502).json({ error: err.message });
            return;
          }
          res.status(500).json({ error: 'Token exchange failed' });
        }
      })();
    });
  }

  return { app, storage, dedup: storage.dedup, metrics };
}
