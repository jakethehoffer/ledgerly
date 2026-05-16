import type Stripe from 'stripe';
import { assertBalanced, type MapResult } from './journal.js';
import { HANDLERS } from './events/index.js';
import { UnhandledEventError } from './errors.js';

export function mapEvent(event: Stripe.Event): MapResult {
  const handler = HANDLERS[event.type];
  if (!handler) {
    throw new UnhandledEventError(event.type, event.id);
  }
  const result = handler(event);
  for (const entry of result.entries) assertBalanced(entry);
  if (result.schedule) {
    for (const entry of result.schedule.entries) assertBalanced(entry);
  }
  return result;
}
