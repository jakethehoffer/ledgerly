import { minorToMajor } from '../currency.js';
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

function lineToXero(
  line: JournalLine,
  accountMap: XeroAccountMap,
  currency: string,
): XeroJournalLine {
  // Cast through Partial to preserve the runtime defensive check: even though
  // XeroAccountMap's type says every AccountCode is present, callers can pass a
  // frozen object literal that omits keys (or has them as undefined).
  const ref = (accountMap as Partial<XeroAccountMap>)[line.accountCode];
  if (!ref) {
    throw new Error(`Xero accountMap missing entry for account ${line.accountCode}`);
  }
  const major = minorToMajor(line.amount, currency);
  const signed = line.side === 'debit' ? major : -major;
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
    JournalLines: entry.lines.map((l) => lineToXero(l, accountMap, entry.currency)),
  };
}

export function toXeroSchedule(
  schedule: RecognitionSchedule,
  accountMap: XeroAccountMap,
  status: 'DRAFT' | 'POSTED' = 'DRAFT',
): XeroManualJournal[] {
  return schedule.entries.map((e) => toXero(e, accountMap, status));
}
