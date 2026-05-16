import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';
import { handleChargeSucceeded } from './charges/chargeSucceeded.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
};
