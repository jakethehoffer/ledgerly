import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type Stripe from 'stripe';
import type { JournalEntry } from '../../src/journal.js';
import { mapEvent } from '../../src/engine.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';
import {
  buildCreditReconcileInput,
  buildCreditVoidReconcileInput,
  creditNoteVoidNeedsReconcile,
} from '../../src/server/creditReconciler.js';
import { creditNoteHasDeferredSchedule } from '../../src/events/creditNotes/shared.js';
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
 * Build a `credit_note.created` event against the annual finalized B2B invoice
 * (`invoice_finalized_send_invoice_annual`), so the reconciler finds that
 * invoice's 12-month recognition schedule. `type` selects the shape:
 * `pre_payment` credits the receivable (1100); `post_payment` to balance credits
 * 2200.
 */
function creditNoteAgainstAnnual(opts: {
  eventId: string;
  type: 'pre_payment' | 'post_payment';
  subtotal: number;
  tax: number;
}): Stripe.Event {
  const finalized = loadEvent('invoice_finalized_send_invoice_annual');
  const invoice = JSON.parse(JSON.stringify(finalized.data.object)) as Stripe.Invoice;
  const isBalance = opts.type === 'post_payment';
  return {
    id: opts.eventId,
    object: 'event',
    type: 'credit_note.created',
    created: 1745000000,
    data: {
      object: {
        id: `cn_${opts.eventId}`,
        object: 'credit_note',
        type: opts.type,
        status: 'issued',
        currency: 'usd',
        amount: opts.subtotal,
        subtotal: opts.subtotal,
        total: opts.subtotal + opts.tax,
        out_of_band_amount: null,
        refund: null,
        customer_balance_transaction: isBalance ? 'cbtxn_test_001' : null,
        customer: invoice.customer,
        created: 1745000000,
        invoice,
      },
    },
  } as unknown as Stripe.Event;
}

function scheduleRows(storage: ReturnType<typeof inMemoryStorage>) {
  return storage.entries
    .findScheduledBySubscription(SUB_ID)
    .filter((row) => row.entry.sourceObjectId === INVOICE_ID);
}

/**
 * The stateful half of a credit note: a `credit_note.created` against a net-terms
 * invoice whose finalization deferred revenue to a recognition schedule. The pure
 * engine refuses it; the server reconciles it against the ledger — reducing the
 * deferred balance first (Decision 1), re-spreading the remaining schedule
 * (Decision 2), and only clawing back recognized revenue when the credit exceeds
 * all remaining deferred.
 */
