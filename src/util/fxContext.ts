import { cents } from '../money.js';
import type { FxContext, JournalEntry } from '../journal.js';

/**
 * Build an {@link FxContext} for an event where Stripe converted between
 * currencies, or return `undefined` for same-currency events.
 *
 * Pass the raw Stripe-payload currency codes (lowercase) — this helper
 * normalizes to uppercase to match `JournalEntry.currency`. The undefined
 * return for same-currency cases lets handlers stitch the field in via
 * {@link withFx} so same-currency JournalEntry JSON omits `fxContext`
 * entirely (matters for fixture byte-identity).
 */
export function buildFxContext(
  customerCurrency: string,
  customerAmount: number,
  settlementCurrency: string,
  settlementAmount: number,
): FxContext | undefined {
  if (customerCurrency === settlementCurrency) return undefined;
  return {
    customerCurrency: customerCurrency.toUpperCase(),
    customerAmount: cents(customerAmount),
    settlementCurrency: settlementCurrency.toUpperCase(),
    settlementAmount: cents(settlementAmount),
  };
}

/**
 * Attach an `fxContext` to a built JournalEntry — but only when the
 * context is defined. Returning the entry untouched for same-currency
 * events preserves byte-identical JSON output (no extra `fxContext` key
 * in the serialized form).
 */
export function withFx(
  entry: JournalEntry,
  fxContext: FxContext | undefined,
): JournalEntry {
  return fxContext === undefined ? entry : { ...entry, fxContext };
}
