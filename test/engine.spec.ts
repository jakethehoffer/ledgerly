import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from '../src/engine.js';
import { MissingExpansionError, UnhandledEventError } from '../src/errors.js';
import { checkBalance } from '../src/journal.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8'));
}

function fixtureNames(): string[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.event.json'))
    .map((f) => f.replace('.event.json', ''))
    .sort();
}

describe('mapEvent unknown event', () => {
  it('throws UnhandledEventError for unknown event types', () => {
    const event = {
      id: 'evt_unknown_001',
      type: 'foo.bar.baz',
      data: { object: {} },
    } as unknown as Stripe.Event;

    expect(() => mapEvent(event)).toThrow(UnhandledEventError);
    expect(() => mapEvent(event)).toThrow(/foo\.bar\.baz/);
    expect(() => mapEvent(event)).toThrow(/evt_unknown_001/);
  });
});

describe('invoice.payment_succeeded charge presence', () => {
  // A credit-balance / out-of-band-paid invoice (charge === null, amount_paid > 0)
  // is acknowledged with no entry — see the paid_from_credit_balance fixture.
  // But a charge present as an UNEXPANDED string id is a caller error (they
  // forgot to expand it): that must still throw, not silently no-op, or the
  // engine would drop a real cash-bearing invoice.
  it('throws MissingExpansionError when charge is an unexpanded string id', () => {
    const event = {
      id: 'evt_invoice_unexpanded_charge_001',
      type: 'invoice.payment_succeeded',
      created: 1736942400,
      data: {
        object: {
          id: 'in_unexpanded_001',
          object: 'invoice',
          amount_paid: 5000,
          currency: 'usd',
          charge: 'ch_unexpanded_001',
          lines: {
            object: 'list',
            data: [
              {
                amount: 5000,
                currency: 'usd',
                period: { start: 1736942400, end: 1739620800 },
              },
            ],
            has_more: false,
          },
        },
      },
    } as unknown as Stripe.Event;

    expect(() => mapEvent(event)).toThrow(MissingExpansionError);
  });
});

describe('mapEvent fixture-driven', () => {
  for (const name of fixtureNames()) {
    it(`maps ${name} to the expected MapResult`, () => {
      const event = loadJson(`${name}.event.json`) as Stripe.Event;
      const expected = loadJson(`${name}.expected.json`);
      const result = mapEvent(event);
      expect(result).toEqual(expected);
    });

    it(`${name}: every entry is balanced`, () => {
      const event = loadJson(`${name}.event.json`) as Stripe.Event;
      const result = mapEvent(event);
      for (const entry of result.entries) {
        expect(checkBalance(entry).balanced).toBe(true);
      }
      if (result.schedule) {
        for (const entry of result.schedule.entries) {
          expect(checkBalance(entry).balanced).toBe(true);
        }
      }
    });

    it(`${name}: every entry satisfies spec invariants`, () => {
      const event = loadJson(`${name}.event.json`) as Stripe.Event;
      const result = mapEvent(event);
      const allEntries = [
        ...result.entries,
        ...(result.schedule ? result.schedule.entries : []),
      ];
      for (const entry of allEntries) {
        expect(entry.memo.length).toBeGreaterThan(0);
        expect(entry.sourceEventId.startsWith('evt_')).toBe(true);
      }
    });
  }
});
