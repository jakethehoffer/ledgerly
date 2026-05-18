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
  taxInBT: Cents,
  btCurrency: string,
): JournalEntry {
  const preTax = cents(gross - taxInBT);
  const draft: JournalLine[] = [
    { accountCode: '1010', side: 'debit',  amount: net,    memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,    memo: 'Stripe processing fee' },
    { accountCode: '4000', side: 'credit', amount: preTax, memo: 'Subscription revenue (1-month period)' },
  ];
  if (taxInBT > 0) {
    draft.push({ accountCode: '2000', side: 'credit', amount: taxInBT, memo: 'Sales tax collected' });
  }
  const lines: ReadonlyArray<JournalLine> = sortLines(draft);
  return {
    date: epochToUtcDate(event.created),
    currency: btCurrency,
    memo: invoiceMemo(invoice),
    sourceEventId: event.id,
    sourceEventType: event.type,
    sourceObjectId: invoice.id,
    lines,
  };
}

function buildPlatformEntry(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  appFee: Cents,
  fee: Cents,
  net: Cents,
  btCurrency: string,
): JournalEntry {
  // Platform's view of a Connect destination-charge invoice:
  // - revenue is the application fee (not the gross subscription amount)
  // - tax is the connected account's concern; platform does NOT book sales tax
  // - no deferred recognition: platform fees are earned at collection, not pro-rated
  //   over the subscription's service period
  const lines: ReadonlyArray<JournalLine> = sortLines([
    { accountCode: '1010', side: 'debit',  amount: net,    memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,    memo: 'Stripe processing fee' },
    { accountCode: '4100', side: 'credit', amount: appFee, memo: 'Application fee revenue' },
  ]);
  return {
    date: epochToUtcDate(event.created),
    currency: btCurrency,
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
  taxInBT: Cents,
  btCurrency: string,
): JournalEntry {
  const preTax = cents(gross - taxInBT);
  const draft: JournalLine[] = [
    { accountCode: '1010', side: 'debit',  amount: net,    memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,    memo: 'Stripe processing fee' },
    { accountCode: '2100', side: 'credit', amount: preTax, memo: 'Annual subscription deferred' },
  ];
  if (taxInBT > 0) {
    draft.push({ accountCode: '2000', side: 'credit', amount: taxInBT, memo: 'Sales tax collected' });
  }
  const lines: ReadonlyArray<JournalLine> = sortLines(draft);
  return {
    date: epochToUtcDate(event.created),
    currency: btCurrency,
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
  btCurrency: string,
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
      currency: btCurrency,
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

  // Use bt.amount as the gross basis so the entry stays balanced when the
  // Stripe account's settlement currency differs from the invoice's
  // customer-facing currency (e.g., Canadian-based account billing in USD:
  // Stripe converts USD→CAD before depositing; bt.amount, bt.fee, bt.net
  // are all in the BT's settlement currency, while invoice.amount_paid and
  // invoice.tax are in the invoice's customer-facing currency). For
  // same-currency invoices (invoice.currency === bt.currency),
  // bt.amount equals invoice.amount_paid — existing USD fixtures see no
  // behavior change. The taxRatio below is dimensionless (USD/USD), so
  // applying it to the BT-currency gross produces a tax portion in the BT
  // currency. Proper FX rate handling (account 7000 FX Gain/Loss) remains
  // spec-deferred.
  const btCurrency = bt.currency.toUpperCase();

  const appFee = invoice.application_fee_amount ?? 0;
  const isPlatformInvoice = appFee > 0;

  const fee = cents(bt.fee);
  const net = cents(bt.net);

  if (isPlatformInvoice) {
    // Connect destination charge on the platform's side: revenue = app fee,
    // no tax, no deferred recognition (force monthly-cash regardless of period).
    return {
      entries: [buildPlatformEntry(event, invoice, cents(appFee), fee, net, btCurrency)],
      schedule: null,
    };
  }

  const gross = cents(bt.amount);

  // Convert invoice.tax (in invoice currency) to a BT-currency cents amount
  // via the dimensionless tax ratio. For same-currency invoices this rounds
  // to invoice.tax exactly (since bt.amount === invoice.amount_paid).
  const invoiceTax = invoice.tax ?? 0;
  const taxInBT: Cents =
    invoiceTax > 0 && invoice.amount_paid > 0
      ? cents(Math.round(bt.amount * (invoiceTax / invoice.amount_paid)))
      : cents(0);

  const span = periodSpanDays(invoice);
  if (span <= MONTHLY_THRESHOLD_DAYS) {
    return {
      entries: [buildMonthlyEntry(event, invoice, gross, fee, net, taxInBT, btCurrency)],
      schedule: null,
    };
  }

  const months = periodMonths(invoice);
  const preTax = cents(gross - taxInBT);
  return {
    entries: [buildAnnualCashEntry(event, invoice, gross, fee, net, taxInBT, btCurrency)],
    schedule: buildRecognitionSchedule(event, invoice, preTax, months, btCurrency),
  };
}
