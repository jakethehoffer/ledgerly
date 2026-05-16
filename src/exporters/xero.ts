import type { JournalEntry, JournalLine, RecognitionSchedule } from '../journal.js';
import type { XeroAccountMap } from './types.js';

export interface XeroManualJournal {
  Narration: string;
  Date: string;
  Status: 'DRAFT' | 'POSTED';
  JournalLines: ReadonlyArray<XeroJournalLine>;
}

export interface XeroJournalLine {
  LineAmount: number; // signed: + = debit, − = credit
  AccountCode: string;
  Description?: string;
}

function centsToMajor(amount: number): number {
  // Round-trip through string to avoid 0.1 + 0.2 issues; integer cents → 2-decimal float.
  return Number((amount / 100).toFixed(2));
}

function lineToXero(line: JournalLine, accountMap: XeroAccountMap): XeroJournalLine {
  // Cast through Partial to preserve the runtime defensive check: even though
  // XeroAccountMap's type says every AccountCode is present, callers can pass a
  // frozen object literal that omits keys (or has them as undefined).
  const ref = (accountMap as Partial<XeroAccountMap>)[line.accountCode];
  if (!ref) {
    throw new Error(`Xero accountMap missing entry for account ${line.accountCode}`);
  }
  const signed = line.side === 'debit' ? centsToMajor(line.amount) : -centsToMajor(line.amount);
  const out: XeroJournalLine = {
    LineAmount: signed,
    AccountCode: ref.accountCode,
  };
  if (line.memo !== undefined) out.Description = line.memo;
  return out;
}

export function toXero(
  entry: JournalEntry,
  accountMap: XeroAccountMap,
  status: 'DRAFT' | 'POSTED' = 'DRAFT',
): XeroManualJournal {
  return {
    Narration: entry.memo,
    Date: entry.date,
    Status: status,
    JournalLines: entry.lines.map((l) => lineToXero(l, accountMap)),
  };
}

export function toXeroSchedule(
  schedule: RecognitionSchedule,
  accountMap: XeroAccountMap,
  status: 'DRAFT' | 'POSTED' = 'DRAFT',
): XeroManualJournal[] {
  return schedule.entries.map((e) => toXero(e, accountMap, status));
}
