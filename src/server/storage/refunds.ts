import type { JournalEntry } from '../../journal.js';
import type { JournalEntryStore } from './types.js';

export function isBookedRefund(entries: JournalEntryStore, entry: JournalEntry): boolean {
  return (
    entry.sourceEventType === 'charge.refunded' &&
    entry.sourceObjectId !== undefined &&
    entries
      .findImmediateBySourceObject(entry.sourceObjectId)
      .some((saved) => saved.entry.sourceEventType === 'charge.refunded')
  );
}

export function bookedRefundIds(
  entries: JournalEntryStore,
  refundIds: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set(
    refundIds.filter((refundId) =>
      entries
        .findImmediateBySourceObject(refundId)
        .some((saved) => saved.entry.sourceEventType === 'charge.refunded'),
    ),
  );
}
