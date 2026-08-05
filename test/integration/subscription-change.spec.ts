import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import request, { type Response } from 'supertest';
import type { JournalEntry } from '../../src/journal.js';
import { cents } from '../../src/money.js';
import { mapEvent } from '../../src/engine.js';
import { createServer } from '../../src/server/index.js';
import { silentLogger } from '../../src/server/logger.js';
import { createScheduler } from '../../src/server/scheduler.js';
import {
  buildSubscriptionChangeReconcileInput,
  subscriptionChangeNeedsReconcile,
} from '../../src/server/subscriptionChangeReconciler.js';
import {
  buildCreditReconcileInput,
  creditNoteNeedsReconcile,
} from '../../src/server/creditReconciler.js';
import { inMemoryStorage } from '../../src/server/storage/inMemory.js';
import { computeBalances } from '../helpers/balances.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures');

function loadEvent(name: string): Stripe.Event {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURE_DIR, `${name}.event.json`), 'utf8'),
  ) as Stripe.Event;
}

const SUBSCRIPTION_ID = 'sub_test_annual_001';
const ORIGINAL_INVOICE_ID = 'in_test_annual_001';
const CHANGE_INVOICE_ID = 'in_test_annual_midyear_upgrade_001';
const SECOND_CHANGE_INVOICE_ID = 'in_test_annual_second_upgrade_001';
const WEBHOOK_SECRET = 'whsec_subscription_change_test';

/**
 * Derive the annual mid-term shape from the existing Stripe proration fixture:
 * unused old service (-$700) + remaining new service ($1,400) = a paid $700
 * upgrade for the seven months left in the original annual term.
 */
function annualMidyearUpgrade(): Stripe.Event {
  const event = loadEvent('invoice_payment_succeeded_prorated_upgrade');
  const invoice = event.data.object as Stripe.Invoice;
  const charge = invoice.charge as Stripe.Charge;
  const balanceTransaction = charge.balance_transaction as Stripe.BalanceTransaction;

  (event as { id: string }).id = 'evt_test_annual_midyear_upgrade_001';
  (event as { created: number }).created = 1751371200; // 2025-07-01T12:00:00Z
  (invoice as { id: string }).id = CHANGE_INVOICE_ID;
  (invoice as { subscription: string }).subscription = SUBSCRIPTION_ID;
  (invoice as { created: number }).created = 1751371200;
  (invoice as { amount_due: number }).amount_due = 70000;
  (invoice as { amount_paid: number }).amount_paid = 70000;
  (invoice as { total: number }).total = 70000;
  (charge as { id: string }).id = 'ch_test_annual_midyear_upgrade_001';
  (charge as { amount: number }).amount = 70000;
  (balanceTransaction as { id: string }).id = 'txn_test_annual_midyear_upgrade_001';
  (balanceTransaction as { amount: number }).amount = 70000;
  (balanceTransaction as { fee: number }).fee = 0;
  (balanceTransaction as unknown as { fee_details: Stripe.BalanceTransaction.FeeDetail[] })
    .fee_details = [];
  (balanceTransaction as { net: number }).net = 70000;
  (balanceTransaction as { created: number }).created = 1751371200;

  const [oldPlan, newPlan] = invoice.lines.data;
  if (!oldPlan || !newPlan) throw new Error('proration fixture lost its two lines');
  (oldPlan as { amount: number }).amount = -70000;
  (newPlan as { amount: number }).amount = 140000;
  for (const line of [oldPlan, newPlan]) {
    (line as { subscription: string }).subscription = SUBSCRIPTION_ID;
    (line.period as { start: number }).start = 1751371200;
    (line.period as { end: number }).end = 1768478400; // original 2026-01-15 term end
    (line as { proration: boolean }).proration = true;
  }

  return event;
}

