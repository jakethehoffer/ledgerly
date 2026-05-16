import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';
import { handleChargeSucceeded } from './charges/chargeSucceeded.js';
import { handleChargeRefunded } from './charges/chargeRefunded.js';
import { handleDisputeFundsWithdrawn } from './disputes/disputeFundsWithdrawn.js';
import { handleInvoicePaymentSucceeded } from './invoices/invoicePaymentSucceeded.js';
import { handlePayoutPaid } from './payouts/payoutPaid.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
  'charge.refunded': handleChargeRefunded,
  'charge.dispute.funds_withdrawn': handleDisputeFundsWithdrawn,
  'invoice.payment_succeeded': handleInvoicePaymentSucceeded,
  'payout.paid': handlePayoutPaid,
};
