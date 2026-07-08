import type Stripe from 'stripe';
import { cents, type Cents } from '../../money.js';
import type {
  FxContext,
  JournalEntry,
  JournalLine,
  MapResult,
} from '../../journal.js';
import { requireExpanded } from '../../errors.js';
import { epochToUtcDate } from '../../util/dates.js';
import { buildFxContext, withFx } from '../../util/fxContext.js';
import { sortLines } from '../../util/lines.js';
import { invoiceMemo } from '../../util/memo.js';
import {
  buildRecognitionSchedule,
  partitionLineAmounts,
  periodMonths,
} from './recognition.js';

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

/**
 * The amount of customer credit balance applied to a chargeless invoice, or
 * `null` when the invoice is not a whole-invoice, non-deferred credit-balance
 * payment ledgerly books.
 *
 * Stripe applies customer credit by drawing the customer's (negative) balance up
 * toward zero, so the amount applied is `ending_balance - starting_balance`,
 * positive exactly when the balance funded the invoice. An invoice marked paid
 * out of band leaves the balance untouched (delta 0), so it stays a no-op — the
 * engine must not fabricate revenue for a payment it can't account for.
 *
 * Only a credit that covers the WHOLE invoice books: a partial credit (with the
 * rest paid another way) would need proportioning, not modeled yet (per spec
 * scope). A deferred invoice IS handled — the balance funds a fresh recognition
 * schedule the same way a cash-paid annual invoice does (see the branch below).
 */
function creditBalanceApplied(invoice: Stripe.Invoice): number | null {
  if (invoice.paid_out_of_band) return null;
  if (invoice.ending_balance === null) return null;
  const applied = invoice.ending_balance - invoice.starting_balance;
  if (applied <= 0 || applied !== invoice.total) return null;
  return applied;
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
  // event.
  //
  // A credit-balance payment DOES have accounting impact: the customer spends
  // credit ledgerly booked as a 2200 liability (at credit_note.created), so the
  // service is now being delivered — draw the liability down and recognize the
  // revenue over the service term, exactly as a cash-paid invoice does. No cash
  // moves; the whole balance applied is the single debit:
  //
  //   Dr 2200 Customer Credit Balance  amount applied from balance
  //   Cr 4000 Subscription Revenue      immediate pre-tax (earned-now lines)
  //   Cr 2100 Deferred Revenue          deferred pre-tax (+ a recognition schedule)
  //   Cr 2000 Sales Tax Payable         tax
  //
  // A wholly-immediate invoice omits 2100 and the schedule; a wholly-deferred
  // (annual) one omits the 4000 line — the same per-line split the cash path uses.
  //
  // A marked-paid-out-of-band invoice has no ledger-visible mechanics, so it
  // stays a no-op — {@link creditBalanceApplied} tells the two apart by the
  // balance delta and returns null for the out-of-band case, rather than
  // fabricating an entry the engine can't balance.
  //
  // This is specifically `charge` being ABSENT (null — Stripe always sends the
  // field, set to null, for these invoices). A charge present as an unexpanded
  // string id still throws below via getCharge — that is a caller error (forgot
  // to expand), not a credit-balance invoice.
  if (invoice.charge === null) {
    const applied = creditBalanceApplied(invoice);
    if (applied === null) {
      return { entries: [], schedule: null };
    }
    const taxAmount = invoice.tax ?? 0;
    const preTax = applied - taxAmount;

    // Recognize per line term, same basis as the cash path: immediate lines are
    // earned now (4000), longer lines defer to 2100 and draw down over their
    // term. A balance payment never crosses currencies (there is no balance
    // transaction), so the schedule anchors on the invoice currency with no FX
    // pro-rating. The single debit is the whole balance applied — no fee, no net
    // split — where the cash path debits 1010/6000.
    const { immediateCustomer, deferredCustomer } = partitionLineAmounts(invoice);
    const lineTotal = immediateCustomer + deferredCustomer;
    const immediatePreTax =
      lineTotal > 0 ? Math.round((preTax * immediateCustomer) / lineTotal) : preTax;
    const deferredPreTax = preTax - immediatePreTax;

    const draft: JournalLine[] = [
      { accountCode: '2200', side: 'debit', amount: cents(applied), memo: 'Customer credit balance applied' },
    ];
    if (immediatePreTax > 0) {
      draft.push({ accountCode: '4000', side: 'credit', amount: cents(immediatePreTax), memo: 'Subscription revenue (paid from credit balance)' });
    }
    if (deferredPreTax > 0) {
      draft.push({ accountCode: '2100', side: 'credit', amount: cents(deferredPreTax), memo: 'Deferred subscription revenue' });
    }
    if (taxAmount > 0) {
      draft.push({ accountCode: '2000', side: 'credit', amount: cents(taxAmount), memo: 'Sales tax collected' });
    }
    const entry: JournalEntry = {
      date: epochToUtcDate(event.created),
      currency: invoice.currency.toUpperCase(),
      memo: invoiceMemo(invoice),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: invoice.id,
      lines: sortLines(draft),
    };
    const schedule =
      deferredPreTax > 0
        ? buildRecognitionSchedule(
            event,
            invoice,
            cents(deferredPreTax),
            periodMonths(invoice),
            invoice.currency.toUpperCase(),
            undefined,
          )
        : null;
    return { entries: [entry], schedule };
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

  // Net-terms (B2B) invoice: revenue and the receivable were already booked at
  // invoice.finalized against 1100 Accounts Receivable. This payment just brings
  // in the cash (net of fee) and clears the receivable — no revenue is
  // recognized again, or it would be double-counted.
  //
  // FX on this path (settlement currency ≠ invoice currency) isn't modeled yet:
  // the receivable was parked in the invoice currency at finalization, so
  // clearing it in a different settlement currency would mix currencies within
  // 1100 and needs a 7000 rate delta. Refuse loudly rather than mis-post.
  if (invoice.collection_method === 'send_invoice') {
    if (bt.currency.toUpperCase() !== invoice.currency.toUpperCase()) {
      throw new Error(
        `B2B (send_invoice) invoice ${invoice.id} settled in ${bt.currency.toUpperCase()} ` +
          `but was billed in ${invoice.currency.toUpperCase()}; cross-currency B2B settlement ` +
          `is not yet supported (the 1100 receivable was booked in the invoice currency).`,
      );
    }
    const lines: ReadonlyArray<JournalLine> = sortLines([
      { accountCode: '1010', side: 'debit',  amount: net,              memo: 'Net to Stripe balance' },
      { accountCode: '6000', side: 'debit',  amount: fee,              memo: 'Stripe processing fee' },
      { accountCode: '1100', side: 'credit', amount: cents(bt.amount), memo: 'Accounts receivable cleared on payment' },
    ]);
    const entry: JournalEntry = {
      date: epochToUtcDate(event.created),
      currency: btCurrency,
      memo: invoiceMemo(invoice),
      sourceEventId: event.id,
      sourceEventType: event.type,
      sourceObjectId: invoice.id,
      lines,
    };
    return { entries: [entry], schedule: null };
  }

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
