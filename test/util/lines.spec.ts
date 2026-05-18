import { describe, it, expect } from 'vitest';
import { sortLines } from '../../src/util/lines.js';
import { cents } from '../../src/money.js';
import type { JournalLine } from '../../src/journal.js';

/**
 * sortLines is exercised by every handler, but the amount-descending
 * tiebreaker (line 12 of lines.ts) only fires when an entry has TWO lines
 * on the SAME (side, accountCode) — which the production fixtures don't
 * happen to produce. Direct tests here exercise that fallback so the
 * sorting contract stays stable.
 */

describe('sortLines', () => {
  it('returns an empty array unchanged', () => {
    expect(sortLines([])).toEqual([]);
  });

  it('debits come before credits', () => {
    const out = sortLines([
      { accountCode: '4000', side: 'credit', amount: cents(100) },
      { accountCode: '1010', side: 'debit', amount: cents(100) },
    ]);
    expect(out.map((l) => l.side)).toEqual(['debit', 'credit']);
  });

  it('within a side, ascending by accountCode', () => {
    const out = sortLines([
      { accountCode: '6000', side: 'debit', amount: cents(100) },
      { accountCode: '1010', side: 'debit', amount: cents(100) },
    ]);
    expect(out.map((l) => l.accountCode)).toEqual(['1010', '6000']);
  });

  it('on tied (side, accountCode), amount descending — the otherwise-uncovered tiebreaker', () => {
    const out = sortLines([
      { accountCode: '1010', side: 'debit', amount: cents(100), memo: 'small' },
      { accountCode: '1010', side: 'debit', amount: cents(500), memo: 'big' },
      { accountCode: '1010', side: 'debit', amount: cents(300), memo: 'medium' },
    ]);
    expect(out.map((l) => l.amount)).toEqual([cents(500), cents(300), cents(100)]);
    expect(out.map((l) => l.memo)).toEqual(['big', 'medium', 'small']);
  });

  it('does not mutate the input array', () => {
    const input: JournalLine[] = [
      { accountCode: '4000', side: 'credit', amount: cents(100) },
      { accountCode: '1010', side: 'debit', amount: cents(100) },
    ];
    const snapshot = [...input];
    sortLines(input);
    expect(input).toEqual(snapshot);
  });

  it('produces a stable full ordering across debits + credits + same-account ties', () => {
    const out = sortLines([
      { accountCode: '4000', side: 'credit', amount: cents(100) },
      { accountCode: '1010', side: 'debit', amount: cents(300) },
      { accountCode: '6000', side: 'debit', amount: cents(50) },
      { accountCode: '1010', side: 'debit', amount: cents(200) },
    ]);
    expect(out.map((l) => `${l.side}:${l.accountCode}:${String(l.amount)}`)).toEqual([
      'debit:1010:300',
      'debit:1010:200',
      'debit:6000:50',
      'credit:4000:100',
    ]);
  });
});
