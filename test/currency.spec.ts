import { describe, it, expect } from 'vitest';
import { currencyMinorUnits, minorToMajor } from '../src/currency.js';

describe('currencyMinorUnits', () => {
  it('returns 2 for common two-decimal currencies', () => {
    for (const code of ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK']) {
      expect(currencyMinorUnits(code)).toBe(2);
    }
  });

  it('returns 0 for zero-decimal currencies', () => {
    for (const code of ['JPY', 'KRW', 'VND', 'CLP', 'BIF', 'DJF', 'UGX']) {
      expect(currencyMinorUnits(code)).toBe(0);
    }
  });

  it('returns 3 for three-decimal currencies', () => {
    for (const code of ['BHD', 'JOD', 'KWD', 'OMR', 'TND']) {
      expect(currencyMinorUnits(code)).toBe(3);
    }
  });

  it('is case-insensitive', () => {
    expect(currencyMinorUnits('usd')).toBe(2);
    expect(currencyMinorUnits('jpy')).toBe(0);
    expect(currencyMinorUnits('kwd')).toBe(3);
    expect(currencyMinorUnits('Usd')).toBe(2);
  });

  it('falls back to 2 for unknown currencies', () => {
    expect(currencyMinorUnits('ZZZ')).toBe(2);
    expect(currencyMinorUnits('XYZ')).toBe(2);
  });
});

describe('minorToMajor', () => {
  it('divides by 100 for two-decimal currencies', () => {
    expect(minorToMajor(10000, 'USD')).toBe(100);
    expect(minorToMajor(9680, 'USD')).toBe(96.8);
    expect(minorToMajor(320, 'USD')).toBe(3.2);
    expect(minorToMajor(1, 'EUR')).toBe(0.01);
  });

  it('passes through unchanged for zero-decimal currencies', () => {
    expect(minorToMajor(12000, 'JPY')).toBe(12000);
    expect(minorToMajor(50000, 'KRW')).toBe(50000);
    expect(minorToMajor(1, 'JPY')).toBe(1);
  });

  it('divides by 1000 for three-decimal currencies', () => {
    expect(minorToMajor(1000, 'BHD')).toBe(1);
    expect(minorToMajor(1234, 'KWD')).toBe(1.234);
    expect(minorToMajor(500, 'JOD')).toBe(0.5);
  });

  it('handles zero correctly across all currency classes', () => {
    expect(minorToMajor(0, 'USD')).toBe(0);
    expect(minorToMajor(0, 'JPY')).toBe(0);
    expect(minorToMajor(0, 'BHD')).toBe(0);
  });

  it('returns exact representable doubles for individual conversions', () => {
    // toFixed round-trip pins each call to the nearest representable double
    // at the expected precision — no accidental 0.09999999... or
    // 0.10000001 from raw division. (Summing two floats is still the
    // caller's problem; this guarantees per-call exactness only.)
    expect(minorToMajor(10, 'USD')).toBe(0.1);
    expect(minorToMajor(30, 'USD')).toBe(0.3);
    expect(minorToMajor(1234, 'BHD')).toBe(1.234);
  });
});
