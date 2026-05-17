import express, { type Express, type Request, type Response } from 'express';
import type Stripe from 'stripe';
import { mapEvent } from '../engine.js';
import { UnhandledEventError } from '../errors.js';
import { expandEvent } from './expand.js';
import { inMemoryDedup, type Deduplicator } from './dedup.js';

export interface ServerLogger {
  info: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

export interface ServerConfig {
  /** The Stripe SDK instance for signature verification and API expansion. */
  stripe: Stripe;
  /** The webhook signing secret from the Stripe dashboard. */
  webhookSecret: string;
  /** Optional deduplicator. Defaults to in-memory with 7-day TTL. */
  dedup?: Deduplicator;
  /** Optional logger. Defaults to console. */
  log?: ServerLogger;
}

export interface ServerInstance {
  app: Express;
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

export function createServer(config: ServerConfig): ServerInstance {
  const dedup = config.dedup ?? inMemoryDedup();
  const log = config.log ?? defaultLogger;
  const app = express();

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, dedupSize: dedup.size() });
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

    if (dedup.checkAndRecord(event.id)) {
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

  return { app, dedup };
}
