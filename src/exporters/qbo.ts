import type { JournalEntry, RecognitionSchedule, JournalLine } from '../journal.js';
import type { QboAccountMap } from './types.js';

export interface QboJournalEntry {
  TxnDate: string;
  DocNumber?: string;
  PrivateNote: string;
  Line: ReadonlyArray<QboLine>;
}

export interface QboLine {
  DetailType: 'JournalEntryLineDetail';
  Amount: number;
  Description?: string;
  JournalEntryLineDetail: {
    PostingType: 'Debit' | 'Credit';
    AccountRef: { value: string; name: string };
  };
}

const QBO_DOCNUMBER_MAX = 21;

function centsToMajor(amount: number): number {
  // Round-trip through string to avoid 0.1 + 0.2 issues; integer cents → 2-decimal float.
  return Number((amount / 100).toFixed(2));
}

function truncateDocNumber(eventId: string): string {
  return eventId.length <= QBO_DOCNUMBER_MAX ? eventId : eventId.slice(0, QBO_DOCNUMBER_MAX);
}

function lineToQbo(line: JournalLine, accountMap: QboAccountMap): QboLine {
  // Cast through Partial to preserve the runtime defensive check: even though
  // QboAccountMap's type says every AccountCode is present, callers can pass a
  // frozen object literal that omits keys (or has them as undefined).
  const ref = (accountMap as Partial<QboAccountMap>)[line.accountCode];
  if (!ref) {
    throw new Error(`QBO accountMap missing entry for account ${line.accountCode}`);
  }
  const qboLine: QboLine = {
    DetailType: 'JournalEntryLineDetail',
    Amount: centsToMajor(line.amount),
    JournalEntryLineDetail: {
      PostingType: line.side === 'debit' ? 'Debit' : 'Credit',
      AccountRef: { value: ref.qboId, name: ref.name },
    },
  };
  if (line.memo !== undefined) qboLine.Description = line.memo;
  return qboLine;
}

export function toQbo(entry: JournalEntry, accountMap: QboAccountMap): QboJournalEntry {
  const out: QboJournalEntry = {
    TxnDate: entry.date,
    PrivateNote: entry.memo,
    Line: entry.lines.map((l) => lineToQbo(l, accountMap)),
  };
  out.DocNumber = truncateDocNumber(entry.sourceEventId);
  return out;
}

export function toQboSchedule(
  schedule: RecognitionSchedule,
  accountMap: QboAccountMap,
): QboJournalEntry[] {
  return schedule.entries.map((e) => toQbo(e, accountMap));
}
