import type Stripe from 'stripe';

/**
 * For each event type the engine handles, fetch the nested objects the engine
 * requires (per the design spec's expansion table). Returns a new event with
 * `data.object` replaced by the expanded version. Events that need no
 * expansion are returned unchanged.
 *
 * Informational event types (`charge.failed`, `charge.dispute.created`,
 * `invoice.payment_failed`, `customer.subscription.*`) need no expansion.
 *
 * Expansion calls are best-effort: if the Stripe API errors (e.g. rate limit,
 * network), the error propagates and the caller decides how to respond.
 */
export async function expandEvent(stripe: Stripe, event: Stripe.Event): Promise<Stripe.Event> {
  switch (event.type) {
    case 'charge.succeeded': {
      const charge = event.data.object;
      const expanded = await stripe.charges.retrieve(charge.id, {
        expand: ['balance_transaction', 'refunds.data.balance_transaction'],
      });
      return cloneEventWithObject(event, expanded);
    }

    case 'charge.refunded': {
      // `invoice` is expanded so the engine can drain 2000 Sales Tax Payable
      // proportionally for refunds of Stripe Tax-bearing charges.
      const charge = event.data.object;
      const expanded = await stripe.charges.retrieve(charge.id, {
        expand: ['balance_transaction', 'refunds.data.balance_transaction', 'invoice'],
      });
      return cloneEventWithObject(event, expanded);
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const expanded = await stripe.invoices.retrieve(invoice.id, {
        expand: ['charge.balance_transaction'],
      });
      return cloneEventWithObject(event, expanded);
    }

    case 'credit_note.created': {
      // `invoice` is expanded so the handler can read the invoice's
      // collection_method (only net-terms invoices booked a receivable) and
      // classify its line periods (a deferred invoice's credit isn't modeled
      // yet). The invoice carries its own line items inline.
      const creditNote = event.data.object;
      const expanded = await stripe.creditNotes.retrieve(creditNote.id, {
        expand: ['invoice'],
      });
      return cloneEventWithObject(event, expanded);
    }

    case 'charge.dispute.funds_withdrawn':
    case 'charge.dispute.funds_reinstated':
    case 'charge.dispute.closed': {
      // `charge.balance_transaction` is expanded so the dispute handlers can
      // recognize realized FX gain/loss when the dispute's BT rate differs
      // from the original charge's BT rate (rate drift between charge and
      // dispute moments). Same pattern as charge.refunded expansion.
      const dispute = event.data.object;
      const expanded = await stripe.disputes.retrieve(dispute.id, {
        expand: ['balance_transactions', 'charge.balance_transaction'],
      });
      return cloneEventWithObject(event, expanded);
    }

    case 'payout.paid':
    case 'payout.failed': {
      // `destination` is expanded so the payout handlers can detect
      // cross-currency payouts (destination bank currency ≠ settlement
      // currency) and reject them loudly instead of silently producing
      // a 1000/1010 transfer that doesn't account for the FX conversion
      // Stripe applied at payout time.
      const payout = event.data.object;
      const expanded = await stripe.payouts.retrieve(payout.id, {
        expand: ['destination'],
      });
      return cloneEventWithObject(event, expanded);
    }

    // No expansion needed for these — handler reads only inline scalars.
    // `invoice.finalized` books a B2B receivable from the unpaid invoice: there
    // is no charge or balance transaction to expand yet (the cash arrives later
    // on invoice.payment_succeeded).
    case 'invoice.finalized':
    case 'invoice.marked_uncollectible':
    case 'invoice.voided':
    case 'charge.failed':
    case 'charge.dispute.created':
    case 'invoice.payment_failed':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return event;

    default:
      return event;
  }
}

/**
 * Returns a shallow clone of the event with `data.object` swapped for a
 * freshly-expanded object. The Stripe `Event` type is a discriminated union
 * keyed on `type`, so a generic clone via spread is the simplest way to
 * preserve narrowing while replacing one field.
 */
function cloneEventWithObject(event: Stripe.Event, object: unknown): Stripe.Event {
  return {
    ...event,
    data: {
      ...event.data,
      object: object as Stripe.Event.Data.Object,
    },
  } as Stripe.Event;
}
