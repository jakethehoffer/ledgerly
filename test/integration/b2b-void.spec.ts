import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import type { JournalEntry } from '../../src/journal.js';
import { mapEvent } from '../../src/engine.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';
import { buildVoidReconcileInput } from '../../src/server/voidReconciler.js';
import { voidHasDeferredSchedule } from '../../src/events/invoices/invoiceVoided.js';
import { computeBalances } from '../helpers/balances.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadEvent(name: string): Stripe.Event {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${name}.event.json`), 'utf8'),
  ) as Stripe.Event;
}

const SUB_ID = 'sub_test_finalized_b2b_annual_001';
const INVOICE_ID = 'in_test_finalized_b2b_annual_001';

/**
 * The stateful half of `invoice.voided`: a net-terms invoice whose finalization
 * deferred revenue to a recognition schedule. The pure engine refuses it; the
 * server reconciles it against the ledger. This drives the real storage +
 * reconciler through a finalize → recognize-a-few-months → void lifecycle and
 * proves every account the invoice touched returns to zero.
 */
describe('integration: B2B void with a partially-recognized deferred schedule', () => {
  it('reverses the receivable, recognized revenue, and remaining deferred to zero; cancels the rest', () => {
    const storage = inMemoryStorage();

    // 1. Finalize the annual invoice: books Dr 1100 / Cr 2100 $1,200 and a
    //    12-month recognition schedule (2100 → 4000, $100/mo).
    const finalized = loadEvent('invoice_finalized_send_invoice_annual');
    storage.persistMapResult(finalized.id, mapEvent(finalized));

    // 2. Three months recognize before the void arrives.
    const scheduleRows = storage.entries
      .findScheduledBySubscription(SUB_ID)
      .filter((row) => row.entry.sourceObjectId === INVOICE_ID);
    expect(scheduleRows).toHaveLength(12);
    for (const row of scheduleRows.slice(0, 3)) {
      storage.entries.markScheduledPosted(row.id);
    }

    // 3. Void the invoice. It carries a deferred schedule, so the server path
    //    (reconciler + stateful persist) handles it rather than the engine.
    const voided = loadEvent('invoice_finalized_send_invoice_annual');
    (voided as { type: string }).type = 'invoice.voided';
    (voided as { id: string }).id = 'evt_void_annual_partial';
    expect(voidHasDeferredSchedule(voided.data.object as Stripe.Invoice)).toBe(true);
    const persistResult = storage.persistVoidReversal(
      voided.id,
      buildVoidReconcileInput(voided),
    );
    expect(persistResult).toEqual({ duplicate: false });

    // 4. The ledger = every immediate journal entry + the recognition entries
    //    that actually posted. Sum them and confirm the invoice nets to zero.
    const ledger: JournalEntry[] = [
      ...storage.entries.findByEventId(finalized.id).map((r) => r.entry),
      ...storage.entries.findByEventId(voided.id).map((r) => r.entry),
      ...storage.entries.listScheduledByStatus('posted').map((r) => r.entry),
    ];
    const balances: Partial<Record<string, number>> = computeBalances(ledger);

    expect(balances['1100']).toBeUndefined(); // receivable cleared
    expect(balances['2100']).toBeUndefined(); // no deferred revenue left
    expect(balances['4000']).toBeUndefined(); // recognized revenue reversed
    const total = Object.values(balances).reduce<number>((a, v) => a + (v ?? 0), 0);
    expect(total).toBe(0);

    // 5. The nine unposted months are cancelled — the scheduler will never
    //    recognize revenue against the voided invoice again.
    expect(storage.entries.listScheduledByStatus('cancelled')).toHaveLength(9);
    expect(storage.entries.listScheduledByStatus('posted')).toHaveLength(3);
  });

  it('voiding immediately after finalization (nothing recognized yet) reverses cleanly', () => {
    const storage = inMemoryStorage();

    const finalized = loadEvent('invoice_finalized_send_invoice_annual');
    storage.persistMapResult(finalized.id, mapEvent(finalized));

    // No months recognized. Void reverses Dr 2100 / Cr 1100 for the full gross.
    const voided = loadEvent('invoice_finalized_send_invoice_annual');
    (voided as { type: string }).type = 'invoice.voided';
    (voided as { id: string }).id = 'evt_void_annual_immediate';
    storage.persistVoidReversal(voided.id, buildVoidReconcileInput(voided));

    const ledger: JournalEntry[] = [
      ...storage.entries.findByEventId(finalized.id).map((r) => r.entry),
      ...storage.entries.findByEventId(voided.id).map((r) => r.entry),
      ...storage.entries.listScheduledByStatus('posted').map((r) => r.entry),
    ];
    const balances = computeBalances(ledger);

    expect(balances['1100']).toBeUndefined();
    expect(balances['2100']).toBeUndefined();
    expect(balances['4000']).toBeUndefined();
    // All twelve months cancelled — none recognized.
    expect(storage.entries.listScheduledByStatus('cancelled')).toHaveLength(12);
    expect(storage.entries.listScheduledByStatus('posted')).toHaveLength(0);
  });
});
