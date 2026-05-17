import express, { type Express, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { mapEvent } from '../engine.js';
import { UnhandledEventError } from '../errors.js';
import { expandEvent } from './expand.js';
import { inMemoryStorage } from './storage/inMemory.js';
import type { Deduplicator, Storage } from './storage/types.js';

export interface ServerLogger {
  info: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
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
  /** Optional logger. Defaults to console. */
  log?: ServerLogger;
}

export interface ServerInstance {
  app: Express;
  storage: Storage;
  /** Deprecated alias for `storage.dedup`. Kept for callers that still read it. */
  dedup: Deduplicator;
}

const defaultLogger: ServerLogger = {
  info: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.log(msg, meta ?? '');
  },
  error: (msg, meta) => {
    // eslint-disable-next-line no-console
    console.error(msg, meta ?? '');
  },
};

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
  const log = config.log ?? defaultLogger;
  const app = express();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      dedupSize: storage.dedup.size(),
      journalEntries: storage.entries.countImmediate(),
      pendingScheduled: storage.entries.countPendingScheduled(),
    });
  });

  async function handleWebhook(req: Request, res: Response): Promise<void> {
    const sig = req.headers['stripe-signature'];
    if (typeof sig !== 'string') {
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
      log.error('Signature verification failed', err);
      res.status(400).json({ error: 'Signature verification failed' });
      return;
    }

    // Cheap pre-check: if we've already processed this event, ack-and-skip
    // *before* spending an expansion call on it. The record happens later,
    // bundled with persistence, so a crash mid-flight doesn't poison the
    // dedup state.
    if (storage.dedup.has(event.id)) {
      log.info(`Duplicate event ${event.id} ignored`);
      res.status(200).json({ duplicate: true });
      return;
    }

    let expanded: Stripe.Event;
    try {
      expanded = await expandEvent(config.stripe, event);
    } catch (err) {
      log.error(`Expansion failed for ${event.id}`, err);
      res.status(500).json({ error: 'Expansion failed' });
      return;
    }

    try {
      const result = mapEvent(expanded);
      try {
        // Atomic per backend: persist all entries + record dedup, or roll back.
        storage.persistMapResult(event.id, result);
      } catch (err) {
        log.error(`Persistence failed for ${event.id}`, err);
        res.status(500).json({ error: 'Persistence failed' });
        return;
      }
      log.info(`Processed ${event.id} (${event.type})`, {
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
          log.error(`Dedup record failed for unhandled ${event.id}`, recordErr);
        }
        log.info(`Unhandled event type ${event.type}; acknowledging`);
        res.status(200).json({ ok: true, unhandled: true });
        return;
      }
      log.error(`mapEvent threw for ${event.id}`, err);
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

  return { app, storage, dedup: storage.dedup };
}
