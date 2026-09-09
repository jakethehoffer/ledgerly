import { cents } from '../money.js';
import type { JournalEntry, RecognitionSchedule } from '../journal.js';
import { sortLines } from '../util/lines.js';

/**
 * Ledger arithmetic shared by the reconcilers that draw an invoice's
 * recognition schedule down: credit notes (`creditReconciler`) and cash refunds
 * (`refundReconciler`). Both read the same rows and re-spread the same way, so
 * the rounding lives here once rather than drifting between them.
 */

/**
 * The revenue a single recognition row moves out of deferred (2100) into
 * recognized (4000) — its 4000 credit. Summed over posted rows it is how much of
 * the schedule has recognized; over pending rows it is how much is still deferred.
 */
export function recognitionAmount(entry: JournalEntry): number {
  let total = 0;
  for (const line of entry.lines) {
    if (line.accountCode === '4000' && line.side === 'credit') {
      total += line.amount;
    }
  }
  return total;
}

/**
 * Reissue `newDeferred` cents across the still-pending recognition dates
 * (Decision 2 — even re-spread), floor + remainder with the last month absorbing
 * the remainder, exactly like `buildRecognitionSchedule`. Each reissued row keeps
 * its pending row's date and memo (same service month, reduced amount) and carries
 * `sourceObjectId = invoiceId` so a later credit, refund or void against the same
 * invoice still finds it. Returns `null` when nothing remains deferred or there are
 * no pending months (a full draw-down, or an already fully-recognized invoice).
 */
export function buildReducedSchedule(
  pending: ReadonlyArray<JournalEntry>,
  newDeferred: number,
  meta: {
    subscriptionId: string;
    sourceEventId: string;
    sourceEventType: string;
    invoiceId: string;
    currency: string;
  },
): RecognitionSchedule | null {
  if (pending.length === 0 || newDeferred <= 0) return null;
  const sorted = [...pending].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const n = sorted.length;
  const base = Math.floor(newDeferred / n);
  const remainder = newDeferred - base * n;
  const entries: JournalEntry[] = sorted.map((row, i) => {
    const amount = cents(i === n - 1 ? base + remainder : base);
    return {
      date: row.date,
      currency: meta.currency,
      memo: row.memo,
      sourceEventId: meta.sourceEventId,
      sourceEventType: meta.sourceEventType,
      sourceObjectId: meta.invoiceId,
      lines: sortLines([
        { accountCode: '2100', side: 'debit', amount, memo: 'Recognize from deferred' },
        { accountCode: '4000', side: 'credit', amount, memo: 'Subscription revenue' },
      ]),
    };
  });
  return { subscriptionId: meta.subscriptionId, sourceEventId: meta.sourceEventId, entries };
}
