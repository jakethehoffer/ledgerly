import express, { type Express, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { mapEvent } from '../engine.js';
import { UnhandledEventError } from '../errors.js';
import { voidHasDeferredSchedule } from '../events/invoices/invoiceVoided.js';
import { adminAuthMiddleware } from './admin.js';
import { expandEvent } from './expand.js';
import { buildVoidReconcileInput } from './voidReconciler.js';
import {
  buildCreditReconcileInput,
  buildCreditVoidReconcileInput,
  creditNoteNeedsReconcile,
  creditNoteVoidNeedsReconcile,
} from './creditReconciler.js';
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
import type { Deduplicator, PersistResult, Storage } from './storage/types.js';

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
  /**
   * Optional admin bearer token. When set, the receiver mounts the
   * operational `/admin/*` endpoints (list entries, retry dead-lettered
   * dispatches) gated by this token. When unset, those routes are not
   * mounted at all and requests fall through to Express's 404 handler —
   * making the admin surface invisible to unauthenticated callers.
   *
   * The CLI enforces a minimum length of 32 characters at startup; the
   * library itself does not, so test fixtures can pass shorter tokens.
   */
  adminToken?: string;
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
      ping(): void {
        base.ping();
      },
      persistMapResult(eventId, result, now = Date.now()): PersistResult {
        // Same idempotency boundary as the first-class backends: a duplicate
        // that raced past the receiver's has() pre-check writes nothing. No
        // `await` between has() and record(), so this is atomic under JS
        // single-threaded semantics; record() stays last so a mid-write throw
        // doesn't mark the event processed.
        if (customDedup.has(eventId)) return { duplicate: true };
        for (const entry of result.entries) {
          base.entries.saveImmediate(entry, eventId);
        }
        if (result.schedule) {
          for (const entry of result.schedule.entries) {
            base.entries.saveScheduled(entry, result.schedule);
          }
        }
        customDedup.record(eventId, now);
        return { duplicate: false };
      },
      persistVoidReversal(eventId, input, now = Date.now()): PersistResult {
        // Mirrors the first-class backends' void reconciliation, but claims the
        // event against the caller's deduplicator. Read the invoice's
        // recognition rows, cancel the unposted ones, and post the reversal
        // built from the posted ones — atomic under JS single-threaded
        // semantics (no await between has() and record()).
        if (customDedup.has(eventId)) return { duplicate: true };
        const rows = base.entries
          .findScheduledBySubscription(input.subscriptionId)
          .filter((row) => row.entry.sourceObjectId === input.invoiceId);
        const posted = rows
          .filter((row) => row.status === 'posted')
          .map((row) => row.entry);
        for (const row of rows) {
          if (row.status === 'pending' || row.status === 'failed') {
            base.entries.cancelScheduled(row.id);
          }
        }
        const reversal = input.buildReversal(posted);
        base.entries.saveImmediate(reversal, eventId);
        base.entries.saveScheduled(reversal, {
          subscriptionId: `immediate:${reversal.sourceEventId}`,
          sourceEventId: reversal.sourceEventId,
        });
        customDedup.record(eventId, now);
        return { duplicate: false };
      },
      persistCreditReversal(eventId, input, now = Date.now()): PersistResult {
        // Mirrors the first-class backends' credit draw-down against the caller's
        // deduplicator: read the invoice's recognition rows, build the reversal +
        // re-spread schedule from the posted/pending split, cancel the old pending
        // rows, then post the reversal and enqueue the reduced schedule.
        if (customDedup.has(eventId)) return { duplicate: true };
        const rows = base.entries
          .findScheduledBySubscription(input.subscriptionId)
          .filter((row) => row.entry.sourceObjectId === input.invoiceId);
        const posted = rows
          .filter((row) => row.status === 'posted')
          .map((row) => row.entry);
        const pending = rows
          .filter((row) => row.status === 'pending' || row.status === 'failed')
          .map((row) => row.entry);
        const { reversal, reducedSchedule } = input.build(posted, pending);
        for (const row of rows) {
          if (row.status === 'pending' || row.status === 'failed') {
            base.entries.cancelScheduled(row.id);
          }
        }
        base.entries.saveImmediate(reversal, eventId);
        base.entries.saveScheduled(reversal, {
          subscriptionId: `immediate:${reversal.sourceEventId}`,
          sourceEventId: reversal.sourceEventId,
        });
        if (reducedSchedule) {
          for (const entry of reducedSchedule.entries) {
            base.entries.saveScheduled(entry, reducedSchedule);
          }
        }
        customDedup.record(eventId, now);
        return { duplicate: false };
      },
      persistCreditVoidReversal(eventId, input, now = Date.now()): PersistResult {
        // Mirrors the first-class backends' credit-void reconciliation against the
        // caller's deduplicator: invert the draw-down entry and re-inflate the
        // schedule, or no-op if the credit note was never booked as a draw-down.
        if (customDedup.has(eventId)) return { duplicate: true };
        const drawDown = base.entries
          .findImmediateBySourceObject(input.creditNoteId)
          .map((row) => row.entry);
        const rows = base.entries
          .findScheduledBySubscription(input.subscriptionId)
          .filter((row) => row.entry.sourceObjectId === input.invoiceId);
        const pending = rows
          .filter((row) => row.status === 'pending' || row.status === 'failed')
          .map((row) => row.entry);
        const result = input.build(drawDown, pending);
        if (result === null) {
          customDedup.record(eventId, now);
          return { duplicate: false };
        }
        for (const row of rows) {
          if (row.status === 'pending' || row.status === 'failed') {
            base.entries.cancelScheduled(row.id);
          }
        }
        base.entries.saveImmediate(result.reversal, eventId);
        base.entries.saveScheduled(result.reversal, {
          subscriptionId: `immediate:${result.reversal.sourceEventId}`,
          sourceEventId: result.reversal.sourceEventId,
        });
        if (result.reissuedSchedule) {
          for (const entry of result.reissuedSchedule.entries) {
            base.entries.saveScheduled(entry, result.reissuedSchedule);
          }
        }
        customDedup.record(eventId, now);
        return { duplicate: false };
      },
    };
  }
  return base;
}

