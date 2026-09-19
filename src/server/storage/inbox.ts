import type Database from 'better-sqlite3';
import type Stripe from 'stripe';

export interface StoredWebhook {
  readonly event: Stripe.Event;
  readonly receivedAt: number;
  readonly status: 'pending' | 'failed';
  readonly lastError: string | null;
}

export interface WebhookInbox {
  receive(event: Stripe.Event): void;
  get(eventId: string): StoredWebhook | null;
  list(limit?: number): StoredWebhook[];
  count(): number;
  fail(eventId: string, error: string): void;
  remove(eventId: string): void;
}

function boundedLimit(limit = 50): number {
  return Number.isFinite(limit) ? Math.max(0, Math.min(500, Math.floor(limit))) : 50;
}

export function inMemoryWebhookInbox(): WebhookInbox {
  const events = new Map<string, StoredWebhook>();
  return {
    receive(event): void {
      if (!events.has(event.id)) {
        events.set(event.id, {
          event: structuredClone(event),
          receivedAt: Date.now(),
          status: 'pending',
          lastError: null,
        });
      }
    },
    get(eventId): StoredWebhook | null {
      const stored = events.get(eventId);
      return stored ? structuredClone(stored) : null;
    },
    list(limit): StoredWebhook[] {
      return structuredClone([...events.values()].reverse().slice(0, boundedLimit(limit)));
    },
    count(): number {
      return events.size;
    },
    fail(eventId, error): void {
      const stored = events.get(eventId);
      if (stored)
        events.set(eventId, { ...stored, status: 'failed', lastError: error.slice(0, 1000) });
    },
    remove(eventId): void {
      events.delete(eventId);
    },
  };
}

interface InboxRow {
  payload: string;
  received_at: number;
  status: 'pending' | 'failed';
  last_error: string | null;
}

export function sqliteWebhookInbox(database: Database.Database): WebhookInbox {
  const receive = database.prepare<[string, number, string]>(
    'INSERT OR IGNORE INTO webhook_inbox (event_id, received_at, payload) VALUES (?, ?, ?)',
  );
  const get = database.prepare<[string], InboxRow>(
    'SELECT payload, received_at, status, last_error FROM webhook_inbox WHERE event_id = ?',
  );
  const list = database.prepare<[number], InboxRow>(
    'SELECT payload, received_at, status, last_error FROM webhook_inbox ORDER BY received_at DESC, event_id DESC LIMIT ?',
  );
  const count = database.prepare<[], { count: number }>(
    'SELECT COUNT(*) AS count FROM webhook_inbox',
  );
  const fail = database.prepare<[string, string]>(
    "UPDATE webhook_inbox SET status = 'failed', last_error = ? WHERE event_id = ?",
  );
  const remove = database.prepare<[string]>('DELETE FROM webhook_inbox WHERE event_id = ?');
  function decode(row: InboxRow): StoredWebhook {
    return {
      event: JSON.parse(row.payload) as Stripe.Event,
      receivedAt: row.received_at,
      status: row.status,
      lastError: row.last_error,
    };
  }
  return {
    receive(event): void {
      receive.run(event.id, Date.now(), JSON.stringify(event));
    },
    get(eventId): StoredWebhook | null {
      const row = get.get(eventId);
      return row ? decode(row) : null;
    },
    list(limit): StoredWebhook[] {
      return list.all(boundedLimit(limit)).map(decode);
    },
    count(): number {
      return count.get()?.count ?? 0;
    },
    fail(eventId, error): void {
      fail.run(error.slice(0, 1000), eventId);
    },
    remove(eventId): void {
      remove.run(eventId);
    },
  };
}
