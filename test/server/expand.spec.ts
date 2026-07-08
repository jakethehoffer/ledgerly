import { describe, it, expect, vi } from 'vitest';
import type Stripe from 'stripe';
import { expandEvent } from '../../src/server/expand.js';

interface MockStripe {
  charges: { retrieve: ReturnType<typeof vi.fn> };
  invoices: { retrieve: ReturnType<typeof vi.fn> };
  disputes: { retrieve: ReturnType<typeof vi.fn> };
  payouts: { retrieve: ReturnType<typeof vi.fn> };
  creditNotes: { retrieve: ReturnType<typeof vi.fn> };
}

function makeMockStripe(overrides: {
  charge?: object;
  invoice?: object;
  dispute?: object;
  payout?: object;
  creditNote?: object;
}): MockStripe {
  return {
    charges: { retrieve: vi.fn().mockResolvedValue(overrides.charge ?? {}) },
    invoices: { retrieve: vi.fn().mockResolvedValue(overrides.invoice ?? {}) },
    disputes: { retrieve: vi.fn().mockResolvedValue(overrides.dispute ?? {}) },
    payouts: { retrieve: vi.fn().mockResolvedValue(overrides.payout ?? {}) },
    creditNotes: { retrieve: vi.fn().mockResolvedValue(overrides.creditNote ?? {}) },
  };
}

function makeEvent(type: string, object: object): Stripe.Event {
  return {
    id: 'evt_test',
    object: 'event',
    api_version: '2024-12-18.acacia',
    created: 1_700_000_000,
    type,
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    data: { object },
  } as unknown as Stripe.Event;
}

describe('expandEvent', () => {
  it('expands charge.succeeded with balance_transaction + refunds', async () => {
    const expanded = { id: 'ch_1', balance_transaction: { id: 'txn_1' } };
    const mock = makeMockStripe({ charge: expanded });
    const event = makeEvent('charge.succeeded', { id: 'ch_1' });

    const out = await expandEvent(mock as unknown as Stripe, event);

    expect(mock.charges.retrieve).toHaveBeenCalledWith('ch_1', {
      expand: ['balance_transaction', 'refunds.data.balance_transaction'],
    });
    expect(out.data.object).toBe(expanded);
    expect(out.id).toBe(event.id);
    expect(out.type).toBe(event.type);
  });

  it('expands charge.refunded with balance_transaction, refunds, and invoice', async () => {
    const expanded = { id: 'ch_2' };
    const mock = makeMockStripe({ charge: expanded });
    const event = makeEvent('charge.refunded', { id: 'ch_2' });

    await expandEvent(mock as unknown as Stripe, event);

    expect(mock.charges.retrieve).toHaveBeenCalledWith('ch_2', {
      expand: ['balance_transaction', 'refunds.data.balance_transaction', 'invoice'],
    });
  });

  it('expands invoice.payment_succeeded with charge.balance_transaction', async () => {
    const expanded = { id: 'in_1' };
    const mock = makeMockStripe({ invoice: expanded });
    const event = makeEvent('invoice.payment_succeeded', { id: 'in_1' });

    const out = await expandEvent(mock as unknown as Stripe, event);

    expect(mock.invoices.retrieve).toHaveBeenCalledWith('in_1', {
      expand: ['charge.balance_transaction'],
    });
    expect(out.data.object).toBe(expanded);
  });

  it.each([
    'charge.dispute.funds_withdrawn',
    'charge.dispute.funds_reinstated',
    'charge.dispute.closed',
  ])('expands %s with balance_transactions', async (type) => {
    const expanded = { id: 'dp_1' };
    const mock = makeMockStripe({ dispute: expanded });
    const event = makeEvent(type, { id: 'dp_1' });

    const out = await expandEvent(mock as unknown as Stripe, event);

    expect(mock.disputes.retrieve).toHaveBeenCalledWith('dp_1', {
      expand: ['balance_transactions', 'charge.balance_transaction'],
    });
    expect(out.data.object).toBe(expanded);
  });

  it.each([
    'payout.paid',
    'payout.failed',
  ])('expands %s with destination (for cross-currency detection)', async (type) => {
    const expanded = { id: 'po_1' };
    const mock = makeMockStripe({ payout: expanded });
    const event = makeEvent(type, { id: 'po_1' });

    const out = await expandEvent(mock as unknown as Stripe, event);

    expect(mock.payouts.retrieve).toHaveBeenCalledWith('po_1', {
      expand: ['destination'],
    });
    expect(out.data.object).toBe(expanded);
  });

  it.each(['credit_note.created', 'credit_note.voided'])(
    'expands %s with invoice',
    async (type) => {
      const expanded = { id: 'cn_1', invoice: { id: 'in_1' } };
      const mock = makeMockStripe({ creditNote: expanded });
      const event = makeEvent(type, { id: 'cn_1' });

      const out = await expandEvent(mock as unknown as Stripe, event);

      expect(mock.creditNotes.retrieve).toHaveBeenCalledWith('cn_1', {
        expand: ['invoice'],
      });
      expect(out.data.object).toBe(expanded);
    },
  );

  it.each([
    'charge.failed',
    'charge.dispute.created',
    'invoice.payment_failed',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ])('returns %s unchanged (no API calls)', async (type) => {
    const mock = makeMockStripe({});
    const event = makeEvent(type, { id: 'obj_1' });

    const out = await expandEvent(mock as unknown as Stripe, event);

    expect(out).toBe(event);
    expect(mock.charges.retrieve).not.toHaveBeenCalled();
    expect(mock.invoices.retrieve).not.toHaveBeenCalled();
    expect(mock.disputes.retrieve).not.toHaveBeenCalled();
    expect(mock.payouts.retrieve).not.toHaveBeenCalled();
    expect(mock.creditNotes.retrieve).not.toHaveBeenCalled();
  });

  it('returns unknown event types unchanged', async () => {
    const mock = makeMockStripe({});
    const event = makeEvent('payment_intent.succeeded', { id: 'pi_1' });

    const out = await expandEvent(mock as unknown as Stripe, event);

    expect(out).toBe(event);
    expect(mock.charges.retrieve).not.toHaveBeenCalled();
  });

  it('does not mutate the original event', async () => {
    const original = makeEvent('charge.succeeded', { id: 'ch_3' });
    const originalObject = original.data.object;
    const mock = makeMockStripe({ charge: { id: 'ch_3_expanded' } });

    await expandEvent(mock as unknown as Stripe, original);

    expect(original.data.object).toBe(originalObject);
  });
});
