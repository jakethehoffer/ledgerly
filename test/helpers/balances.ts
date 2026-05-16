import type { JournalEntry, MapResult } from '../../src/journal.js';
import type { AccountCode } from '../../src/accounts.js';

/**
 * Sum journal entries into per-account net balances.
 *
 * Returns a partial record keyed by `AccountCode`. Account values are signed
 * integer cents where positive = net debit (asset/expense side) and negative
 * = net credit (liability/revenue side). The sum across all accounts must
 * equal zero if every entry balances — that's the cross-entry invariant
 * this helper makes visible.
 *
 * Accounts with zero net balance are omitted from the result.
 */
export function computeBalances(
  entries: ReadonlyArray<JournalEntry>,
): Partial<Record<AccountCode, number>> {
  const running: Partial<Record<AccountCode, number>> = {};
  for (const entry of entries) {
    for (const line of entry.lines) {
      const sign = line.side === 'debit' ? 1 : -1;
      const current = running[line.accountCode] ?? 0;
      running[line.accountCode] = current + sign * line.amount;
    }
  }
  // Build the result excluding zero-valued entries (rather than deleting in place,
  // which lint forbids via @typescript-eslint/no-dynamic-delete).
  const balances: Partial<Record<AccountCode, number>> = {};
  for (const [code, val] of Object.entries(running) as [AccountCode, number][]) {
    if (val !== 0) balances[code] = val;
  }
  return balances;
}

/**
 * Aggregate all entries from a single MapResult, flattening the optional
 * schedule into the entries list.
 */
export function flattenMapResult(result: MapResult): JournalEntry[] {
  return [...result.entries, ...(result.schedule?.entries ?? [])];
}
