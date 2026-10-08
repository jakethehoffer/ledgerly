// Read-only preview of a Stripe account's recent activity. Lists the events
// Ledgerly maps from the last few days, fetches the nested objects each one
// needs (the same expansion the receiver performs), and maps every event on its
// own. Nothing is stored and nothing is sent to accounting software.
import type Stripe from 'stripe';
import { mapEvent } from './engine.js';
import { HANDLERS } from './events/index.js';
import { handleInformational } from './events/informational.js';
import type { MapResult } from './journal.js';
import { expandEvent } from './server/expand.js';
import { formatMapResult } from './format.js';

/** Stripe's events list only reaches back 30 days. */
export const PREVIEW_MAX_DAYS = 30;

/**
 * Event types worth fetching: every handled type except the informational ones,
 * which never produce entries. Stripe accepts at most 20 types per list call.
 */
export const PREVIEW_EVENT_TYPES: readonly string[] = Object.keys(HANDLERS).filter(
  (type) => HANDLERS[type] !== handleInformational,
);

export type PreviewStripe = Stripe;

export interface PreviewItem {
  event: Stripe.Event;
  result?: MapResult;
  error?: string;
}

const DAY_SECONDS = 86_400;

/**
 * Fetch, expand and map the account's mappable events from the last `days`
 * days, oldest first. A failure on one event is recorded on that item and the
 * preview continues.
 */
export async function previewRecentEvents(
  stripe: PreviewStripe,
  opts: { days: number; now?: Date },
): Promise<PreviewItem[]> {
  const { days } = opts;
  if (!Number.isInteger(days) || days < 1 || days > PREVIEW_MAX_DAYS) {
    throw new Error(`Days must be a whole number between 1 and ${String(PREVIEW_MAX_DAYS)}`);
  }
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const gte = nowSeconds - days * DAY_SECONDS;

  const events: Stripe.Event[] = [];
  let startingAfter: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const page = await stripe.events.list({
      created: { gte },
      types: [...PREVIEW_EVENT_TYPES],
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    events.push(...page.data);
    hasMore = page.has_more;
    if (!hasMore) continue;
    const last = page.data.at(-1);
    if (!last || last.id === startingAfter) {
      throw new Error('Stripe event pagination did not advance');
    }
    startingAfter = last.id;
  }

  // Stripe lists newest first. Books read better oldest first.
  events.reverse();

  const items: PreviewItem[] = [];
  for (const event of events) {
    try {
      const expanded = await expandEvent(stripe, event);
      items.push({ event, result: mapEvent(expanded) });
    } catch (err) {
      items.push({ event, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return items;
}

const count = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? '' : 's'}`;

function hasEntries(result: MapResult): boolean {
  return result.entries.length > 0 || (result.schedule?.entries.length ?? 0) > 0;
}

/** Render a preview as readable text, one block per event, then a summary. */
export function formatPreview(items: readonly PreviewItem[], days: number): string {
  if (items.length === 0) {
    return (
      `No events Ledgerly maps were found in the last ${count(days, 'day')}.\n` +
      'Nothing was sent to QuickBooks or Xero.'
    );
  }

  const blocks = items.map((item) => {
    const date = new Date(item.event.created * 1000).toISOString().slice(0, 10);
    const header = `${item.event.id}  ${item.event.type}  ${date}`;
    const body = item.result ? formatMapResult(item.result) : `Could not map: ${item.error ?? 'unknown error'}`;
    return `${header}\n${body}`;
  });

  const mapped = items.filter((i) => i.result && hasEntries(i.result)).length;
  const noEntry = items.filter((i) => i.result && !hasEntries(i.result)).length;
  const failed = items.filter((i) => !i.result).length;
  const summary = [
    'SUMMARY',
    `${count(items.length, 'event')} from the last ${count(days, 'day')}. ` +
      `${String(mapped)} mapped, ${String(noEntry)} with no entry, ${String(failed)} could not be mapped.`,
    'Each event was mapped on its own. The receiver also uses saved history for plan changes,',
    'cancellations and refunds of annual plans, so its entries for those can differ.',
    'Nothing was sent to QuickBooks or Xero.',
  ].join('\n');

  return [...blocks, summary].join(`\n\n${'='.repeat(60)}\n\n`);
}
