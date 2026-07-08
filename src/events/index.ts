import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';
import { handleChargeSucceeded } from './charges/chargeSucceeded.js';
import { handleChargeRefunded } from './charges/chargeRefunded.js';
import { handleDisputeClosed } from './disputes/disputeClosed.js';
import { handleDisputeFundsReinstated } from './disputes/disputeFundsReinstated.js';
import { handleDisputeFundsWithdrawn } from './disputes/disputeFundsWithdrawn.js';
import { handleInformational } from './informational.js';
import { handleInvoiceFinalized } from './invoices/invoiceFinalized.js';
import { handleInvoicePaymentSucceeded } from './invoices/invoicePaymentSucceeded.js';
import { handlePayoutFailed } from './payouts/payoutFailed.js';
import { handlePayoutPaid } from './payouts/payoutPaid.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
  'charge.refunded': handleChargeRefunded,
  'charge.dispute.closed': handleDisputeClosed,
  'charge.dispute.funds_reinstated': handleDisputeFundsReinstated,
  'charge.dispute.funds_withdrawn': handleDisputeFundsWithdrawn,
  'invoice.finalized': handleInvoiceFinalized,
  'invoice.payment_succeeded': handleInvoicePaymentSucceeded,
  'payout.failed': handlePayoutFailed,
  'payout.paid': handlePayoutPaid,
  'charge.failed': handleInformational,
  'charge.dispute.created': handleInformational,
  'invoice.payment_failed': handleInformational,
  'customer.subscription.updated': handleInformational,
  'customer.subscription.deleted': handleInformational,
};
