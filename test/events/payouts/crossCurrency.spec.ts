import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import { mapEvent } from '../../../src/engine.js';
import {
  detectCrossCurrencyPayout,
  rejectCrossCurrencyPayout,
} from '../../../src/events/payouts/crossCurrency.js';

function makePayout(overrides: Partial<Stripe.Payout> = {}): Stripe.Payout {
  return {
    id: 'po_test',
    object: 'payout',
    amount: 10000,
    arrival_date: 1700000000,
    currency: 'cad',
    destination: 'ba_test',
    status: 'paid',
    ...overrides,
  } as Stripe.Payout;
}

function makeBankAccount(
  currency: string,
  overrides: Partial<Stripe.BankAccount> = {},
): Stripe.BankAccount {
  return {
    id: 'ba_test',
    object: 'bank_account',
    currency,
    ...overrides,
  } as unknown as Stripe.BankAccount;
}

function makePayoutEvent(
  type: 'payout.paid' | 'payout.failed',
  payout: Stripe.Payout,
): Stripe.Event {
  return {
    id: 'evt_test',
    object: 'event',
    api_version: '2024-12-18.acacia',
    created: 1700000000,
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object: payout },
  } as unknown as Stripe.Event;
}

describe('detectCrossCurrencyPayout', () => {
  it('returns null when destination is a string ID (not expanded)', () => {
    const payout = makePayout({ destination: 'ba_test', currency: 'cad' });
    expect(detectCrossCurrencyPayout(payout)).toBeNull();
  });

  it('returns null when destination is null', () => {
    const payout = makePayout({ destination: null, currency: 'cad' });
    expect(detectCrossCurrencyPayout(payout)).toBeNull();
  });

  it('returns null when destination currency matches payout currency', () => {
    const payout = makePayout({
      destination: makeBankAccount('cad'),
      currency: 'cad',
    });
    expect(detectCrossCurrencyPayout(payout)).toBeNull();
  });

  it('returns the destination currency when it differs from payout currency', () => {
    const payout = makePayout({
      destination: makeBankAccount('usd'),
      currency: 'cad',
    });
    expect(detectCrossCurrencyPayout(payout)).toBe('usd');
  });

  it('returns null when destination is an object missing currency', () => {
    const payout = makePayout({
      destination: { id: 'ba_test', object: 'bank_account' } as unknown as Stripe.BankAccount,
      currency: 'cad',
    });
    expect(detectCrossCurrencyPayout(payout)).toBeNull();
  });
});

describe('rejectCrossCurrencyPayout', () => {
  it('does not throw on same-currency payouts', () => {
    const payout = makePayout({
      destination: makeBankAccount('cad'),
      currency: 'cad',
    });
    expect(() => {
      rejectCrossCurrencyPayout(payout);
    }).not.toThrow();
  });

  it('does not throw on string-destination payouts (no detection possible)', () => {
    const payout = makePayout({ destination: 'ba_test', currency: 'cad' });
    expect(() => {
      rejectCrossCurrencyPayout(payout);
    }).not.toThrow();
  });

  it('throws on cross-currency payouts with a clear, actionable message', () => {
    const payout = makePayout({
      id: 'po_xc_1',
      destination: makeBankAccount('usd'),
      currency: 'cad',
    });
    expect(() => {
      rejectCrossCurrencyPayout(payout);
    }).toThrow(/Cross-currency payouts not yet supported/);
    expect(() => {
      rejectCrossCurrencyPayout(payout);
    }).toThrow(/po_xc_1/);
    expect(() => {
      rejectCrossCurrencyPayout(payout);
    }).toThrow(/source=cad/);
    expect(() => {
      rejectCrossCurrencyPayout(payout);
    }).toThrow(/destination=usd/);
    // The "please open an issue" guidance is part of the message —
    // operators hitting this in production should know what to do.
    expect(() => {
      rejectCrossCurrencyPayout(payout);
    }).toThrow(/open an issue/i);
  });
});

describe('mapEvent rejects cross-currency payouts', () => {
  it('throws on payout.paid with cross-currency destination', () => {
    const payout = makePayout({
      id: 'po_paid_xc',
      destination: makeBankAccount('usd'),
      currency: 'cad',
    });
    expect(() => mapEvent(makePayoutEvent('payout.paid', payout))).toThrow(
      /Cross-currency payouts not yet supported/,
    );
  });

  it('throws on payout.failed with cross-currency destination', () => {
    const payout = makePayout({
      id: 'po_failed_xc',
      destination: makeBankAccount('usd'),
      currency: 'cad',
      status: 'failed',
    });
    expect(() => mapEvent(makePayoutEvent('payout.failed', payout))).toThrow(
      /Cross-currency payouts not yet supported/,
    );
  });

  it('still produces an entry for same-currency payouts with expanded destination', () => {
    // Sanity check: an expanded destination whose currency MATCHES the
    // payout currency should NOT trip the cross-currency guard, so the
    // engine produces the usual 1000/1010 transfer.
    const payout = makePayout({
      id: 'po_same_currency_expanded',
      destination: makeBankAccount('cad'),
      currency: 'cad',
      amount: 5000,
    });
    const result = mapEvent(makePayoutEvent('payout.paid', payout));
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.currency).toBe('CAD');
  });
});
