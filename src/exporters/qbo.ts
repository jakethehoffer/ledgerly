import { minorToMajor } from '../currency.js';
import type { JournalEntry, RecognitionSchedule, JournalLine } from '../journal.js';
import type { QboAccountMap } from './types.js';

export interface QboJournalEntry {
  TxnDate: string;
  DocNumber?: string;
  PrivateNote: string;
  /**
   * QBO posts the entry in the company file's home currency when this field
   * is omitted. With multi-currency enabled and a foreign-currency entry,
   * omitting CurrencyRef silently posts the wrong currency, so we always
   * include it — the field is a no-op for single-currency company files
   * (where it just matches home).
   */
  CurrencyRef: { value: string };
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

function truncateDocNumber(eventId: string): string {
  // Take the LAST 21 chars (Stripe IDs and our test IDs put unique entropy at
  // the suffix; slicing the prefix produces collisions for shared event-type
  // naming schemes). Full event ID is preserved in PrivateNote.
  return eventId.length <= QBO_DOCNUMBER_MAX ? eventId : eventId.slice(-QBO_DOCNUMBER_MAX);
}

function lineToQbo(
  line: JournalLine,
  accountMap: QboAccountMap,
  currency: string,
): QboLine {
  // Cast through Partial to preserve the runtime defensive check: even though
  // QboAccountMap's type says every AccountCode is present, callers can pass a
  // frozen object literal that omits keys (or has them as undefined).
  const ref = (accountMap as Partial<QboAccountMap>)[line.accountCode];
  if (!ref) {
    throw new Error(`QBO accountMap missing entry for account ${line.accountCode}`);
  }
  const qboLine: QboLine = {
    DetailType: 'JournalEntryLineDetail',
    Amount: minorToMajor(line.amount, currency),
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
    CurrencyRef: { value: entry.currency },
    Line: entry.lines.map((l) => lineToQbo(l, accountMap, entry.currency)),
  };
  out.DocNumber = truncateDocNumber(entry.sourceEventId);
  return out;
}

export function toQboSchedule(
  schedule: RecognitionSchedule,
  accountMap: QboAccountMap,
): QboJournalEntry[] {
  return schedule.entries.map((e, idx) => {
    const out = toQbo(e, accountMap);
    // Disambiguate DocNumber across the schedule's monthly entries. Every
    // recognition entry shares the same sourceEventId (the original invoice
    // event), so the default `truncate(sourceEventId)` would assign the
    // identical DocNumber to all 12 monthly entries — bad for reconciliation
    // and confusing in QBO's transaction list. Append a `-mNN` suffix so
    // each entry has a unique reference. Reserve the suffix length out of
    // the 21-char DocNumber budget to keep the value within QBO's limit.
    const monthLabel = `-m${String(idx + 1).padStart(2, '0')}`;
    const baseBudget = QBO_DOCNUMBER_MAX - monthLabel.length;
    const base = e.sourceEventId;
    const baseTruncated = base.length <= baseBudget ? base : base.slice(-baseBudget);
    out.DocNumber = baseTruncated + monthLabel;
    return out;
  });
}
