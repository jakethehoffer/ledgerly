// ledgerly quickstart, watch the engine work with no Stripe account.
//
//   pnpm demo
//
// Walks two scenarios through the engine:
//   1. a one-time charge      → a simple 3-line journal entry + QBO/Xero JSON
//   2. an annual subscription → a deferred-revenue cash entry plus the
//                               12-month recognition schedule that releases it
//
// Everything here is the real published API. `import ... from 'ledgerly'`
// resolves to this package's own build via its exports map, so the code
// below is byte-for-byte what you'd write after `npm i ledgerly`. The engine
// never calls Stripe; your webhook receiver pre-expands the nested objects
// (balance_transaction, invoice.charge) before invoking it. See the README.

import { mapEvent, toQbo, toXero, checkBalance, ACCOUNTS } from 'ledgerly';

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
const usd = (c) => `$${(c / 100).toFixed(2)}`;
const rule = (n = 60) => '-'.repeat(n);

function banner(title) {
  console.log('\n' + '='.repeat(60));
  console.log(' ' + title);
  console.log('='.repeat(60));
}

function printEntry(entry) {
  console.log(`\n${entry.date}  ${entry.memo}`);
  console.log(rule());
  console.log('Account'.padEnd(34) + 'Debit'.padStart(13) + 'Credit'.padStart(13));
  console.log(rule());
  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of entry.lines) {
    const label = `${line.accountCode} ${ACCOUNTS[line.accountCode].name}`;
    const debit = line.side === 'debit' ? usd(line.amount) : '';
    const credit = line.side === 'credit' ? usd(line.amount) : '';
    if (line.side === 'debit') debitTotal += line.amount;
    else creditTotal += line.amount;
    console.log(label.padEnd(34) + debit.padStart(13) + credit.padStart(13));
  }
  console.log(rule());
  console.log('Totals'.padEnd(34) + usd(debitTotal).padStart(13) + usd(creditTotal).padStart(13));
  const report = checkBalance(entry);
  console.log(
    report.balanced
      ? `balanced: debits ${usd(report.debitTotal)} == credits ${usd(report.creditTotal)}`
      : `NOT BALANCED: difference ${usd(report.difference)}`,
  );
}

// Map ledgerly's 12 stable account codes to your real QBO account IDs / Xero
// account codes once. The placeholder IDs below stand in for yours.
const qboAccountMap = Object.fromEntries(
  Object.values(ACCOUNTS).map((a, i) => [a.code, { qboId: String(80 + i), name: a.name }]),
);
const xeroAccountMap = Object.fromEntries(
  Object.values(ACCOUNTS).map((a, i) => [a.code, { accountCode: String(600 + i) }]),
);

// ===========================================================================
// SCENARIO 1: one-time charge ($100.00, $3.20 Stripe fee, $96.80 net)
// ===========================================================================
banner('SCENARIO 1   One-time charge');

const chargeEvent = {
  id: 'evt_demo_charge',
  object: 'event',
  type: 'charge.succeeded',
  created: 1736942400,
  data: {
    object: {
      id: 'ch_demo_001',
      object: 'charge',
      amount: 10000,
      amount_refunded: 0,
      application_fee_amount: null,
      balance_transaction: {
        id: 'txn_demo_001',
        object: 'balance_transaction',
        amount: 10000,
        currency: 'usd',
        exchange_rate: null,
        fee: 320,
        net: 9680,
        type: 'charge',
        created: 1736942400,
      },
      captured: true,
      created: 1736942400,
      currency: 'usd',
      customer: 'cus_demo_001',
      paid: true,
      refunded: false,
      status: 'succeeded',
    },
  },
};

const charge = mapEvent(chargeEvent);
for (const entry of charge.entries) {
  printEntry(entry);
  console.log('\nQUICKBOOKS ONLINE JSON  (POST to the JournalEntry endpoint)');
  console.log(JSON.stringify(toQbo(entry, qboAccountMap), null, 2));
  console.log('\nXERO JSON  (POST to the ManualJournals endpoint)');
  console.log(JSON.stringify(toXero(entry, xeroAccountMap), null, 2));
}

// ===========================================================================
// SCENARIO 2: annual subscription ($1,200.00 paid up front)
// The cash hits now, but the revenue is earned over 12 months. ledgerly books
// the cash to Deferred Revenue (a liability) and emits a 12-month schedule
// that releases $100 to Subscription Revenue each month.
// ===========================================================================
banner('SCENARIO 2   Annual subscription with revenue recognition');

const annualEvent = {
  id: 'evt_demo_invoice_annual',
  object: 'event',
  type: 'invoice.payment_succeeded',
  created: 1736942400,
  data: {
    object: {
      id: 'in_demo_annual',
      object: 'invoice',
      amount_due: 120000,
      amount_paid: 120000,
      amount_remaining: 0,
      billing_reason: 'subscription_cycle',
      charge: {
        id: 'ch_demo_annual',
        object: 'charge',
        amount: 120000,
        balance_transaction: {
          id: 'txn_demo_annual',
          object: 'balance_transaction',
          amount: 120000,
          currency: 'usd',
          exchange_rate: null,
          fee: 3600,
          net: 116400,
          type: 'charge',
          created: 1736942400,
        },
        currency: 'usd',
        paid: true,
        status: 'succeeded',
      },
      created: 1736942400,
      currency: 'usd',
      customer: 'cus_demo_annual',
      lines: {
        object: 'list',
        data: [
          {
            id: 'il_demo_annual',
            object: 'line_item',
            amount: 120000,
            currency: 'usd',
            period: { start: 1736942400, end: 1768478400 }, // ~365 days
            proration: false,
            subscription: 'sub_demo_annual',
            type: 'subscription',
          },
        ],
        has_more: false,
        total_count: 1,
      },
      paid: true,
      status: 'paid',
      subscription: 'sub_demo_annual',
      total: 120000,
    },
  },
};

const annual = mapEvent(annualEvent);

console.log('\nCASH ENTRY (today). The $1,200 lands in Deferred Revenue, not Revenue:');
for (const entry of annual.entries) printEntry(entry);

const deferred = annual.entries[0].lines.find((l) => l.accountCode === '2100').amount;

console.log(`\nRECOGNITION SCHEDULE releases the $${(deferred / 100).toFixed(0)} deferred over 12 months`);
console.log('each entry: Dr 2100 Deferred Revenue  /  Cr 4000 Subscription Revenue');
console.log(rule(40));
let recognized = 0;
for (const entry of annual.schedule.entries) {
  const amount = entry.lines.find((l) => l.side === 'credit').amount;
  recognized += amount;
  console.log(entry.date.padEnd(28) + usd(amount).padStart(12));
}
console.log(rule(40));
console.log('total recognized'.padEnd(28) + usd(recognized).padStart(12));
console.log(
  recognized === deferred
    ? `\nthe schedule releases exactly what was deferred: ${usd(recognized)} == ${usd(deferred)}`
    : `\nMISMATCH: recognized ${usd(recognized)} != deferred ${usd(deferred)}`,
);

console.log(
  '\nThat is the whole engine in two events. Refunds (with proportional sales-tax\n' +
    'drains and realized FX gain/loss), disputes, payouts, and multi-currency charges\n' +
    'are all in test/fixtures/, feed any of those fixtures through mapEvent the\n' +
    'same way to see its entry shape.\n',
);
