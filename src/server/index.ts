import express, { type Express, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { mapEvent } from '../engine.js';
import { UnhandledEventError } from '../errors.js';
import { expandEvent } from './expand.js';
import { consoleLogger } from './logger.js';
import type { Logger } from './logger.js';
import { inMemoryMetrics } from './metrics.js';
import type { Metrics } from './metrics.js';
import { inMemoryStorage } from './storage/inMemory.js';
import type { Deduplicator, Storage } from './storage/types.js';

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

export function createServer(config: ServerConfig): ServerInstance {
  const storage = resolveStorage(config);
  const log: Logger = config.log ?? consoleLogger();
  const metrics: Metrics = config.metrics ?? inMemoryMetrics();
  const app = express();

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

  return { app, storage, dedup: storage.dedup, metrics };
}
