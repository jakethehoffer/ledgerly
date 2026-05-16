import { describe, it, expect } from 'vitest';
import { cents, ZERO_CENTS, type Cents } from '../src/money.js';

describe('cents()', () => {
  it('accepts integer input and returns a Cents-branded number', () => {
    const result: Cents = cents(123);
    expect(result).toBe(123);
  });

  it('accepts zero', () => {
    expect(cents(0)).toBe(0);
  });

  it('accepts negative integers', () => {
    expect(cents(-50)).toBe(-50);
  });

  it('rejects non-integer floats', () => {
    expect(() => cents(1.5)).toThrow(RangeError);
    expect(() => cents(1.5)).toThrow(/integer/i);
  });

  it('rejects NaN', () => {
    expect(() => cents(NaN)).toThrow(RangeError);
  });

  it('rejects Infinity', () => {
    expect(() => cents(Infinity)).toThrow(RangeError);
  });

  it('accepts Number.MAX_SAFE_INTEGER', () => {
    expect(cents(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects -Infinity', () => {
    expect(() => cents(-Infinity)).toThrow(RangeError);
  });

  it('ZERO_CENTS equals 0', () => {
    expect(ZERO_CENTS).toBe(0);
  });
});
