import type Stripe from 'stripe';
import { cents, type Cents } from '../../money.js';
import type {
  FxContext,
  JournalEntry,
  JournalLine,
  MapResult,
  RecognitionSchedule,
} from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate, addMonths } from '../../util/dates.js';
import { buildFxContext, withFx } from '../../util/fxContext.js';
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

/**
 * Sum the invoice's line-item amounts (customer currency, pre-tax) into the
 * portion earned immediately vs. the portion deferred, classifying each line by
 * its OWN billing span. A line spanning a month or less (including a one-time
 * item with an instant period) is immediate; a longer line is deferred over its
 * term. Line amounts are pre-tax, so the two sums add up to the invoice's
 * pre-tax subtotal — the basis for splitting settlement-currency pre-tax
 * revenue between recognize-now (4000) and defer (2100).
 */
function partitionLineAmounts(invoice: Stripe.Invoice): {
  immediateCustomer: number;
  deferredCustomer: number;
} {
  let immediateCustomer = 0;
  let deferredCustomer = 0;
  for (const line of invoice.lines.data) {
    const span = (line.period.end - line.period.start) / SECONDS_PER_DAY;
    if (span > MONTHLY_THRESHOLD_DAYS) {
      deferredCustomer += line.amount;
    } else {
      immediateCustomer += line.amount;
    }
  }
  return { immediateCustomer, deferredCustomer };
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
  fxContext: FxContext | undefined,
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
  return withFx(
    {
      date: epochToUtcDate(event.created),
      currency: btCurrency,
      memo: invoiceMemo(invoice),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: invoice.id,
      lines,
    },
    fxContext,
  );
}

function buildPlatformEntry(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  appFee: Cents,
  fee: Cents,
  net: Cents,
  btCurrency: string,
  fxContext: FxContext | undefined,
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
  return withFx(
    {
      date: epochToUtcDate(event.created),
      currency: btCurrency,
      memo: invoiceMemo(invoice),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: invoice.id,
      lines,
    },
    fxContext,
  );
}

function buildAnnualCashEntry(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  fee: Cents,
  net: Cents,
  taxInBT: Cents,
  btCurrency: string,
  fxContext: FxContext | undefined,
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
  return withFx(
    {
      date: epochToUtcDate(event.created),
      currency: btCurrency,
      memo: invoiceMemo(invoice),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: invoice.id,
      lines,
    },
    fxContext,
  );
}

function buildMixedCashEntry(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  immediatePreTax: Cents,
  deferredPreTax: Cents,
  fee: Cents,
  net: Cents,
  taxInBT: Cents,
  btCurrency: string,
  fxContext: FxContext | undefined,
): JournalEntry {
  const draft: JournalLine[] = [
    { accountCode: '1010', side: 'debit',  amount: net,            memo: 'Net to Stripe balance' },
    { accountCode: '6000', side: 'debit',  amount: fee,            memo: 'Stripe processing fee' },
    { accountCode: '4000', side: 'credit', amount: immediatePreTax, memo: 'Subscription revenue (recognized now)' },
    { accountCode: '2100', side: 'credit', amount: deferredPreTax,  memo: 'Deferred subscription revenue' },
  ];
  if (taxInBT > 0) {
    draft.push({ accountCode: '2000', side: 'credit', amount: taxInBT, memo: 'Sales tax collected' });
  }
  const lines: ReadonlyArray<JournalLine> = sortLines(draft);
  return withFx(
    {
      date: epochToUtcDate(event.created),
      currency: btCurrency,
      memo: invoiceMemo(invoice),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: invoice.id,
      lines,
    },
    fxContext,
  );
}

