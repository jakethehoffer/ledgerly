import { createHash } from 'node:crypto';
import type { SavedScheduledEntry } from '../storage/types.js';

/** Stable across retries and database restores, distinct for every posting. */
export function dispatchIdentity(saved: SavedScheduledEntry): string {
  const entry = saved.entry;
  const identity = [
    entry.sourceEventId,
    entry.sourceEventType,
    entry.sourceObjectId ?? null,
    saved.subscriptionId,
    entry.date,
    entry.currency,
    entry.lines.map((line) => [line.accountCode, line.side, line.amount]),
  ];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 40);
}