describe('integration: deferred-schedule credit reconciliation (draw-down)', () => {
  it('pre-payment credit within the remaining deferred: reduces 2100 and re-spreads the schedule, no revenue clawback', () => {
    const storage = inMemoryStorage();

    // 1. Finalize the annual invoice: Dr 1100 / Cr 2100 $1,200 + a 12-month
    //    schedule at $100/mo.
    const finalized = loadEvent('invoice_finalized_send_invoice_annual');
    storage.persistMapResult(finalized.id, mapEvent(finalized));

    // 2. Three months recognize ($300 → 4000; $900 still deferred across 9 rows).
    const pending = scheduleRows(storage);
    expect(pending).toHaveLength(12);
    for (const row of pending.slice(0, 3)) storage.entries.markScheduledPosted(row.id);

    // 3. A pre-payment credit note for $300 (no tax) arrives.
    const credit = creditNoteAgainstAnnual({
      eventId: 'evt_credit_annual_prepay',
      type: 'pre_payment',
      subtotal: 30000,
      tax: 0,
    });
    const cn = credit.data.object as Stripe.CreditNote;
    expect(creditNoteHasDeferredSchedule(cn, cn.invoice as Stripe.Invoice)).toBe(true);
    const persistResult = storage.persistCreditReversal(
      credit.id,
      buildCreditReconcileInput(credit),
    );
    expect(persistResult).toEqual({ duplicate: false });

    // 4. The immediate reversal reduces the deferred balance only — the $300 is
    //    fully absorbed by the $900 still deferred, so no revenue is clawed back.
    const reversal = storage.entries.findByEventId(credit.id).map((r) => r.entry);
    expect(reversal).toHaveLength(1);
    const rev = computeBalances(reversal);
    expect(rev['2100']).toBe(30000); // Dr 2100 (deferred reduced)
    expect(rev['1100']).toBe(-30000); // Cr 1100 (receivable reduced)
    expect(rev['4000']).toBeUndefined(); // no clawback of recognized revenue

    // 5. The 9 old pending rows are cancelled; 9 new pending rows re-spread the
    //    remaining $600 ($900 − $300).
    const rows = scheduleRows(storage);
    const cancelled = rows.filter((r) => r.status === 'cancelled');
    const reissued = rows.filter((r) => r.status === 'pending');
    expect(cancelled).toHaveLength(9);
    expect(reissued).toHaveLength(9);
    const reissuedTotal = reissued.reduce(
      (s, r) => s + r.entry.lines.filter((l) => l.accountCode === '4000').reduce((a, l) => a + l.amount, 0),
      0,
    );
    expect(reissuedTotal).toBe(60000);

    // 6. Once the re-spread schedule posts, the invoice's lifetime numbers are the
    //    reduced contract: 4000 recognized $900 (= $1,200 − $300), 2100 drained,
    //    1100 still owed $900.
    for (const row of reissued) storage.entries.markScheduledPosted(row.id);
    const ledger: JournalEntry[] = [
      ...storage.entries.findByEventId(finalized.id).map((r) => r.entry),
      ...storage.entries.findByEventId(credit.id).map((r) => r.entry),
      ...storage.entries.listScheduledByStatus('posted').map((r) => r.entry),
    ];
    const balances = computeBalances(ledger);
    expect(balances['4000']).toBe(-90000); // recognized exactly the reduced contract
    expect(balances['2100']).toBeUndefined(); // deferred fully drained
    expect(balances['1100']).toBe(90000); // reduced receivable still owed
  });

  it('pre-payment credit exceeding the remaining deferred claws back recognized revenue (Dr 4000)', () => {
    const storage = inMemoryStorage();
    const finalized = loadEvent('invoice_finalized_send_invoice_annual');
    storage.persistMapResult(finalized.id, mapEvent(finalized));

    // Ten months recognize: $1,000 → 4000, $200 still deferred across 2 rows.
    const pending = scheduleRows(storage);
    for (const row of pending.slice(0, 10)) storage.entries.markScheduledPosted(row.id);

    // A $300 credit exceeds the $200 remaining deferred by $100 → claw back $100.
    const credit = creditNoteAgainstAnnual({
      eventId: 'evt_credit_annual_clawback',
      type: 'pre_payment',
      subtotal: 30000,
      tax: 0,
    });
    storage.persistCreditReversal(credit.id, buildCreditReconcileInput(credit));

    const rev = computeBalances(storage.entries.findByEventId(credit.id).map((r) => r.entry));
    expect(rev['2100']).toBe(20000); // all remaining deferred removed
    expect(rev['4000']).toBe(10000); // $100 clawed back from recognized revenue
    expect(rev['1100']).toBe(-30000); // receivable reduced by the full credit

    // No deferred remains, so nothing is re-spread — both pending rows cancelled.
    const rows = scheduleRows(storage);
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'pending')).toHaveLength(0);
  });

  it('post-payment-to-balance credit against a deferred invoice credits 2200 instead of 1100', () => {
    const storage = inMemoryStorage();
    const finalized = loadEvent('invoice_finalized_send_invoice_annual');
    storage.persistMapResult(finalized.id, mapEvent(finalized));
    const pending = scheduleRows(storage);
    for (const row of pending.slice(0, 3)) storage.entries.markScheduledPosted(row.id);

    const credit = creditNoteAgainstAnnual({
      eventId: 'evt_credit_annual_balance',
      type: 'post_payment',
      subtotal: 30000,
      tax: 0,
    });
    const cn = credit.data.object as Stripe.CreditNote;
    expect(creditNoteHasDeferredSchedule(cn, cn.invoice as Stripe.Invoice)).toBe(true);
    storage.persistCreditReversal(credit.id, buildCreditReconcileInput(credit));

    const rev = computeBalances(storage.entries.findByEventId(credit.id).map((r) => r.entry));
    expect(rev['2100']).toBe(30000); // deferred reduced
    expect(rev['2200']).toBe(-30000); // customer credit balance booked (not 1100)
    expect(rev['1100']).toBeUndefined();
  });

  it('voiding a deferred draw-down restores the schedule and P&L exactly (create-then-void symmetry)', () => {
    const storage = inMemoryStorage();
    const finalized = loadEvent('invoice_finalized_send_invoice_annual');
    storage.persistMapResult(finalized.id, mapEvent(finalized));
    for (const row of scheduleRows(storage).slice(0, 3)) storage.entries.markScheduledPosted(row.id);

    // Create a $300 pre-payment draw-down (reduces 2100 by $300, re-spreads $600).
    const credit = creditNoteAgainstAnnual({
      eventId: 'evt_credit_drawdown',
      type: 'pre_payment',
      subtotal: 30000,
      tax: 0,
    });
    storage.persistCreditReversal(credit.id, buildCreditReconcileInput(credit));

    // Void that same credit note (same credit-note id, new event id).
    const voidEvent = JSON.parse(JSON.stringify(credit)) as Stripe.Event;
    (voidEvent as { id: string }).id = 'evt_credit_drawdown_void';
    (voidEvent as { type: string }).type = 'credit_note.voided';
    (voidEvent.data.object as unknown as { status: string }).status = 'void';

    expect(creditNoteVoidNeedsReconcile(voidEvent)).toBe(true);
    storage.persistCreditVoidReversal(voidEvent.id, buildCreditVoidReconcileInput(voidEvent));

    // The schedule is re-inflated to the pre-credit remaining ($900 across 9 rows,
    // back to $100/mo), and the old reduced rows are cancelled.
    const pendingAfter = scheduleRows(storage).filter((r) => r.status === 'pending');
    expect(pendingAfter).toHaveLength(9);
    const pendingSum = pendingAfter.reduce(
      (s, r) => s + r.entry.lines.filter((l) => l.accountCode === '4000').reduce((a, l) => a + l.amount, 0),
      0,
    );
    expect(pendingSum).toBe(90000);

    // Post the re-inflated schedule; the invoice's lifetime numbers are exactly as
    // if the credit had never happened: full contract recognized, full receivable.
    for (const row of pendingAfter) storage.entries.markScheduledPosted(row.id);
    const ledger: JournalEntry[] = [
      ...storage.entries.findByEventId(finalized.id).map((r) => r.entry),
      ...storage.entries.findByEventId(credit.id).map((r) => r.entry),
      ...storage.entries.findByEventId(voidEvent.id).map((r) => r.entry),
      ...storage.entries.listScheduledByStatus('posted').map((r) => r.entry),
    ];
    const balances = computeBalances(ledger);
    expect(balances['1100']).toBe(120000); // receivable fully restored
    expect(balances['4000']).toBe(-120000); // full contract recognized (credit undone)
    expect(balances['2100']).toBeUndefined(); // deferred drained, none stranded
  });

  it('pure engine refuses (throws) voiding a credit note against a deferred invoice', () => {
    const credit = creditNoteAgainstAnnual({
      eventId: 'evt_credit_void_throw',
      type: 'pre_payment',
      subtotal: 30000,
      tax: 0,
    });
    (credit as { type: string }).type = 'credit_note.voided';
    (credit.data.object as unknown as { status: string }).status = 'void';
    expect(() => mapEvent(credit)).toThrow(/deferred/i);
  });

  it('pure engine refuses (throws) a post-payment-to-balance credit against a deferred invoice', () => {
    const credit = creditNoteAgainstAnnual({
      eventId: 'evt_credit_annual_balance_throw',
      type: 'post_payment',
      subtotal: 30000,
      tax: 0,
    });
    expect(() => mapEvent(credit)).toThrow(/deferred/i);
  });

  it('refuses (throws) an FX-bearing deferred draw-down — same-currency only (Decision 5)', () => {
    const storage = inMemoryStorage();
    // An FX annual invoice paid by card builds a schedule whose rows carry
    // fxContext (settlement currency ≠ the customer currency the credit note is in).
    const fx = loadEvent('invoice_payment_succeeded_annual_fx');
    storage.persistMapResult(fx.id, mapEvent(fx));
    const invoice = JSON.parse(JSON.stringify(fx.data.object)) as Stripe.Invoice;

    const credit = {
      id: 'evt_credit_fx',
      object: 'event',
      type: 'credit_note.created',
      created: 1745000000,
      data: {
        object: {
          id: 'cn_fx',
          object: 'credit_note',
          type: 'post_payment',
          status: 'issued',
          currency: invoice.currency,
          amount: 10000,
          subtotal: 10000,
          total: 10000,
          out_of_band_amount: null,
          refund: null,
          customer_balance_transaction: 'cbtxn_fx_001',
          customer: invoice.customer,
          created: 1745000000,
          invoice,
        },
      },
    } as unknown as Stripe.Event;

    const cn = credit.data.object as Stripe.CreditNote;
    expect(creditNoteHasDeferredSchedule(cn, invoice)).toBe(true);
    expect(() =>
      storage.persistCreditReversal(credit.id, buildCreditReconcileInput(credit)),
    ).toThrow(/cross-currency|FX/i);
    // The refusal happens before any mutation — the schedule is untouched.
    const rows = storage.entries
      .findScheduledBySubscription(
        typeof invoice.subscription === 'string' ? invoice.subscription : '',
      )
      .filter((r) => r.entry.sourceObjectId === invoice.id);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
  });
});