function buildRecognitionSchedule(
  event: Stripe.Event,
  invoice: Stripe.Invoice,
  gross: Cents,
  months: number,
  btCurrency: string,
  /**
   * Pro-rated fxContext anchor. When the invoice involved FX, the
   * schedule pro-rates both `customerAmount` and `settlementAmount` per
   * month, with month 12 absorbing the remainder so the per-month
   * customer-side sum equals `customerPreTax` and the settlement-side
   * sum equals `gross` exactly. When `undefined` (same-currency case),
   * the per-month entries get no fxContext.
   */
  scheduleFxAnchor: { customerCurrency: string; customerPreTax: number; settlementCurrency: string } | undefined,
): RecognitionSchedule {
  const subscriptionId = resolveSubscriptionId(invoice);

  const cashDate = epochToUtcDate(event.created);
  const baseAmount = Math.floor(gross / months);
  const remainder = gross - baseAmount * months;

  // Pro-rate the customer-side preTax with the same floor + remainder
  // pattern so per-month customer/settlement amounts line up at the
  // same indices and the schedule sums match both sides exactly.
  const customerBase = scheduleFxAnchor
    ? Math.floor(scheduleFxAnchor.customerPreTax / months)
    : 0;
  const customerRemainder = scheduleFxAnchor
    ? scheduleFxAnchor.customerPreTax - customerBase * months
    : 0;

  const entries: JournalEntry[] = [];
  for (let m = 1; m <= months; m++) {
    // Last entry absorbs the remainder so the schedule's sum equals gross exactly.
    const monthAmount = cents(m === months ? baseAmount + remainder : baseAmount);
    const monthCustomerAmount =
      m === months ? customerBase + customerRemainder : customerBase;
    const monthlyFxContext: FxContext | undefined = scheduleFxAnchor
      ? {
          customerCurrency: scheduleFxAnchor.customerCurrency.toUpperCase(),
          customerAmount: cents(monthCustomerAmount),
          settlementCurrency: scheduleFxAnchor.settlementCurrency.toUpperCase(),
          settlementAmount: monthAmount,
        }
      : undefined;
    entries.push(
      withFx(
        {
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
        },
        monthlyFxContext,
      ),
    );
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

  // An invoice can be paid without a charge: entirely from the customer's
  // credit balance, or marked paid out of band. There's no charge and no
  // balance transaction, so no cash moved through the Stripe balance on this
  // event. ledgerly doesn't model the customer-credit-balance / out-of-band
  // mechanics (there's no customer-credit liability account, and the credit
  // itself is created by events — credit notes — the engine doesn't handle),
  // so a fabricated entry would be wrong and can't be balanced. Acknowledge
  // with no entry, like the other no-accounting-impact events, rather than
  // throwing and forcing Stripe into a perpetual webhook-retry loop.
  //
  // This is specifically `charge` being ABSENT (null — Stripe always sends the
  // field, set to null, for these invoices). A charge present as an unexpanded
  // string id still throws below via getCharge — that is a caller error (forgot
  // to expand), not a credit-balance invoice.
  if (invoice.charge === null) {
    return { entries: [], schedule: null };
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
  // currency.
  //
  // FX gain/loss recognition on annual recognition is left to downstream
  // tools — the `fxContext` field on the cash entry AND each schedule
  // entry exposes customerAmount and settlementAmount (pro-rated per month
  // for the schedule), so an operator with a home-currency rate source can
  // compute realized FX gain/loss month-by-month. The engine itself can't
  // do this without external rate lookups it doesn't have.
  const btCurrency = bt.currency.toUpperCase();
  const cashFxContext = buildFxContext(
    invoice.currency,
    invoice.amount_paid,
    bt.currency,
    bt.amount,
  );

  const appFee = invoice.application_fee_amount ?? 0;
  const isPlatformInvoice = appFee > 0;

  const fee = cents(bt.fee);
  const net = cents(bt.net);

  if (isPlatformInvoice) {
    // Connect destination charge on the platform's side: revenue = app fee,
    // no tax, no deferred recognition (force monthly-cash regardless of period).
    // fxContext on a platform entry is intentionally undefined: the platform's
    // books only see the application fee, and the customer→settlement
    // conversion ratio applies to the FULL invoice (which the platform
    // doesn't book), not to the app-fee slice the platform records.
    return {
      entries: [buildPlatformEntry(event, invoice, cents(appFee), fee, net, btCurrency, undefined)],
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

  // Recognize revenue per line item by each line's OWN billing span, not one
  // classification for the whole invoice. A line whose period is a month or
  // shorter — including a one-time invoice item with an instant period — is
  // earned now; a longer line is deferred and recognized over its term. This
  // stops a one-time setup fee that rides on an annual invoice from being
  // deferred over 12 months alongside the subscription.
  //
  // Pure single-term invoices reduce to the monthly / annual paths below with
  // byte-identical output: an all-immediate invoice has deferredPreTax = 0
  // (monthly path), an all-deferred invoice has immediatePreTax = 0 (annual
  // path with the same `amount_paid - tax` schedule anchor as before). A pure
  // one-time invoice (every line has an instant period, e.g. a one-off
  // consulting charge) is all-immediate, so it recognizes now instead of
  // throwing "no line periods" — `periodMonths` is only computed once we know
  // a deferred line exists (span > threshold > 0), so it never sees a zero span.
  const preTax = cents(gross - taxInBT);

  const { immediateCustomer, deferredCustomer } = partitionLineAmounts(invoice);
  const lineTotal = immediateCustomer + deferredCustomer;
  // Split pre-tax revenue by the immediate portion's share of the pre-tax line
  // total (line amounts are pre-tax and sum to the subtotal), so the immediate
  // and deferred credits sum back to preTax exactly. With no usable line
  // breakdown, recognize now.
  const immediatePreTax =
    lineTotal > 0 ? Math.round((preTax * immediateCustomer) / lineTotal) : preTax;
  const deferredPreTax = preTax - immediatePreTax;

  if (deferredPreTax <= 0) {
    // Nothing to defer — every line is earned now.
    return {
      entries: [buildMonthlyEntry(event, invoice, gross, fee, net, taxInBT, btCurrency, cashFxContext)],
      schedule: null,
    };
  }

  // A deferred portion exists, so at least one line spans longer than a month:
  // periodMonths (→ periodSpanDays) has a positive max span and won't throw.
  const months = periodMonths(invoice);

  if (immediatePreTax <= 0) {
    // Everything is deferred — a single-term subscription invoice. Schedule
    // anchored on the whole customer pre-tax amount, exactly as before.
    const customerPreTax = Math.max(invoice.amount_paid - invoiceTax, 0);
    const scheduleFxAnchor =
      cashFxContext !== undefined
        ? {
            customerCurrency: invoice.currency,
            customerPreTax,
            settlementCurrency: bt.currency,
          }
        : undefined;
    return {
      entries: [buildAnnualCashEntry(event, invoice, gross, fee, net, taxInBT, btCurrency, cashFxContext)],
      schedule: buildRecognitionSchedule(event, invoice, preTax, months, btCurrency, scheduleFxAnchor),
    };
  }

  // Mixed invoice: recognize the immediate portion now (4000) and defer the
  // rest (2100), then draw the deferred portion down over its term. Tax is a
  // liability owed at collection regardless of recognition timing, so it stays
  // wholly in 2000 on the cash entry and is never deferred. The schedule is
  // anchored on the DEFERRED customer amount so its FX pro-rating covers only
  // the deferred slice.
  const scheduleFxAnchor =
    cashFxContext !== undefined
      ? {
          customerCurrency: invoice.currency,
          customerPreTax: deferredCustomer,
          settlementCurrency: bt.currency,
        }
      : undefined;
  return {
    entries: [
      buildMixedCashEntry(
        event,
        invoice,
        cents(immediatePreTax),
        cents(deferredPreTax),
        fee,
        net,
        taxInBT,
        btCurrency,
        cashFxContext,
      ),
    ],
    schedule: buildRecognitionSchedule(
      event,
      invoice,
      cents(deferredPreTax),
      months,
      btCurrency,
      scheduleFxAnchor,
    ),
  };
}