function secondAnnualUpgrade(): Stripe.Event {
  const event = annualMidyearUpgrade();
  const invoice = event.data.object as Stripe.Invoice;
  const charge = invoice.charge as Stripe.Charge;
  const balanceTransaction = charge.balance_transaction as Stripe.BalanceTransaction;
  (event as { id: string }).id = 'evt_test_annual_second_upgrade_001';
  (event as { created: number }).created = 1754049600; // 2025-08-01T12:00:00Z
  (invoice as { id: string }).id = SECOND_CHANGE_INVOICE_ID;
  (invoice as { created: number }).created = 1754049600;
  (invoice as { amount_due: number }).amount_due = 60000;
  (invoice as { amount_paid: number }).amount_paid = 60000;
  (invoice as { total: number }).total = 60000;
  (charge as { id: string }).id = 'ch_test_annual_second_upgrade_001';
  (charge as { amount: number }).amount = 60000;
  (balanceTransaction as { id: string }).id = 'txn_test_annual_second_upgrade_001';
  (balanceTransaction as { amount: number }).amount = 60000;
  (balanceTransaction as { net: number }).net = 60000;
  (balanceTransaction as { created: number }).created = 1754049600;
  const [oldPlan, newPlan] = invoice.lines.data;
  if (!oldPlan || !newPlan) throw new Error('proration fixture lost its two lines');
  (oldPlan as { amount: number }).amount = -60000;
  (newPlan as { amount: number }).amount = 120000;
  for (const line of [oldPlan, newPlan]) {
    (line.period as { start: number }).start = 1754049600;
  }
  return event;
}

function creditAgainstInvoice(
  invoiceEvent: Stripe.Event,
  eventId: string,
  amount: number,
): Stripe.Event {
  const invoice = JSON.parse(JSON.stringify(invoiceEvent.data.object)) as Stripe.Invoice;
  return {
    id: eventId,
    object: 'event',
    type: 'credit_note.created',
    created: 1751457600,
    data: {
      object: {
        id: `cn_${eventId}`,
        object: 'credit_note',
        type: 'post_payment',
        status: 'issued',
        currency: 'usd',
        amount,
        subtotal: amount,
        total: amount,
        out_of_band_amount: 0,
        refund: null,
        customer_balance_transaction: `cbtxn_${eventId}`,
        customer: invoice.customer,
        created: 1751457600,
        invoice,
      },
    },
  } as unknown as Stripe.Event;
}

function recognitionAmount(entry: JournalEntry): number {
  return entry.lines
    .filter((line) => line.accountCode === '4000' && line.side === 'credit')
    .reduce((sum, line) => sum + line.amount, 0);
}

