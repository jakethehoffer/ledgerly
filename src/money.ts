/** Integer minor units in the journal's functional currency (e.g. USD cents). */
export type Cents = number & { readonly __brand: 'cents' };

/**
 * Construct a Cents value. Throws if `n` is not a finite integer.
 *
 * Money in ledgerly is always stored as integer minor units. The brand prevents
 * accidentally mixing dollars and cents at type-checking time; the runtime check
 * here catches mistakes that escape the type system (e.g. division results).
 */
export function cents(n: number): Cents {
  if (!Number.isInteger(n)) {
    throw new RangeError(`Cents must be a finite integer, got ${String(n)}`);
  }
  return n as Cents;
}

export const ZERO_CENTS: Cents = cents(0);
