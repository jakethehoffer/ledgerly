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

/**
 * The amounts a **post-payment** credit note posts when its credit is returned
 * **entirely to the customer's credit balance** rather than refunded as cash
 * (Dr 4000 / Dr 2000 / Cr 2200), or `null` when the credit note is one ledgerly
 * doesn't book this way. `credit_note.created` and `credit_note.voided` share
 * this so a void un-books exactly what creation booked.
 *
 * Skipped (still a no-op, booked elsewhere or not modeled):
 *   - refund-backed post-payment credits (`refund` set) — `charge.refunded`
 *     books the cash returned;
 *   - a credit split across the balance and an out-of-band amount — needs
 *     proportioning;
 *   - a credit against a deferred-schedule invoice — reversing recognized
 *     revenue that still partly sits in 2100 needs the schedule draw-down the
 *     stateless engine can't do (same limitation as the pre-payment path).
 *
 * Throws when the invoice's line items are paginated, like
 * {@link prepaymentCreditAmounts}.
 */
export function balanceCreditAmounts(
  creditNote: Stripe.CreditNote,
  invoice: Stripe.Invoice,
): { total: number; subtotal: number; tax: number } | null {
  if (creditNote.type !== 'post_payment') return null;
  if (creditNote.refund) return null;
  if (!creditNote.customer_balance_transaction) return null;
  if ((creditNote.out_of_band_amount ?? 0) !== 0) return null;
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }
  // A deferred invoice's recognized revenue partly sits in 2100 on a schedule;
  // reversing it needs a proportional draw-down (stateful) — not modeled yet.
  if (partitionLineAmounts(invoice).deferredCustomer > 0) return null;

  const total = creditNote.total;
  if (total === 0) return null;
  const subtotal = creditNote.subtotal;
  return { total, subtotal, tax: total - subtotal };
}
