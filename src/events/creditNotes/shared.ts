import type Stripe from 'stripe';

import { partitionLineAmounts } from '../invoices/recognition.js';

/**
 * Shape gate — a **pre-payment** credit note against a net-terms
 * (`send_invoice`) invoice, which booked a receivable (1100) at finalization.
 * Crediting it reduces what the customer still owes.
 */
export function isPrepaymentToReceivable(
  creditNote: Stripe.CreditNote,
  invoice: Stripe.Invoice,
): boolean {
  return creditNote.type !== 'post_payment' && invoice.collection_method === 'send_invoice';
}

/**
 * Shape gate — a **post-payment** credit note whose credit is returned
 * **entirely to the customer's balance** (no cash refund, no out-of-band slice),
 * which books the 2200 Customer Credit Balance liability.
 */
export function isPostPaymentToBalance(creditNote: Stripe.CreditNote): boolean {
  return (
    creditNote.type === 'post_payment' &&
    !creditNote.refund &&
    !!creditNote.customer_balance_transaction &&
    (creditNote.out_of_band_amount ?? 0) === 0
  );
}

/**
 * The 4000/2100/tax-reversing account a bookable credit note credits: 1100 for a
 * pre-payment (reduce the receivable), 2200 for a post-payment-to-balance credit
 * (book the customer credit). Only meaningful once a shape gate has matched.
 */
export function creditNoteFundingAccount(creditNote: Stripe.CreditNote): '1100' | '2200' {
  return creditNote.type === 'post_payment' ? '2200' : '1100';
}

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
  if (!isPrepaymentToReceivable(creditNote, invoice)) return null;
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }
  // A deferred invoice's credit needs a proportional draw-down of its
  // recognition schedule (stateful) — the server reconciler handles it; the
  // stateless engine refuses it (see `creditNoteHasDeferredSchedule`).
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
 *     stateless engine can't do (the server reconciler handles it).
 *
 * Throws when the invoice's line items are paginated, like
 * {@link prepaymentCreditAmounts}.
 */
export function balanceCreditAmounts(
  creditNote: Stripe.CreditNote,
  invoice: Stripe.Invoice,
): { total: number; subtotal: number; tax: number } | null {
  if (!isPostPaymentToBalance(creditNote)) return null;
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }
  // A deferred invoice's recognized revenue partly sits in 2100 on a schedule;
  // reversing it needs a proportional draw-down (stateful) — the server
  // reconciler handles it, the stateless engine refuses it.
  if (partitionLineAmounts(invoice).deferredCustomer > 0) return null;

  const total = creditNote.total;
  if (total === 0) return null;
  const subtotal = creditNote.subtotal;
  return { total, subtotal, tax: total - subtotal };
}

/**
 * True when a credit note ledgerly would book (a pre-payment on a `send_invoice`
 * invoice, or a post-payment credited wholly to balance) targets an invoice that
 * **deferred** revenue to a recognition schedule. This is the credit-note analog
 * of `voidHasDeferredSchedule`: the stateless engine refuses these (a correct
 * reversal depends on how much has recognized and needs the schedule reduced),
 * and the bundled receiver routes them to the credit reconciler instead.
 *
 * Returns `false` for every shape the engine no-ops anyway (refund-backed,
 * charge_automatically pre-payment, split, zero-total), so only the two bookable
 * deferred shapes route to the reconciler.
 *
 * Throws when the invoice's line items are paginated, like the amount helpers —
 * the deferred classification needs every line.
 */
export function creditNoteHasDeferredSchedule(
  creditNote: Stripe.CreditNote,
  invoice: Stripe.Invoice,
): boolean {
  if (
    !isPrepaymentToReceivable(creditNote, invoice) &&
    !isPostPaymentToBalance(creditNote)
  ) {
    return false;
  }
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }
  if (creditNote.total === 0) return false;
  return partitionLineAmounts(invoice).deferredCustomer > 0;
}