describe('integration: paid mid-year annual subscription change', () => {
  it('keeps earned months, cancels the old future rows, and rebuilds the rest with the paid upgrade', () => {
    const storage = inMemoryStorage();
    const original = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(original.id, mapEvent(original));

    const originalRows = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .filter((row) => row.entry.sourceObjectId === ORIGINAL_INVOICE_ID);
    expect(originalRows).toHaveLength(12);

    // Five months were already earned before the July 1 upgrade. The seven
    // remaining dates, July 15 through January 15, are the dates to rebuild.
    for (const row of originalRows.slice(0, 5)) storage.entries.markScheduledPosted(row.id);
    const oldFutureDates = originalRows.slice(5).map((row) => row.entry.date);

    const change = annualMidyearUpgrade();
    const mappedChange = mapEvent(change);
    expect(mappedChange.schedule?.entries).toHaveLength(7);
    expect(mappedChange.schedule?.entries.reduce((sum, entry) => sum + recognitionAmount(entry), 0))
      .toBe(70000);
    expect(subscriptionChangeNeedsReconcile(change, mappedChange)).toBe(true);

    const first = storage.persistSubscriptionChange(
      change.id,
      buildSubscriptionChangeReconcileInput(change, mappedChange),
    );
    expect(first).toEqual({ duplicate: false });

    const allRows = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    const postedOriginal = allRows.filter((row) => row.status === 'posted');
    const cancelledOriginal = allRows.filter((row) => row.status === 'cancelled');
    const rebuilt = allRows.filter((row) => row.status === 'pending');

    expect(postedOriginal).toHaveLength(5);
    expect(cancelledOriginal).toHaveLength(7);
    expect(rebuilt).toHaveLength(14);
    expect([...new Set(rebuilt.map((row) => row.entry.date))]).toEqual(oldFutureDates);
    const rebuiltOriginal = rebuilt.filter(
      (row) => row.entry.sourceObjectId === ORIGINAL_INVOICE_ID,
    );
    const rebuiltChange = rebuilt.filter(
      (row) => row.entry.sourceObjectId === CHANGE_INVOICE_ID,
    );
    expect(rebuiltOriginal).toHaveLength(7);
    expect(rebuiltChange).toHaveLength(7);
    expect(rebuiltOriginal.map((row) => recognitionAmount(row.entry))).toEqual([
      10000, 10000, 10000, 10000, 10000, 10000, 10000,
    ]);
    expect(rebuiltChange.map((row) => recognitionAmount(row.entry))).toEqual([
      10000, 10000, 10000, 10000, 10000, 10000, 10000,
    ]);

    // The paid change still creates its cash entry once.
    const changeEntries = storage.entries.findByEventId(change.id).map((row) => row.entry);
    expect(changeEntries).toHaveLength(1);
    const changeCash = computeBalances(changeEntries);
    expect(changeCash['1010']).toBe(70000);
    expect(changeCash['2100']).toBe(-70000);

    // A Stripe redelivery cannot cancel or add anything a second time.
    const beforeDuplicate = storage.entries.countPendingScheduled();
    const duplicate = storage.persistSubscriptionChange(
      change.id,
      buildSubscriptionChangeReconcileInput(change, mappedChange),
    );
    expect(duplicate).toEqual({ duplicate: true });
    expect(storage.entries.countPendingScheduled()).toBe(beforeDuplicate);

    // After every rebuilt month posts, deferred revenue clears exactly and the
    // lifetime subscription revenue is $1,900 ($1,200 original + $700 upgrade).
    for (const row of rebuilt) storage.entries.markScheduledPosted(row.id);
    const ledger: JournalEntry[] = [
      ...storage.entries.findByEventId(original.id).map((row) => row.entry),
      ...changeEntries,
      ...storage.entries.listScheduledByStatus('posted').map((row) => row.entry),
    ];
    const lifetime = computeBalances(ledger);
    expect(lifetime['2100']).toBeUndefined();
    expect(lifetime['4000']).toBe(-190000);
  });

  it('lets a later credit against the first invoice reduce the rebuilt schedule', () => {
    const storage = inMemoryStorage();
    const original = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(original.id, mapEvent(original));
    const originalRows = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    for (const row of originalRows.slice(0, 5)) storage.entries.markScheduledPosted(row.id);

    const change = annualMidyearUpgrade();
    const mappedChange = mapEvent(change);
    storage.persistSubscriptionChange(
      change.id,
      buildSubscriptionChangeReconcileInput(change, mappedChange),
    );
    const beforeCredit = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .filter((row) => row.status === 'pending');
    expect(beforeCredit).toHaveLength(14);
    expect(beforeCredit.reduce((sum, row) => sum + recognitionAmount(row.entry), 0))
      .toBe(140000);

    const credit = creditAgainstInvoice(
      original,
      'evt_test_annual_after_upgrade_credit_001',
      30000,
    );
    expect(creditNoteNeedsReconcile(credit)).toBe(true);
    storage.persistCreditReversal(credit.id, buildCreditReconcileInput(credit));

    const afterCredit = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .filter((row) => row.status === 'pending');
    expect(afterCredit).toHaveLength(14);
    expect(afterCredit.reduce((sum, row) => sum + recognitionAmount(row.entry), 0))
      .toBe(110000);
    expect(
      afterCredit
        .filter((row) => row.entry.sourceObjectId === ORIGINAL_INVOICE_ID)
        .reduce((sum, row) => sum + recognitionAmount(row.entry), 0),
    ).toBe(40000);
    expect(
      afterCredit
        .filter((row) => row.entry.sourceObjectId === CHANGE_INVOICE_ID)
        .reduce((sum, row) => sum + recognitionAmount(row.entry), 0),
    ).toBe(70000);

    const creditBalances = computeBalances(
      storage.entries.findByEventId(credit.id).map((row) => row.entry),
    );
    expect(creditBalances['2100']).toBe(30000);
    expect(creditBalances['2200']).toBe(-30000);

    const secondCredit = creditAgainstInvoice(
      change,
      'evt_test_upgrade_invoice_credit_001',
      10000,
    );
    expect(creditNoteNeedsReconcile(secondCredit)).toBe(true);
    storage.persistCreditReversal(
      secondCredit.id,
      buildCreditReconcileInput(secondCredit),
    );
    const afterSecondCredit = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .filter((row) => row.status === 'pending');
    expect(afterSecondCredit).toHaveLength(14);
    expect(
      afterSecondCredit.reduce((sum, row) => sum + recognitionAmount(row.entry), 0),
    ).toBe(100000);
    expect(
      afterSecondCredit
        .filter((row) => row.entry.sourceObjectId === ORIGINAL_INVOICE_ID)
        .reduce((sum, row) => sum + recognitionAmount(row.entry), 0),
    ).toBe(40000);
    expect(
      afterSecondCredit
        .filter((row) => row.entry.sourceObjectId === CHANGE_INVOICE_ID)
        .reduce((sum, row) => sum + recognitionAmount(row.entry), 0),
    ).toBe(60000);
  });

  it('never uses the upgrade balance to cover a full credit on the first invoice', () => {
    const storage = inMemoryStorage();
    const original = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(original.id, mapEvent(original));
    const originalRows = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    for (const row of originalRows.slice(0, 5)) storage.entries.markScheduledPosted(row.id);

    const change = annualMidyearUpgrade();
    const mappedChange = mapEvent(change);
    storage.persistSubscriptionChange(
      change.id,
      buildSubscriptionChangeReconcileInput(change, mappedChange),
    );

    const fullOriginalCredit = creditAgainstInvoice(
      original,
      'evt_test_full_original_credit_after_upgrade_001',
      120000,
    );
    storage.persistCreditReversal(
      fullOriginalCredit.id,
      buildCreditReconcileInput(fullOriginalCredit),
    );

    const reversal = computeBalances(
      storage.entries.findByEventId(fullOriginalCredit.id).map((row) => row.entry),
    );
    expect(reversal['2100']).toBe(70000);
    expect(reversal['4000']).toBe(50000);
    expect(reversal['2200']).toBe(-120000);

    const remaining = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .filter((row) => row.status === 'pending');
    expect(remaining).toHaveLength(7);
    expect(remaining.every((row) => row.entry.sourceObjectId === CHANGE_INVOICE_ID))
      .toBe(true);
    expect(remaining.reduce((sum, row) => sum + recognitionAmount(row.entry), 0))
      .toBe(70000);
  });

  it('keeps three invoice shares separate after two upgrades in one term', () => {
    const storage = inMemoryStorage();
    const original = loadEvent('invoice_payment_succeeded_annual');
    storage.persistMapResult(original.id, mapEvent(original));
    const originalRows = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    for (const row of originalRows.slice(0, 5)) storage.entries.markScheduledPosted(row.id);

    const firstChange = annualMidyearUpgrade();
    storage.persistSubscriptionChange(
      firstChange.id,
      buildSubscriptionChangeReconcileInput(firstChange, mapEvent(firstChange)),
    );
    const julyRows = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .filter((row) => row.status === 'pending' && row.entry.date === '2025-07-15');
    expect(julyRows).toHaveLength(2);
    for (const row of julyRows) storage.entries.markScheduledPosted(row.id);

    const secondChange = secondAnnualUpgrade();
    const mappedSecond = mapEvent(secondChange);
    expect(mappedSecond.schedule?.entries).toHaveLength(6);
    storage.persistSubscriptionChange(
      secondChange.id,
      buildSubscriptionChangeReconcileInput(secondChange, mappedSecond),
    );

    const pending = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(18);
    for (const invoiceId of [
      ORIGINAL_INVOICE_ID,
      CHANGE_INVOICE_ID,
      SECOND_CHANGE_INVOICE_ID,
    ]) {
      const invoiceShare = pending.filter(
        (row) => row.entry.sourceObjectId === invoiceId,
      );
      expect(invoiceShare).toHaveLength(6);
      expect(invoiceShare.reduce((sum, row) => sum + recognitionAmount(row.entry), 0))
        .toBe(60000);
    }
  });

  it('rebuilds through a signed webhook and sends the rebuilt month when due', async () => {
    const original = loadEvent('invoice_payment_succeeded_annual');
    const change = annualMidyearUpgrade();
    const invoices = new Map<string, Stripe.Invoice>([
      [ORIGINAL_INVOICE_ID, original.data.object as Stripe.Invoice],
      [CHANGE_INVOICE_ID, change.data.object as Stripe.Invoice],
    ]);
    const stripe = new Stripe('sk_test_subscription_change');
    type InvoiceRetrieve = typeof stripe.invoices.retrieve;
    (stripe.invoices as unknown as { retrieve: InvoiceRetrieve }).retrieve = (
      (id: string): Promise<Stripe.Invoice> => {
        const invoice = invoices.get(id);
        if (!invoice) throw new Error(`Missing test invoice ${id}`);
        return Promise.resolve(invoice);
      }
    ) as InvoiceRetrieve;

    const storage = inMemoryStorage();
    const { app } = createServer({
      stripe,
      webhookSecret: WEBHOOK_SECRET,
      storage,
      log: silentLogger(),
    });
    async function send(event: Stripe.Event): Promise<Response> {
      const raw = JSON.stringify(event);
      const signature = stripe.webhooks.generateTestHeaderString({
        payload: raw,
        secret: WEBHOOK_SECRET,
      });
      return request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', signature)
        .send(raw);
    }

    const originalResponse = await send(original);
    expect(originalResponse.status).toBe(200);
    const originalRows = storage.entries.findScheduledBySubscription(SUBSCRIPTION_ID);
    for (const row of originalRows.slice(0, 5)) storage.entries.markScheduledPosted(row.id);

    const changeResponse = await send(change);
    expect(changeResponse.status).toBe(200);
    expect(changeResponse.body).toMatchObject({ ok: true, schedule: true });
    const rebuilt = storage.entries
      .findScheduledBySubscription(SUBSCRIPTION_ID)
      .filter((row) => row.status === 'pending');
    expect(rebuilt).toHaveLength(14);
    const totalsByDate = new Map<string, number>();
    for (const row of rebuilt) {
      totalsByDate.set(
        row.entry.date,
        (totalsByDate.get(row.entry.date) ?? 0) + recognitionAmount(row.entry),
      );
    }
    expect([...totalsByDate.values()]).toEqual([
      20000, 20000, 20000, 20000, 20000, 20000, 20000,
    ]);

    const duplicate = await send(change);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body).toEqual({ duplicate: true });

    const firstRebuilt = rebuilt[0];
    if (!firstRebuilt) throw new Error('Rebuilt schedule lost its first row');
    const sentIds: number[] = [];
    const scheduler = createScheduler({
      storage,
      dispatcher(entry) {
        sentIds.push(entry.id);
      },
      today: () => firstRebuilt.entry.date,
      log: silentLogger(),
    });
    await scheduler.tick();
    expect(sentIds).toContain(firstRebuilt.id);
    expect(storage.entries.getScheduledById(firstRebuilt.id)?.status).toBe('posted');
  });

  it('refuses a rebuild when the old schedule is missing or carries FX history', () => {
    const change = annualMidyearUpgrade();
    const mappedChange = mapEvent(change);
    const input = buildSubscriptionChangeReconcileInput(change, mappedChange);
    expect(() => input.build([])).toThrow(/no unposted recognition rows/);

    const original = loadEvent('invoice_payment_succeeded_annual');
    const oldSchedule = mapEvent(original).schedule;
    const oldRow = oldSchedule?.entries[5];
    if (!oldRow) throw new Error('Annual fixture lost its sixth recognition row');
    const fxRow: JournalEntry = {
      ...oldRow,
      fxContext: {
        customerCurrency: 'EUR',
        customerAmount: cents(10000),
        settlementCurrency: 'USD',
        settlementAmount: cents(10000),
      },
    };
    expect(() => input.build([fxRow])).toThrow(/FX-bearing or mixed-currency/);
  });
});
