import type Stripe from 'stripe';

/**
 * Detect a cross-currency payout — the case where Stripe converts between
 * settlement currency (the Stripe balance the funds left) and destination
 * currency (the bank account currency that receives them). Returns the
 * destination currency when a mismatch is detected, `null` otherwise.
 *
 * Detection requires `payout.destination` to be expanded (the receiver's
 * `expand.ts` requests this on every payout event). When the caller hasn't
 * expanded — string ID, null, or an object missing a usable `currency`
 * field — this returns `null` and the caller treats the payout as
 * same-currency (preserving v0.1.10 behavior for fixtures and direct-
 * library callers that don't expand).
 *
 * Why detect-and-reject rather than implement: the cross-currency BT
 * shape Stripe uses (FX fee inline on the payout BT vs a separate
 * adjustment BT, whether `destination_amount` is set, how reversed
 * cross-currency payouts on `payout.failed` undo the conversion) isn't
 * documented in a way we can implement against without seeing real
 * payloads. Failing loudly with the actual currencies surfaces the case
 * for the operator to report, rather than silently producing a 1000/1010
 * transfer that doesn't account for the FX fee or destination amount.
 */
export function detectCrossCurrencyPayout(payout: Stripe.Payout): string | null {
  const dest = payout.destination;
  if (dest === null || typeof dest === 'string') return null;
  const destCurrency =
    'currency' in dest && typeof dest.currency === 'string' ? dest.currency : null;
  if (destCurrency === null) return null;
  if (destCurrency === payout.currency) return null;
  return destCurrency;
}

/**
 * Convenience: throw with a clear, actionable message when
 * {@link detectCrossCurrencyPayout} flags a mismatch. The two handlers
 * (`payoutPaid`, `payoutFailed`) call this immediately after extracting
 * the payout from the event, before doing any accounting work — so the
 * error fires before we'd produce a silently-wrong entry.
 */
export function rejectCrossCurrencyPayout(payout: Stripe.Payout): void {
  const destCurrency = detectCrossCurrencyPayout(payout);
  if (destCurrency === null) return;
  throw new Error(
    `Cross-currency payouts not yet supported (payout ${payout.id}: ` +
      `source=${payout.currency}, destination=${destCurrency}). ` +
      `The engine doesn't model Stripe's FX conversion fee on these ` +
      `payouts, so silently producing a 1000/1010 transfer in the source ` +
      `currency would understate the destination value. See ` +
      `docs/cross-currency-payouts.md for the design notes and exactly ` +
      `what to capture — then please open an issue with that payload so ` +
      `the BT shape can be modeled against real data.`,
  );
}
