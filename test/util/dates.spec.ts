import { describe, it, expect } from 'vitest';
import { addMonths, epochToUtcDate } from '../../src/util/dates.js';

describe('epochToUtcDate', () => {
  it('converts a known epoch to ISO date', () => {
    // 2025-01-15T12:00:00Z = 1736942400
    expect(epochToUtcDate(1736942400)).toBe('2025-01-15');
  });

  it('handles midnight UTC', () => {
    // 2025-01-15T00:00:00Z = 1736899200
    expect(epochToUtcDate(1736899200)).toBe('2025-01-15');
  });

  it('rejects non-finite epochs', () => {
    expect(() => epochToUtcDate(NaN)).toThrow(RangeError);
    expect(() => epochToUtcDate(Infinity)).toThrow(RangeError);
    expect(() => epochToUtcDate(-Infinity)).toThrow(RangeError);
  });
});

describe('addMonths', () => {
  it('adds one month within a year', () => {
    expect(addMonths('2025-01-15', 1)).toBe('2025-02-15');
  });

  it('rolls over year on December + 1', () => {
    expect(addMonths('2025-12-15', 1)).toBe('2026-01-15');
  });

  it('adds twelve months (annual schedule end)', () => {
    expect(addMonths('2025-01-15', 12)).toBe('2026-01-15');
  });

  it('clamps Jan 31 + 1 to Feb 28 (non-leap)', () => {
    expect(addMonths('2025-01-31', 1)).toBe('2025-02-28');
  });

  it('clamps Jan 31 + 1 to Feb 29 (leap year)', () => {
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
  });

  it('clamps Mar 31 + 1 to Apr 30', () => {
    expect(addMonths('2025-03-31', 1)).toBe('2025-04-30');
  });

  it('handles negative months: Mar 15 - 3 = Dec 15 prior year', () => {
    expect(addMonths('2025-03-15', -3)).toBe('2024-12-15');
  });

  it('handles negative months across year boundary: Jan 15 - 13 = Dec 15 two years prior', () => {
    expect(addMonths('2025-01-15', -13)).toBe('2023-12-15');
  });

  it('rejects malformed ISO dates', () => {
    expect(() => addMonths('2025-1-15', 1)).toThrow(RangeError);
    expect(() => addMonths('not-a-date', 1)).toThrow(RangeError);
  });
});
