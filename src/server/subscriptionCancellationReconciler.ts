import type Stripe from 'stripe';
import { epochToUtcDate } from '../util/dates.js';
import type { SubscriptionCancellationInput } from './storage/types.js';

/**
 * Build the storage-only close-out for a subscription that has actually ended.
 * `ended_at` is the effective service end. `canceled_at` is deliberately not
 * used because Stripe sets it to the request time for an end-of-period cancel,
 * which can be months before service really stops.
 */
export function buildSubscriptionCancellationInput(
  event: Stripe.Event,
): SubscriptionCancellationInput {
  if (event.type !== 'customer.subscription.deleted') {
    throw new Error(`buildSubscriptionCancellationInput received wrong event type: ${event.type}`);
  }
  const subscription = event.data.object;
  if (subscription.ended_at === null) {
    throw new Error(`Cannot close subscription ${subscription.id}: deleted event has no ended_at`);
  }
  return {
    subscriptionId: subscription.id,
    effectiveEndDate: epochToUtcDate(subscription.ended_at),
  };
}

/**
 * A planned cancellation remains informational. Acting only on the deleted
 * event means service paid through period end keeps recognizing, and a pending
 * cancellation can be removed without having to resurrect schedule rows.
 */
export function subscriptionCancellationNeedsReconcile(event: Stripe.Event): boolean {
  return event.type === 'customer.subscription.deleted';
}
