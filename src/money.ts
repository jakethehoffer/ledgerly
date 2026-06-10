/**
 * Integer count in the journal entry's smallest currency unit. "Cents" is a
 * historical name: ledgerly stores amounts in whatever unit Stripe gives us
 * via `bt.amount` / `charge.amount` / etc., which Stripe normalizes to the
 * currency's smallest indivisible unit:
 *
 *   - USD / EUR / GBP / CAD / AUD / etc. (2-decimal currencies): cents
 *   - JPY / KRW / VND (zero-decimal currencies): the whole unit (yen, won, dong)
 *   - BHD / KWD / JOD (three-decimal currencies): fils
 *
 * The engine itself is currency-agnostic — it just sums integers. Display
 * formatting (dividing by the appropriate 10^N) happens in the QBO/Xero
 * exporters, which derive the per-currency divisor via `currencyMinorUnits`
 * / `minorToMajor` in `currency.js` — zero-, two-, and three-decimal
 * currencies are all handled and covered by `test/currency.spec.ts`.
 */
export type Cents = number & { readonly __brand: 'cents' };

/**
 * Construct a {@link Cents} value. Throws if `n` is not a finite integer.
 *
 * Money in ledgerly is always stored as integer smallest-currency-unit
 * counts. The brand prevents accidentally mixing dollars and cents at
 * type-checking time; the runtime check here catches mistakes that escape
 * the type system (e.g. division results).
 */
export function cents(n: number): Cents {
  if (!Number.isInteger(n)) {
    throw new RangeError(`Cents must be a finite integer, got ${String(n)}`);
  }
  return n as Cents;
}

export const ZERO_CENTS: Cents = cents(0);
