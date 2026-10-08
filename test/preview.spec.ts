import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import { HANDLERS } from '../src/events/index.js';
import { handleInformational } from '../src/events/informational.js';
import {
  PREVIEW_EVENT_TYPES,
  PREVIEW_MAX_DAYS,
  formatPreview,
  previewRecentEvents,
  type PreviewStripe,
} from '../src/preview.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

function loadEvent(name: string): Stripe.Event {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${name}.event.json`), 'utf8'),
  ) as Stripe.Event;
}

/** A charge event as `events.list` returns it: the balance transaction is only an ID. */
function unexpandedCharge(id: string, created: number): { listed: Stripe.Event; expanded: Stripe.Charge } {
  const full = loadEvent('charge_succeeded_standard');
  const expanded = { ...(full.data.object as Stripe.Charge), id: `ch_${id}` };
  const listed = {
    ...full,
    id: `evt_${id}`,
    created,
    data: { object: { ...expanded, balance_transaction: 'txn_only_an_id' } },
  } as unknown as Stripe.Event;
  return { listed, expanded };
}

function fakeStripe(
  pages: Array<{ data: Stripe.Event[]; has_more: boolean }>,
  charges: Stripe.Charge[],
): { stripe: PreviewStripe; list: ReturnType<typeof vi.fn>; retrieve: ReturnType<typeof vi.fn> } {
  const list = vi.fn();
  for (const page of pages) list.mockResolvedValueOnce(page);
  const retrieve = vi.fn((id: string) => {
    const charge = charges.find((c) => c.id === id);
    return charge ? Promise.resolve(charge) : Promise.reject(new Error(`No such charge: ${id}`));
  });
  const stripe = { events: { list }, charges: { retrieve } } as unknown as PreviewStripe;
  return { stripe, list, retrieve };
}

const NOW = new Date('2026-10-07T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

describe('preview: event types requested from Stripe', () => {
  it('asks only for types that can produce entries, within Stripe’s 20-type limit', () => {
    expect(PREVIEW_EVENT_TYPES.length).toBeGreaterThan(0);
    expect(PREVIEW_EVENT_TYPES.length).toBeLessThanOrEqual(20);
    for (const type of PREVIEW_EVENT_TYPES) {
      expect(HANDLERS[type]).toBeDefined();
      expect(HANDLERS[type]).not.toBe(handleInformational);
    }
    const informational = Object.keys(HANDLERS).filter((t) => HANDLERS[t] === handleInformational);
    expect(informational.length).toBeGreaterThan(0);
    for (const type of informational) expect(PREVIEW_EVENT_TYPES).not.toContain(type);
  });
});

describe('preview: previewRecentEvents', () => {
  it('lists events from the chosen window, pages through them, and returns them oldest first', async () => {
    const a = unexpandedCharge('a', NOW_SECONDS - 3 * 86_400);
    const b = unexpandedCharge('b', NOW_SECONDS - 2 * 86_400);
    const c = unexpandedCharge('c', NOW_SECONDS - 86_400);
    // Stripe lists newest first.
    const { stripe, list } = fakeStripe(
      [
        { data: [c.listed, b.listed], has_more: true },
        { data: [a.listed], has_more: false },
      ],
      [a.expanded, b.expanded, c.expanded],
    );

    const items = await previewRecentEvents(stripe, { days: 7, now: NOW });

    expect(list).toHaveBeenCalledTimes(2);
    expect(list.mock.calls[0]?.[0]).toEqual({
      created: { gte: NOW_SECONDS - 7 * 86_400 },
      types: PREVIEW_EVENT_TYPES,
      limit: 100,
    });
    expect(list.mock.calls[1]?.[0]).toMatchObject({ starting_after: 'evt_b' });
    expect(items.map((i) => i.event.id)).toEqual(['evt_a', 'evt_b', 'evt_c']);
  });

  it('expands each event before mapping it, so a plain Stripe event becomes a balanced entry', async () => {
    const a = unexpandedCharge('a', NOW_SECONDS - 86_400);
    const { stripe, retrieve } = fakeStripe([{ data: [a.listed], has_more: false }], [a.expanded]);

    const [item] = await previewRecentEvents(stripe, { days: 30, now: NOW });

    expect(retrieve).toHaveBeenCalledWith('ch_a', expect.objectContaining({ expand: expect.any(Array) }));
    expect(item?.error).toBeUndefined();
    expect(item?.result?.entries).toHaveLength(1);
  });

  it('records a failure on one event and keeps going', async () => {
    const good = unexpandedCharge('good', NOW_SECONDS - 2 * 86_400);
    const bad = unexpandedCharge('bad', NOW_SECONDS - 86_400);
    const { stripe } = fakeStripe([{ data: [bad.listed, good.listed], has_more: false }], [good.expanded]);

    const items = await previewRecentEvents(stripe, { days: 30, now: NOW });

    expect(items).toHaveLength(2);
    expect(items[0]?.result?.entries).toHaveLength(1);
    expect(items[1]?.result).toBeUndefined();
    expect(items[1]?.error).toContain('No such charge');
  });

  it('refuses a window Stripe cannot supply', async () => {
    const { stripe, list } = fakeStripe([], []);
    await expect(previewRecentEvents(stripe, { days: 0, now: NOW })).rejects.toThrow(/between 1 and 30/);
    await expect(previewRecentEvents(stripe, { days: PREVIEW_MAX_DAYS + 1, now: NOW })).rejects.toThrow(
      /between 1 and 30/,
    );
    await expect(previewRecentEvents(stripe, { days: 2.5, now: NOW })).rejects.toThrow(/between 1 and 30/);
    expect(list).not.toHaveBeenCalled();
  });

  it('stops if Stripe returns a page that does not move forward', async () => {
    const a = unexpandedCharge('a', NOW_SECONDS - 86_400);
    const { stripe } = fakeStripe(
      [
        { data: [a.listed], has_more: true },
        { data: [a.listed], has_more: true },
      ],
      [a.expanded],
    );
    await expect(previewRecentEvents(stripe, { days: 30, now: NOW })).rejects.toThrow(/did not advance/);
  });
});

describe('preview: formatPreview', () => {
  it('shows each event, a summary, and says nothing was sent', async () => {
    const good = unexpandedCharge('good', NOW_SECONDS - 2 * 86_400);
    const bad = unexpandedCharge('bad', NOW_SECONDS - 86_400);
    const { stripe } = fakeStripe([{ data: [bad.listed, good.listed], has_more: false }], [good.expanded]);
    const items = await previewRecentEvents(stripe, { days: 30, now: NOW });

    const out = formatPreview(items, 30);

    expect(out).toContain('evt_good');
    expect(out).toContain('charge.succeeded');
    expect(out).toContain('1010 Stripe Clearing');
    expect(out).toContain('evt_bad');
    expect(out).toContain('Could not map');
    expect(out).toMatch(/2 events from the last 30 days/);
    expect(out).toMatch(/1 mapped/);
    expect(out).toMatch(/1 could not be mapped/);
    expect(out).toMatch(/Nothing was sent to QuickBooks or Xero/);
  });

  it('uses singular words for one event and one day', async () => {
    const one = unexpandedCharge('one', NOW_SECONDS - 3600);
    const { stripe } = fakeStripe([{ data: [one.listed], has_more: false }], [one.expanded]);
    const items = await previewRecentEvents(stripe, { days: 1, now: NOW });
    const out = formatPreview(items, 1);
    expect(out).toMatch(/1 event from the last 1 day\./);
    expect(formatPreview([], 1)).toMatch(/in the last 1 day\./);
  });

  it('says plainly when the window had no events', () => {
    expect(formatPreview([], 7)).toMatch(/No events Ledgerly maps were found in the last 7 days/);
  });
});
