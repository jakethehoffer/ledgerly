// ledgerly quickstart — watch the engine work with no Stripe account.
//
//   pnpm demo
//
// Feeds one realistic (expanded) charge.succeeded event through the engine,
// prints the balanced journal entry it produces, proves debits == credits,
// then renders the QuickBooks Online and Xero JSON you'd push to each API.
//
// Everything here is the real published API. `import ... from 'ledgerly'`
// resolves to this package's own build via its exports map, so the code
// below is byte-for-byte what you'd write after `npm i ledgerly`.

import { mapEvent, toQbo, toXero, checkBalance, ACCOUNTS } from 'ledgerly';

// ---------------------------------------------------------------------------
// 1. A Stripe charge.succeeded event, with balance_transaction expanded.
//    ($100.00 charge, $3.20 Stripe fee, $96.80 net to your Stripe balance.)
//    In production your webhook receiver expands this; the engine never
//    calls Stripe itself. See the README's "Pre-expand balance_transaction".
// ---------------------------------------------------------------------------
const event = {
  id: 'evt_demo_charge_succeeded',
  object: 'event',
  api_version: '2024-12-18.acacia',
  created: 1736942400,
  type: 'charge.succeeded',
  livemode: false,
  pending_webhooks: 1,
  request: { id: null, idempotency_key: null },
  data: {
    object: {
      id: 'ch_demo_001',
      object: 'charge',
      amount: 10000,
      amount_captured: 10000,
      amount_refunded: 0,
      application_fee_amount: null,
      balance_transaction: {
        id: 'txn_demo_001',
        object: 'balance_transaction',
        amount: 10000,
        available_on: 1737158400,
        created: 1736942400,
        currency: 'usd',
        exchange_rate: null,
        fee: 320,
        fee_details: [
          {
            amount: 320,
            application: null,
            currency: 'usd',
            description: 'Stripe processing fees',
            type: 'stripe_fee',
          },
        ],
        net: 9680,
        reporting_category: 'charge',
        status: 'available',
        type: 'charge',
      },
      captured: true,
      created: 1736942400,
      currency: 'usd',
      customer: 'cus_demo_001',
      metadata: {},
      paid: true,
      refunded: false,
      status: 'succeeded',
    },
  },
};

// ---------------------------------------------------------------------------
// 2. Your chart-of-accounts mapping. ledgerly emits 12 stable account codes;
//    you map each to your real QBO account ID / Xero account code once. The
//    placeholder IDs below stand in for yours.
// ---------------------------------------------------------------------------
const qboAccountMap = Object.fromEntries(
  Object.values(ACCOUNTS).map((a, i) => [a.code, { qboId: String(80 + i), name: a.name }]),
);
const xeroAccountMap = Object.fromEntries(
  Object.values(ACCOUNTS).map((a, i) => [a.code, { accountCode: String(600 + i) }]),
);

// ---------------------------------------------------------------------------
// 3. Map the event. Pure function: same input always yields the same output.
// ---------------------------------------------------------------------------
const result = mapEvent(event);

const usd = (c) => `$${(c / 100).toFixed(2)}`;
const rule = '-'.repeat(60);

console.log('\nINPUT  charge.succeeded');
console.log(`       $100.00 charge, $3.20 Stripe fee, $96.80 net\n`);

for (const entry of result.entries) {
  console.log(`JOURNAL ENTRY  ${entry.date}  ${entry.memo}`);
  console.log(rule);
  console.log('  ' + 'Account'.padEnd(32) + 'Debit'.padStart(11) + 'Credit'.padStart(11));
  console.log(rule);

  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of entry.lines) {
    const label = `${line.accountCode} ${ACCOUNTS[line.accountCode].name}`;
    const debit = line.side === 'debit' ? usd(line.amount) : '';
    const credit = line.side === 'credit' ? usd(line.amount) : '';
    if (line.side === 'debit') debitTotal += line.amount;
    else creditTotal += line.amount;
    console.log('  ' + label.padEnd(32) + debit.padStart(11) + credit.padStart(11));
  }

  console.log(rule);
  console.log('  ' + 'Totals'.padEnd(32) + usd(debitTotal).padStart(11) + usd(creditTotal).padStart(11));

  const report = checkBalance(entry);
  console.log(
    report.balanced
      ? `\n  balanced: debits ${usd(report.debitTotal)} == credits ${usd(report.creditTotal)}`
      : `\n  NOT BALANCED: difference ${usd(report.difference)}`,
  );

  // -------------------------------------------------------------------------
  // 4. Render for each accounting platform's API.
  // -------------------------------------------------------------------------
  console.log('\nQUICKBOOKS ONLINE JSON  (POST to the JournalEntry endpoint)');
  console.log(JSON.stringify(toQbo(entry, qboAccountMap), null, 2));

  console.log('\nXERO JSON  (POST to the ManualJournals endpoint)');
  console.log(JSON.stringify(toXero(entry, xeroAccountMap), null, 2));
}

console.log(
  '\nSwap in any of the 35 fixtures under test/fixtures/ (refunds, disputes,\n' +
    'multi-currency, annual subscriptions with a 12-month recognition schedule)\n' +
    'to see the other entry shapes.\n',
);
