import type { JournalLine } from '../journal.js';

/**
 * Sort journal lines deterministically: debits first, then credits.
 * Within each side, ascending by account code, then by amount descending
 * (the latter only matters for entries with multiple lines on the same account).
 */
export function sortLines(lines: ReadonlyArray<JournalLine>): ReadonlyArray<JournalLine> {
  return [...lines].sort((a, b) => {
    if (a.side !== b.side) return a.side === 'debit' ? -1 : 1;
    if (a.accountCode !== b.accountCode) return a.accountCode < b.accountCode ? -1 : 1;
    return b.amount - a.amount;
  });
}
