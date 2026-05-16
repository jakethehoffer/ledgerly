import type Stripe from 'stripe';
import { cents, type Cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult, RecognitionSchedule } from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate, addMonths } from '../../util/dates.js';
import { sortLines } from '../../util/lines.js';
import { invoiceMemo } from '../../util/memo.js';

const SECONDS_PER_DAY = 86400;
const MONTHLY_THRESHOLD_DAYS = 32;

function periodSpanDays(invoice: Stripe.Invoice): number {
  let maxSpan = 0;
  for (const line of invoice.lines.data) {
    const span = (line.period.end - line.period.start) / SECONDS_PER_DAY;
    if (span > maxSpan) maxSpan = span;
  }
  if (maxSpan === 0) {
    throw new Error(
      `Invoice ${invoice.id} has no line-item periods; cannot classify subscription term`,
    );
  }
  return maxSpan;
}

function periodMonths(invoice: Stripe.Invoice): number {
  // Approximate months by dividing the longest period span. 12 for annual, 1 for monthly.
  const days = periodSpanDays(invoice);
  return Math.max(1, Math.round(days / 30));
}

function getCharge(invoice: Stripe.Invoice, eventId: string): Stripe.Charge {
  return requireExpanded<Stripe.Charge>(invoice.charge, 'invoice.charge', eventId);
}

function getBalanceTxn(charge: Stripe.Charge, eventId: string): Stripe.BalanceTransaction {
  return requireExpanded<Stripe.BalanceTransaction>(
    charge.balance_transaction,
    'invoice.charge.balance_transaction',
    eventId,
  );
}

function resolveSubscriptionId(invoice: Stripe.Invoice): string {
  if (typeof invoice.subscription === 'string') {
    return invoice.subscription;
  }
  if (invoice.subscription && typeof invoice.subscription === 'object') {
    return invoice.subscription.id;
  }
  return `invoice:${invoice.id}`;
}

function buildMonthlyEntry(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  fee: Cents,
  net: Cents,
): JournalEntry {
  const lines: ReadonlyArray<JournalLine> = sortLines([
    { accountCode: '1010', side: 'debit',  amount: net,   memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,   memo: 'Stripe processing fee' },
    { accountCode: '4000', side: 'credit', amount: gross, memo: 'Subscription revenue (1-month period)' },
  ]);
  return {
    date: epochToUtcDate(event.created),
    currency: 'USD',
    memo: invoiceMemo(invoice),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: invoice.id,
    lines,
  };
}

function buildAnnualCashEntry(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  fee: Cents,
  net: Cents,
): JournalEntry {
  const lines: ReadonlyArray<JournalLine> = sortLines([
    { accountCode: '1010', side: 'debit',  amount: net,   memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,   memo: 'Stripe processing fee' },
    { accountCode: '2100', side: 'credit', amount: gross, memo: 'Annual subscription deferred' },
  ]);
  return {
    date: epochToUtcDate(event.created),
    currency: 'USD',
    memo: invoiceMemo(invoice),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: invoice.id,
    lines,
  };
}

function buildRecognitionSchedule(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  months: number,
): RecognitionSchedule {
  const subscriptionId = resolveSubscriptionId(invoice);

  const cashDate = epochToUtcDate(event.created);
  const baseAmount = Math.floor(gross / months);
  const remainder = gross - baseAmount * months;

  const entries: JournalEntry[] = [];
  for (let m = 1; m <= months; m++) {
    // Last entry absorbs the remainder so the schedule's sum equals gross exactly.
    const monthAmount = cents(m === months ? baseAmount + remainder : baseAmount);
    entries.push({
      date: addMonths(cashDate, m),
      currency: 'USD',
      memo: `${invoiceMemo(invoice)} — month ${String(m)}/${String(months)} recognition`,
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: invoice.id,
      lines: sortLines([
        { accountCode: '2100', side: 'debit',  amount: monthAmount, memo: 'Recognize from deferred' },
        { accountCode: '4000', side: 'credit', amount: monthAmount, memo: 'Subscription revenue' },
      ]),
    });
  }

  return {
    subscriptionId,
    sourceEventId: event.id,
    entries,
  };
}

export function handleInvoicePaymentSucceeded(event: Stripe.Event): MapResult {
  if (event.type !== 'invoice.payment_succeeded') {
    throw new Error(`handleInvoicePaymentSucceeded received wrong event type: ${event.type}`);
  }
  const invoice = event.data.object;
  if (invoice.currency !== 'usd') {
    throw new Error(
      `Non-USD invoices not yet supported (invoice ${String(invoice.id)} currency=${invoice.currency})`,
    );
  }
  if (invoice.amount_paid === 0) {
    return { entries: [], schedule: null };
  }
  if (invoice.lines.has_more) {
    throw new Error(
      `Invoice ${invoice.id} has paginated line items (lines.has_more=true); ` +
        `caller must expand all pages before invoking the engine`,
    );
  }

  const charge = getCharge(invoice, event.id);
  const bt = getBalanceTxn(charge, event.id);

  const gross = cents(invoice.amount_paid);
  const fee = cents(bt.fee);
  const net = cents(bt.net);

  const span = periodSpanDays(invoice);
  if (span <= MONTHLY_THRESHOLD_DAYS) {
    return {
      entries: [buildMonthlyEntry(event, invoice, gross, fee, net)],
      schedule: null,
    };
  }

  const months = periodMonths(invoice);
  return {
    entries: [buildAnnualCashEntry(event, invoice, gross, fee, net)],
    schedule: buildRecognitionSchedule(event, invoice, gross, months),
  };
}
