import { describe, it, expect } from 'vitest';
import type Stripe from 'stripe';
import {
  chargeMemo,
  disputeMemo,
  invoiceMemo,
  payoutMemo,
  refundMemo,
} from '../../src/util/memo.js';

/**
 * The memo formatters are exercised indirectly by the engine fixture tests,
 * but the polymorphic `customer` / `destination` / `charge` fields have
 * branches (object-shaped vs string-id-shaped) that the fixtures don't all
 * cover. These tests fill those gaps directly so a regression in the type
 * narrowing surfaces without needing to wait for a fixture to fail.
 */

function makeCharge(overrides: Partial<Stripe.Charge> = {}): Stripe.Charge {
  return {
    id: 'ch_x',
    customer: null,
    ...overrides,
  } as Stripe.Charge;
}

function makePayout(overrides: Partial<Stripe.Payout> = {}): Stripe.Payout {
  return {
    id: 'po_x',
    destination: null,
    ...overrides,
  } as Stripe.Payout;
}

function makeDispute(overrides: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
  return {
    id: 'dp_x',
    charge: 'ch_y',
    ...overrides,
  } as Stripe.Dispute;
}

describe('chargeMemo', () => {
  it('uses "guest" when customer is null', () => {
    expect(chargeMemo(makeCharge({ customer: null }))).toBe(
      'Stripe charge ch_x (customer guest)',
    );
  });

  it('uses "guest" when customer is undefined', () => {
    expect(
      chargeMemo(makeCharge({ customer: undefined as unknown as null })),
    ).toBe('Stripe charge ch_x (customer guest)');
  });

  it('uses the string customer id directly', () => {
    expect(chargeMemo(makeCharge({ customer: 'cus_42' }))).toBe(
      'Stripe charge ch_x (customer cus_42)',
    );
  });

  it('extracts .id when customer is an expanded Customer object', () => {
    expect(
      chargeMemo(
        makeCharge({
          customer: { id: 'cus_99', object: 'customer' } as Stripe.Customer,
        }),
      ),
    ).toBe('Stripe charge ch_x (customer cus_99)');
  });

  it('extracts .id when customer is a DeletedCustomer object', () => {
    expect(
      chargeMemo(
        makeCharge({
          customer: {
            id: 'cus_deleted',
            object: 'customer',
            deleted: true,
          } as Stripe.DeletedCustomer,
        }),
      ),
    ).toBe('Stripe charge ch_x (customer cus_deleted)');
  });
});

describe('refundMemo', () => {
  it('formats charge + refund id', () => {
    expect(refundMemo(makeCharge({ id: 'ch_abc' }), 're_xyz')).toBe(
      'Stripe refund re_xyz for charge ch_abc',
    );
  });
});

describe('invoiceMemo', () => {
  it('handles string customer', () => {
    const invoice = { id: 'in_1', customer: 'cus_1' } as Stripe.Invoice;
    expect(invoiceMemo(invoice)).toBe('Stripe invoice in_1 (customer cus_1)');
  });

  it('handles expanded customer object', () => {
    const invoice = {
      id: 'in_1',
      customer: { id: 'cus_obj', object: 'customer' } as Stripe.Customer,
    } as Stripe.Invoice;
    expect(invoiceMemo(invoice)).toBe('Stripe invoice in_1 (customer cus_obj)');
  });
});

describe('payoutMemo', () => {
  it('default kind=paid uses "to" + destination', () => {
    expect(payoutMemo(makePayout({ destination: 'ba_card_1' }))).toBe(
      'Stripe payout po_x to ba_card_1',
    );
  });

  it('falls back to "bank" when destination is null', () => {
    expect(payoutMemo(makePayout({ destination: null }))).toBe(
      'Stripe payout po_x to bank',
    );
  });

  it('extracts .id when destination is an expanded BankAccount object', () => {
    // Stripe's typed Payout['destination'] is `string | DeletedBankAccount |
    // ExternalAccount | null`; an expanded ExternalAccount has an `id` field.
    const dest = { id: 'ba_obj', object: 'bank_account' } as Stripe.BankAccount;
    expect(
      payoutMemo(
        makePayout({
          destination: dest as unknown as Stripe.Payout['destination'],
        }),
      ),
    ).toBe('Stripe payout po_x to ba_obj');
  });

  it('kind=failed uses "failed (returned from ...)"', () => {
    expect(
      payoutMemo(makePayout({ destination: 'ba_card_2' }), 'failed'),
    ).toBe('Stripe payout po_x failed (returned from ba_card_2)');
  });

  it('kind=failed with null destination', () => {
    expect(payoutMemo(makePayout({ destination: null }), 'failed')).toBe(
      'Stripe payout po_x failed (returned from bank)',
    );
  });
});

describe('disputeMemo', () => {
  it('handles all five DisputeMemoKind values with string charge id', () => {
    const dispute = makeDispute({ id: 'dp_1', charge: 'ch_1' });
    expect(disputeMemo(dispute, 'funds withdrawn')).toBe(
      'Stripe dispute dp_1 funds withdrawn (charge ch_1)',
    );
    expect(disputeMemo(dispute, 'funds reinstated')).toBe(
      'Stripe dispute dp_1 funds reinstated (charge ch_1)',
    );
    expect(disputeMemo(dispute, 'closed lost')).toBe(
      'Stripe dispute dp_1 closed lost (charge ch_1)',
    );
    expect(disputeMemo(dispute, 'closed won')).toBe(
      'Stripe dispute dp_1 closed won (charge ch_1)',
    );
    expect(disputeMemo(dispute, 'warning closed')).toBe(
      'Stripe dispute dp_1 warning closed (charge ch_1)',
    );
  });

  it('extracts .id when charge is an expanded Charge object', () => {
    const dispute = makeDispute({
      id: 'dp_2',
      charge: { id: 'ch_expanded', object: 'charge' } as Stripe.Charge,
    });
    expect(disputeMemo(dispute, 'funds withdrawn')).toBe(
      'Stripe dispute dp_2 funds withdrawn (charge ch_expanded)',
    );
  });
});
