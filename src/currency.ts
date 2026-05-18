/**
 * ISO 4217 currency codes (3-letter, uppercase) that Stripe reports in
 * zero-decimal smallest-currency-units. For these, `amount` and friends in
 * the Stripe API are already in the whole-major-unit (yen, won, dong), not
 * a fractional sub-unit.
 *
 * Source: https://stripe.com/docs/currencies#zero-decimal
 *
 * UGX is included here even though it has historically been treated as
 * two-decimal in some places — Stripe normalizes it to zero-decimal.
 */
const ZERO_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF',
  'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/**
 * ISO 4217 currency codes Stripe reports in three-decimal smallest-currency-
 * units. These are charged in thousandths of the major unit (fils, etc.).
 *
 * Source: https://stripe.com/docs/currencies#three-decimal
 *
 * Note: although Stripe stores these in three-decimal precision, it only
 * accepts charges where the last digit is zero (i.e. effectively
 * two-decimal). The engine still treats them as integer smallest-units; the
 * exporter division is what we need to get right.
 */
const THREE_DECIMAL_CURRENCIES: ReadonlySet<string> = new Set([
  'BHD', 'JOD', 'KWD', 'OMR', 'TND',
]);

/**
 * Number of minor-unit digits for a given ISO 4217 currency code.
 *
 *   - 0 for zero-decimal currencies (JPY, KRW, etc.) — the smallest-currency-
 *     unit IS the major unit, so the exporter divides by 10^0 = 1.
 *   - 3 for three-decimal currencies (BHD, KWD, etc.) — exporter divides by
 *     10^3 = 1000.
 *   - 2 for everything else (USD, EUR, GBP, CAD, AUD, ...). This is also the
 *     fallback for currencies we don't recognize, which matches Stripe's
 *     default normalization.
 *
 * Input is case-insensitive; the function normalizes to uppercase.
 */
export function currencyMinorUnits(currency: string): number {
  const code = currency.toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

/**
 * Convert an integer smallest-currency-unit amount into a major-unit number
 * suitable for QBO/Xero export. Round-trips through `toFixed` to avoid IEEE-754
 * surprises like 0.1 + 0.2.
 *
 *   minorToMajor(10000, 'USD') === 100.00   // cents → dollars
 *   minorToMajor(10000, 'JPY') === 10000    // yen are already major units
 *   minorToMajor(1234,  'BHD') === 1.234    // fils → dinars
 */
export function minorToMajor(amount: number, currency: string): number {
  const decimals = currencyMinorUnits(currency);
  const divisor = 10 ** decimals;
  return Number((amount / divisor).toFixed(decimals));
}
