import type Stripe from 'stripe';
import type { MapResult } from '../journal.js';

export type Handler = (event: Stripe.Event) => MapResult;

export const HANDLERS: Readonly<Record<string, Handler>> = {
  // populated as handlers are added
};
