import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';
import { handleChargeSucceeded } from './charges/chargeSucceeded.js';
import { handleChargeRefunded } from './charges/chargeRefunded.js';
import { handleInvoicePaymentSucceeded } from './invoices/invoicePaymentSucceeded.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
  'charge.refunded': handleChargeRefunded,
  'invoice.payment_succeeded': handleInvoicePaymentSucceeded,
};
