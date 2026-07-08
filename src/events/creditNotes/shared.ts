import type Stripe from 'stripe';

import { partitionLineAmounts } from '../invoices/recognition.js';

/**
 * The amounts a pre-payment credit note posts against its net-terms invoice,
 * or `null` when the credit note is one ledgerly doesn't book (see
 * `handleCreditNoteCreated` for the full rationale). `credit_note.created` and
 * `credit_note.voided` share this so they book and un-book exactly the same
 * cases — a voided credit note reverses precisely what its creation posted.
 *
 * Throws when the invoice's line items are paginated: the deferred-vs-immediate
 * classification needs every line, so the caller must expand all pages first.
 */
export function prepaymentCreditAmounts(
  creditNote: Stripe.CreditNote,
  invoice: Stripe.Invoice,
): { total: number; subtotal: number; tax: number } | null {
  if (invoice.collection_method !== 'send_invoice') return null;
  if (creditNote.type === 'post_payment') return null;
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }
  // A deferred invoice's credit needs a proportional draw-down of its
  // recognition schedule (stateful) — not modeled yet.
  if (partitionLineAmounts(invoice).deferredCustomer > 0) return null;

  const total = creditNote.total;
  if (total === 0) return null;
  const subtotal = creditNote.subtotal;
  return { total, subtotal, tax: total - subtotal };
}
