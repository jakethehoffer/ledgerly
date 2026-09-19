import type Stripe from 'stripe';

// The mapper uses the schema shipped with our supported Stripe SDK. Webhook
// endpoints can use a newer schema, so retrieve those invoices explicitly in
// the supported format instead of silently treating missing fields as zero.
const INVOICE_API_VERSION = '2024-06-20';

async function completeInvoice(stripe: Stripe, original: Stripe.Invoice): Promise<Stripe.Invoice> {
  let invoice = original;
  if ('total_taxes' in invoice || 'parent' in invoice) {
    invoice = await stripe.invoices.retrieve(invoice.id, {}, { apiVersion: INVOICE_API_VERSION });
  }
  if (!invoice.lines.has_more) return invoice;

  const lines: Stripe.InvoiceLineItem[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const page = await stripe.invoices.listLineItems(invoice.id, {
      limit: 100,
      ...(cursor ? { starting_after: cursor } : {}),
    }, { apiVersion: INVOICE_API_VERSION });
    for (const line of page.data) {
      if (seen.has(line.id)) throw new Error('Invoice pagination repeated a line');
      seen.add(line.id);
      lines.push(line);
    }
    hasMore = page.has_more;
    if (hasMore) {
      const last = page.data.at(-1);
      if (!last) throw new Error('Invoice pagination did not advance');
      cursor = last.id;
    }
  }
  return { ...invoice, lines: { ...invoice.lines, data: lines, has_more: false } };
}

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
      let expanded = await stripe.charges.retrieve(charge.id, {
        expand: ['balance_transaction', 'refunds.data.balance_transaction', 'invoice'],
      });
      if (expanded.invoice && typeof expanded.invoice === 'object') {
        expanded = { ...expanded, invoice: await completeInvoice(stripe, expanded.invoice) };
      }
      const embeddedRefunds = expanded.refunds;
      if (!embeddedRefunds?.has_more) {
        return cloneEventWithObject(event, expanded);
      }

      // A Charge only embeds its newest refunds. Cumulative basis allocation
      // needs every prior refund on the charge, so page through the dedicated
      // list endpoint and expand each refund's balance transaction before the
      // pure mapper runs.
      const refunds: Stripe.Refund[] = [];
      let startingAfter: string | undefined;
      let hasMore = true;
      while (hasMore) {
        const page = await stripe.refunds.list({
          charge: charge.id,
          limit: 100,
          ...(startingAfter ? { starting_after: startingAfter } : {}),
          expand: ['data.balance_transaction'],
        });
        refunds.push(...page.data);

        hasMore = page.has_more;
        if (!hasMore) continue;

        const lastRefund = page.data.at(-1);
        if (!lastRefund || lastRefund.id === startingAfter) {
          throw new Error(
            `Stripe returned an invalid refund page for charge ${charge.id}; ` +
              'complete refund history required',
          );
        }
        startingAfter = lastRefund.id;
      }

      return cloneEventWithObject(event, {
        ...expanded,
        refunds: { ...embeddedRefunds, data: refunds, has_more: false },
      });
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object;
      const expanded = await stripe.invoices.retrieve(invoice.id, {
        expand: ['charge.balance_transaction'],
      }, { apiVersion: INVOICE_API_VERSION });
      return cloneEventWithObject(event, await completeInvoice(stripe, expanded));
    }

    case 'credit_note.created':
    case 'credit_note.voided': {
      // `invoice` is expanded so the handler can read the invoice's
      // collection_method (only net-terms invoices booked a receivable) and
      // classify its line periods (a deferred invoice's credit isn't modeled
      // yet). The invoice carries its own line items inline.
      const creditNote = event.data.object;
      const expanded = await stripe.creditNotes.retrieve(creditNote.id, {
        expand: ['invoice'],
      });
      if (expanded.invoice && typeof expanded.invoice === 'object') {
        const invoice = await completeInvoice(stripe, expanded.invoice);
        if (invoice === expanded.invoice) return cloneEventWithObject(event, expanded);
        return cloneEventWithObject(event, {
          ...expanded, invoice,
        });
      }
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
      return cloneEventWithObject(event, await completeInvoice(stripe, event.data.object));
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
