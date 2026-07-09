import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from '../src/engine.js';
import { formatMapResult, mapEventJson } from '../src/cli.js';

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
