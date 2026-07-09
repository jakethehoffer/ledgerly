import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from '../src/engine.js';
import { formatMapResult, formatQbo, formatXero, mapEventJson, mapEventsJson } from '../src/cli.js';

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