/**
 * Escape the five characters that matter for HTML text/attribute contexts so a
 * value interpolated into {@link renderConnectedPage} can't inject markup.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Tiny HTML page rendered after a successful OAuth callback. Intentionally
 * minimal — production deployments will want to customize this to match
 * their app's branding and to redirect somewhere useful.
 *
 * `tenantId` is escaped: for QBO it is the `realmId` query parameter, which is
 * attacker-controllable on the callback URL, so reflecting it verbatim into the
 * page would be a reflected-XSS vector. `provider` comes from a fixed union and
 * needs no escaping.
 */
function renderConnectedPage(provider: OAuthProvider, tenantId: string): string {
  const safeTenant = escapeHtml(tenantId);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${provider.toUpperCase()} connected</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.5rem}code{background:#f4f4f5;padding:0.1em 0.3em;border-radius:4px}</style>
</head><body>
<h1>${provider.toUpperCase()} connected</h1>
<p>ledgerly is now authorized against tenant <code>${safeTenant}</code>. You can close this window.</p>
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

  // Readiness probe distinct from /health: returns 503 (not 200) when the
  // storage backend is unreachable. K8s rolling deploys point `readinessProbe`
  // here so a transient DB hiccup pulls the pod out of the load balancer
  // without triggering a `livenessProbe` restart. The body lists per-check
  // status so a human can diagnose at a glance.
  app.get('/readyz', (_req: Request, res: Response) => {
    try {
      storage.ping();
      res.status(200).json({ ready: true, checks: { storage: 'ok' } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('Readiness check failed', { err: msg });
      res.status(503).json({ ready: false, checks: { storage: msg } });
    }
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
      let persistResult: PersistResult;
      let entryCount: number;
      let scheduleEntryCount: number;
      let hasSchedule: boolean;

      if (
        expanded.type === 'invoice.voided' &&
        voidHasDeferredSchedule(expanded.data.object)
      ) {
        // A voided net-terms invoice carrying a deferred-revenue schedule can't
        // be reversed by the stateless engine (mapEvent would throw): the
        // reversal depends on how much has already recognized and the unposted
        // schedule must be cancelled. Reconcile against the ledger instead —
        // read + cancel + post happen atomically inside persistVoidReversal.
        try {
          persistResult = storage.persistVoidReversal(
            event.id,
            buildVoidReconcileInput(expanded),
          );
        } catch (err) {
          metrics.inc('webhook_error', { type: event.type });
          log.error('Void reconciliation failed', { eventId: event.id, err });
          res.status(500).json({ error: 'Void reconciliation failed' });
          return;
        }
        entryCount = 1;
        scheduleEntryCount = 0;
        hasSchedule = false;
      } else if (
        expanded.type === 'credit_note.created' &&
        creditNoteNeedsReconcile(expanded)
      ) {
        // A credit note against a deferred-schedule invoice can't be booked by the
        // stateless engine (mapEvent would throw): the reversal depends on how much
        // has recognized, and the remaining schedule must be re-spread. Reconcile
        // against the ledger instead — read + cancel + post + reissue happen
        // atomically inside persistCreditReversal.
        try {
          persistResult = storage.persistCreditReversal(
            event.id,
            buildCreditReconcileInput(expanded),
          );
        } catch (err) {
          metrics.inc('webhook_error', { type: event.type });
          log.error('Credit reconciliation failed', { eventId: event.id, err });
          res.status(500).json({ error: 'Credit reconciliation failed' });
          return;
        }
        entryCount = 1;
        scheduleEntryCount = 0;
        hasSchedule = false;
      } else if (
        expanded.type === 'credit_note.voided' &&
        creditNoteVoidNeedsReconcile(expanded)
      ) {
        // Voiding a credit note that was booked as a deferred draw-down can't be
        // un-booked by the stateless engine (mapEvent would throw): it must invert
        // the draw-down entry and re-inflate the schedule. Reconcile against the
        // ledger — the read + inverse + reissue happen atomically inside
        // persistCreditVoidReversal (a no-op if this credit note was never booked).
        try {
          persistResult = storage.persistCreditVoidReversal(
            event.id,
            buildCreditVoidReconcileInput(expanded),
          );
        } catch (err) {
          metrics.inc('webhook_error', { type: event.type });
          log.error('Credit-void reconciliation failed', { eventId: event.id, err });
          res.status(500).json({ error: 'Credit-void reconciliation failed' });
          return;
        }
        entryCount = 1;
        scheduleEntryCount = 0;
        hasSchedule = false;
      } else {
        const result = mapEvent(expanded);
        try {
          // Atomic + idempotent per backend: persist all entries + record dedup,
          // or roll back. The persistence layer — not the has() pre-check above —
          // is the correctness boundary: if a concurrent delivery already claimed
          // this event during the await-expansion gap, this returns
          // { duplicate: true } and writes nothing, so entries post exactly once.
          persistResult = storage.persistMapResult(event.id, result);
        } catch (err) {
          metrics.inc('webhook_error', { type: event.type });
          log.error('Persistence failed', { eventId: event.id, err });
          res.status(500).json({ error: 'Persistence failed' });
          return;
        }
        entryCount = result.entries.length;
        scheduleEntryCount = result.schedule?.entries.length ?? 0;
        hasSchedule = result.schedule !== null;
      }

      if (persistResult.duplicate) {
        metrics.inc('webhook_duplicate');
        log.info('Duplicate event ignored at persistence (raced past pre-check)', {
          eventId: event.id,
        });
        res.status(200).json({ duplicate: true });
        return;
      }
      metrics.inc('webhook_processed', { type: event.type });
      log.info('Processed event', {
        eventId: event.id,
        eventType: event.type,
        entryCount,
        scheduleEntryCount,
      });
      res.status(200).json({
        ok: true,
        entries: entryCount,
        schedule: hasSchedule,
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

  // ---- Admin endpoints --------------------------------------------------
  //
  // Operator-facing read endpoints + a manual retry hook for dead-lettered
  // scheduled entries. Mounted only when `config.adminToken` is set. When
  // unset, the routes don't exist — Express falls through to 404 — so an
  // unauthenticated scanner can't even tell the admin surface is there.
  //
  //   GET  /admin/entries?limit=N
  //   GET  /admin/scheduled?status=X&limit=N
  //   GET  /admin/scheduled/:id
  //   POST /admin/scheduled/:id/retry
  //
  // The auth middleware uses constant-time bearer comparison.
  const adminToken = config.adminToken;
  if (adminToken !== undefined && adminToken !== '') {
    log.info('Admin endpoints enabled');
    const requireAdmin = adminAuthMiddleware(adminToken);
    const VALID_STATUSES: ReadonlyArray<'pending' | 'posted' | 'cancelled' | 'failed'> = [
      'pending',
      'posted',
      'cancelled',
      'failed',
    ];

    const parseLimit = (req: Request): number | { error: string } => {
      const raw = req.query['limit'];
      if (raw === undefined) return 50;
      if (typeof raw !== 'string') return { error: 'limit must be a string' };
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0 || String(n) !== raw) {
        return { error: 'limit must be a non-negative integer' };
      }
      return n;
    };

    app.get('/admin/entries', requireAdmin, (req: Request, res: Response): void => {
      const limit = parseLimit(req);
      if (typeof limit !== 'number') {
        res.status(400).json(limit);
        return;
      }
      const entries = storage.entries.listRecentImmediate(limit);
      res.json({ entries });
    });

    app.get('/admin/scheduled', requireAdmin, (req: Request, res: Response): void => {
      const statusRaw = req.query['status'];
      const status: 'pending' | 'posted' | 'cancelled' | 'failed' =
        statusRaw === undefined ? 'pending' : (statusRaw as 'pending');
      if (!VALID_STATUSES.includes(status)) {
        res.status(400).json({
          error: `invalid status; expected one of: ${VALID_STATUSES.join(', ')}`,
        });
        return;
      }
      const limit = parseLimit(req);
      if (typeof limit !== 'number') {
        res.status(400).json(limit);
        return;
      }
      const entries = storage.entries.listScheduledByStatus(status, limit);
      res.json({ entries });
    });

    app.get('/admin/scheduled/:id', requireAdmin, (req: Request, res: Response): void => {
      const idRaw = req.params['id'] ?? '';
      const id = Number.parseInt(idRaw, 10);
      if (!Number.isFinite(id) || id < 0 || String(id) !== idRaw) {
        res.status(400).json({ error: 'id must be a non-negative integer' });
        return;
      }
      const entry = storage.entries.getScheduledById(id);
      if (entry === null) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json({ entry });
    });

    app.post(
      '/admin/scheduled/:id/retry',
      requireAdmin,
      (req: Request, res: Response): void => {
        const idRaw = req.params['id'] ?? '';
        const id = Number.parseInt(idRaw, 10);
        if (!Number.isFinite(id) || id < 0 || String(id) !== idRaw) {
          res.status(400).json({ error: 'id must be a non-negative integer' });
          return;
        }
        try {
          const entry = storage.entries.requeueScheduled(id);
          log.info('Admin requeued scheduled entry', { id });
          res.json({ entry });
        } catch {
          res.status(404).json({ error: 'not found' });
        }
      },
    );
  } else {
    log.info('Admin endpoints disabled (no adminToken configured)');
  }

  return { app, storage, dedup: storage.dedup, metrics };
}
