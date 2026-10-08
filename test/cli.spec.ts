import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from '../src/engine.js';
import {
  createPreviewClient,
  formatMapResult,
  formatQbo,
  formatXero,
  mapEventJson,
  mapEventsBatch,
  mapEventsJson,
  parseArgs,
} from '../src/cli.js';
import { UnhandledEventError } from '../src/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function rawFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.event.json`), 'utf8');
}

describe('cli: formatMapResult', () => {
  it('renders a charge as a readable, balanced table', () => {
    const out = formatMapResult(mapEvent(JSON.parse(rawFixture('charge_succeeded_standard')) as Stripe.Event));
    expect(out).toContain('1010 Stripe Clearing');
    expect(out).toContain('6000 Stripe Processing Fees');
    expect(out).toContain('4000 Subscription Revenue');
    expect(out).toContain('$96.80');
    expect(out).toContain('$100.00');
    expect(out).toMatch(/balanced: debits \$100\.00 == credits \$100\.00/);
  });

  it('summarizes the recognition schedule for a deferred annual invoice', () => {
    const out = formatMapResult(mapEvent(JSON.parse(rawFixture('invoice_payment_succeeded_annual')) as Stripe.Event));
    expect(out).toMatch(/RECOGNITION SCHEDULE/i);
    expect(out).toContain('12 future entries');
    expect(out).toContain('total recognized');
  });

  it('labels amounts with the currency code when the books are not in US dollars', () => {
    const result = mapEvent(JSON.parse(rawFixture('charge_succeeded_eur')) as Stripe.Event);
    const currency = result.entries[0]?.currency ?? '';
    expect(currency).not.toBe('USD');
    const out = formatMapResult(result);
    expect(out).toContain(` ${currency}`);
    expect(out).not.toContain('$');
  });

  it('states plainly when an event has no accounting impact', () => {
    const noop: Stripe.Event = {
      id: 'evt_noop',
      type: 'invoice.payment_failed',
      created: 1736942400,
      data: { object: {} },
    } as unknown as Stripe.Event;
    const out = formatMapResult(mapEvent(noop));
    expect(out).toMatch(/no journal entry/i);
  });
});

describe('cli: exporter flags', () => {
  it('--qbo renders QuickBooks JournalEntry JSON (placeholder account ids)', () => {
    const result = mapEvent(JSON.parse(rawFixture('charge_succeeded_standard')) as Stripe.Event);
    const parsed: unknown = JSON.parse(formatQbo(result));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(JSON.stringify(parsed)).toContain('JournalEntryLineDetail');
  });

  it('--xero renders Xero ManualJournal JSON (placeholder account codes)', () => {
    const result = mapEvent(JSON.parse(rawFixture('charge_succeeded_standard')) as Stripe.Event);
    const parsed: unknown = JSON.parse(formatXero(result));
    expect(Array.isArray(parsed)).toBe(true);
    expect(JSON.stringify(parsed)).toContain('JournalLines');
  });

  it('renders empty array JSON for an event with no accounting impact', () => {
    const noop: Stripe.Event = {
      id: 'evt_noop',
      type: 'invoice.payment_failed',
      created: 1736942400,
      data: { object: {} },
    } as unknown as Stripe.Event;
    expect(formatQbo(mapEvent(noop))).toBe('[]');
    expect(formatXero(mapEvent(noop))).toBe('[]');
  });
});

describe('cli: mapEventJson', () => {
  it('parses a raw event JSON string and maps it', () => {
    const result = mapEventJson(rawFixture('charge_succeeded_standard'));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.lines.some((l) => l.accountCode === '1010')).toBe(true);
  });

  it('throws a clear error on invalid JSON', () => {
    expect(() => mapEventJson('{ not valid json')).toThrow(/not valid JSON/i);
  });
});

