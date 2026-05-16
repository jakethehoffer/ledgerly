import { describe, it, expect } from 'vitest';
import { cents } from '../src/money.js';
import { checkBalance, assertBalanced, type JournalEntry } from '../src/journal.js';

const baseEntry = (lines: JournalEntry['lines']): JournalEntry => ({
  date: '2025-01-15',
  currency: 'USD',
  memo: 'test entry',
  sourceEventId: 'evt_test_001',
  sourceEventType: 'charge.succeeded',
  lines,
});

describe('checkBalance', () => {
  it('reports a balanced 2-line entry', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10000) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    const report = checkBalance(entry);
    expect(report.balanced).toBe(true);
    expect(report.debitTotal).toBe(10000);
    expect(report.creditTotal).toBe(10000);
    expect(report.difference).toBe(0);
  });

  it('reports a balanced 3-line entry (charge with fee)', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(9680) },
      { accountCode: '6000', side: 'debit', amount: cents(320) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    expect(checkBalance(entry).balanced).toBe(true);
  });

  it('reports unbalanced when debits exceed credits', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10001) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    const report = checkBalance(entry);
    expect(report.balanced).toBe(false);
    expect(report.difference).toBe(1);
  });

  it('reports unbalanced when credits exceed debits', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10000) },
      { accountCode: '4000', side: 'credit', amount: cents(10001) },
    ]);
    const report = checkBalance(entry);
    expect(report.balanced).toBe(false);
    expect(report.difference).toBe(-1);
  });

  it('handles empty lines as balanced zero', () => {
    const entry = baseEntry([]);
    const report = checkBalance(entry);
    expect(report.balanced).toBe(true);
    expect(report.debitTotal).toBe(0);
    expect(report.creditTotal).toBe(0);
  });
});

describe('assertBalanced', () => {
  it('does not throw for a balanced entry', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10000) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    expect(() => {
      assertBalanced(entry);
    }).not.toThrow();
  });

  it('throws with diagnostic info for an unbalanced entry', () => {
    const entry = baseEntry([
      { accountCode: '1010', side: 'debit', amount: cents(10001) },
      { accountCode: '4000', side: 'credit', amount: cents(10000) },
    ]);
    expect(() => {
      assertBalanced(entry);
    }).toThrow(/unbalanced/i);
    expect(() => {
      assertBalanced(entry);
    }).toThrow(/evt_test_001/);
    expect(() => {
      assertBalanced(entry);
    }).toThrow(/1/); // difference
  });
});
