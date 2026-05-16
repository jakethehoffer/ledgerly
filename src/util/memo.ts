import type Stripe from 'stripe';

function customerLabel(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string {
  if (customer === null || customer === undefined) return 'guest';
  if (typeof customer === 'string') return customer;
  return customer.id;
}

function destinationLabel(destination: Stripe.Payout['destination']): string {
  if (destination === null) return 'bank';
  if (typeof destination === 'string') return destination;
  return destination.id;
}

export function chargeMemo(charge: Stripe.Charge): string {
  return `Stripe charge ${charge.id} (customer ${customerLabel(charge.customer)})`;
}

export function refundMemo(charge: Stripe.Charge, refundId: string): string {
  return `Stripe refund ${refundId} for charge ${charge.id}`;
}

export function invoiceMemo(invoice: Stripe.Invoice): string {
  return `Stripe invoice ${invoice.id} (customer ${customerLabel(invoice.customer)})`;
}

export function payoutMemo(payout: Stripe.Payout): string {
  return `Stripe payout ${payout.id} to ${destinationLabel(payout.destination)}`;
}

function disputeChargeId(charge: Stripe.Dispute['charge']): string {
  return typeof charge === 'string' ? charge : charge.id;
}

export type DisputeMemoKind =
  | 'funds withdrawn'
  | 'funds reinstated'
  | 'closed lost'
  | 'closed won'
  | 'warning closed';

export function disputeMemo(dispute: Stripe.Dispute, kind: DisputeMemoKind): string {
  return `Stripe dispute ${dispute.id} ${kind} (charge ${disputeChargeId(dispute.charge)})`;
}