describe('cli: mapEventsJson (batch)', () => {
  it('maps a single event object to a one-element array', () => {
    const results = mapEventsJson(rawFixture('charge_succeeded_standard'));
    expect(results).toHaveLength(1);
    expect(results[0]?.entries).toHaveLength(1);
  });

  it('maps a bare JSON array of events', () => {
    const one = JSON.parse(rawFixture('charge_succeeded_standard')) as unknown;
    const two = JSON.parse(rawFixture('invoice_payment_succeeded_annual')) as unknown;
    const results = mapEventsJson(JSON.stringify([one, two]));
    expect(results).toHaveLength(2);
    expect(results[1]?.schedule?.entries).toHaveLength(12); // annual builds a schedule
  });

  it('maps a Stripe list response shape ({ data: [...] })', () => {
    const one = JSON.parse(rawFixture('charge_succeeded_standard')) as unknown;
    const results = mapEventsJson(JSON.stringify({ object: 'list', data: [one, one] }));
    expect(results).toHaveLength(2);
  });

  it('throws a clear error on invalid JSON', () => {
    expect(() => mapEventsJson('not json')).toThrow(/not valid JSON/i);
  });
});

describe('cli: mapEventsBatch (raw exports)', () => {
  const customerCreated = { id: 'evt_cus', type: 'customer.created', created: 1736942400, data: { object: {} } };

  it('skips event types Ledgerly does not map in a batch and counts them', () => {
    const charge = JSON.parse(rawFixture('charge_succeeded_standard')) as unknown;
    const { results, skipped } = mapEventsBatch(
      JSON.stringify({ object: 'list', data: [customerCreated, charge, customerCreated] }),
    );
    expect(results).toHaveLength(1);
    expect(skipped).toEqual({ 'customer.created': 2 });
  });

  it('still reports an unmapped type when it is the only event', () => {
    expect(() => mapEventsBatch(JSON.stringify(customerCreated))).toThrow(UnhandledEventError);
  });
});

describe('cli: parseArgs', () => {
  it('reads --stripe with a day count and no file', () => {
    expect(parseArgs(['--stripe', '--days', '7'])).toMatchObject({ stripe: true, days: 7, file: undefined });
  });

  it('defaults --stripe to 30 days', () => {
    expect(parseArgs(['--stripe'])).toMatchObject({ stripe: true, days: 30 });
  });

  it('accepts --days=N', () => {
    expect(parseArgs(['--stripe', '--days=14'])).toMatchObject({ days: 14 });
  });

  it('keeps reading a file argument and output flags', () => {
    expect(parseArgs(['events.json', '--qbo'])).toMatchObject({ file: 'events.json', qbo: true, stripe: false });
  });

  it('rejects --days without --stripe', () => {
    expect(parseArgs(['--days', '7']).error).toMatch(/--days only works with --stripe/);
  });

  it('rejects a day count Stripe cannot supply', () => {
    expect(parseArgs(['--stripe', '--days', 'abc']).error).toMatch(/between 1 and 30/);
    expect(parseArgs(['--stripe', '--days', '31']).error).toMatch(/between 1 and 30/);
    expect(parseArgs(['--stripe', '--days']).error).toMatch(/between 1 and 30/);
  });

  it('rejects a file together with --stripe', () => {
    expect(parseArgs(['--stripe', 'events.json']).error).toMatch(/--stripe reads from Stripe/);
  });
});

describe('cli: createPreviewClient', () => {
  class FakeStripe {
    constructor(public readonly key: string) {}
  }
  const importFake = (): Promise<{ default: unknown }> => Promise.resolve({ default: FakeStripe as unknown });

  it('explains how to supply a key when none is set', async () => {
    const out = await createPreviewClient({}, importFake);
    expect(out.error).toMatch(/STRIPE_SECRET_KEY/);
    expect(out.error).toMatch(/restricted key/i);
  });

  it('explains how to add the Stripe package when it is missing', async () => {
    const out = await createPreviewClient({ STRIPE_SECRET_KEY: 'rk_test_x' }, () =>
      Promise.reject(Object.assign(new Error("Cannot find package 'stripe'"), { code: 'ERR_MODULE_NOT_FOUND' })),
    );
    expect(out.error).toMatch(/npx -p ledgerly -p stripe@16 ledgerly --stripe/);
  });

  it('builds a client from the key in the environment', async () => {
    const out = await createPreviewClient({ STRIPE_SECRET_KEY: 'rk_test_x' }, importFake);
    expect(out.error).toBeUndefined();
    expect((out.stripe as unknown as FakeStripe).key).toBe('rk_test_x');
  });
});
