import type Stripe from 'stripe';

/**
 * The original charge's settlement basis, derived from the expanded
 * `charge.balance_transaction`: the FX rate Stripe used when the charge
 * settled — the (settlement-currency) `bt.amount` over the
 * (customer-currency) `charge.amount` — together with the settlement
 * currency itself.
 *
 * Returns `null` when the expansion needed isn't present (the charge is a
 * string id, or its `balance_transaction` is unexpanded/absent) or the
 * charge amount is non-positive. Callers treat `null` as "no FX
 * gain/loss recognition for this dispute" and fall back to v0.1.6
 * behavior — using the dispute's own customer-facing amount and currency.
 *
 * The receiver's `expand.ts` requests `charge.balance_transaction` on every
 * dispute event, so production callers always get a usable result; the
 * null path exists for fixtures and direct-library callers that don't
 * expand.
 *
 * All three dispute handlers share this one definition so the leg that
 * PARKS the 1200 Disputes Receivable (funds_withdrawn) and the legs that
 * RELEASE it (funds_reinstated, closed) compute the original rate
 * identically. Because the inputs (`dispute.amount`, the original charge
 * BT) are immutable across a dispute's lifecycle, `round(dispute.amount *
 * rate)` yields the same integer at withdrawal and at resolution — so the
 * receivable clears exactly. Any divergence between the legs would strand
 * the clearing account.
 */
export interface OriginalSettlement {
  readonly rate: number;
  readonly currency: string;
}

export function originalChargeSettlement(
  dispute: Stripe.Dispute,
): OriginalSettlement | null {
  const charge = dispute.charge;
  if (typeof charge !== 'object') return null;
  if (charge.amount <= 0) return null;
  const bt = charge.balance_transaction;
  if (bt === null || typeof bt === 'string') return null;
  return { rate: Math.abs(bt.amount) / charge.amount, currency: bt.currency };
}
