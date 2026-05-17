# ledgerly

A pure TypeScript engine that converts Stripe webhook events into balanced double-entry journal entries, ready to export as **QuickBooks Online `JournalEntry`** JSON or **Xero `ManualJournal`** JSON.

Built for indie SaaS founders who want clean books without paying an accountant $500–$2,000/mo to reconcile Stripe data manually.

```
Stripe event  ─▶  mapEvent  ─▶  JournalEntry[]  ─▶  toQbo / toXero
```

180 tests · 13 event types · 25 fixtures · `pnpm typecheck` and `pnpm lint` clean.

## What it does

Given a Stripe `charge.succeeded` event:

```jsonc
{
  "id": "evt_3OqXYZ...",
  "type": "charge.succeeded",
  "data": { "object": {
    "id": "ch_3OqXYZ...",
    "amount": 10000,
    "balance_transaction": { "fee": 320, "net": 9680, /* ... */ },
    /* ... */
  }}
}
```

ledgerly produces a balanced 3-line journal entry:

```
Dr 1010 Stripe Clearing         $96.80
Dr 6000 Stripe Processing Fees   $3.20
Cr 4000 Subscription Revenue            $100.00
```

Then renders it as QBO JournalEntry JSON or Xero ManualJournal JSON, ready to push via each platform's accounting API.

## Quick start

### Install

```bash
pnpm add ledgerly stripe
```

### Use

```typescript
import {
  mapEvent,
  toQbo,
  toXero,
  type QboAccountMap,
  type XeroAccountMap,
} from 'ledgerly';

// Map ledgerly's 12 account codes to your real QBO / Xero accounts.
const qboAccountMap: QboAccountMap = {
  '1000': { qboId: '83', name: 'Checking' },
  '1010': { qboId: '84', name: 'Stripe Clearing' },
  '4000': { qboId: '101', name: 'Subscription Revenue' },
  '6000': { qboId: '201', name: 'Merchant Fees' },
  // ... (all 12 codes — see Chart of Accounts below)
};

const xeroAccountMap: XeroAccountMap = {
  '1000': { accountCode: '610' },
  '1010': { accountCode: '611' },
  '4000': { accountCode: '200' },
  '6000': { accountCode: '404' },
  // ... (all 12 codes)
};

// In your Stripe webhook handler:
function handleWebhook(event: Stripe.Event) {
  const result = mapEvent(event);

  for (const entry of result.entries) {
    const qboEntry = toQbo(entry, qboAccountMap);
    const xeroEntry = toXero(entry, xeroAccountMap);
    // POST to QBO Accounting API or Xero Accounting API,
    // or persist for later batch sync.
  }

  // Annual subscriptions also produce a recognition schedule:
  if (result.schedule) {
    for (const futureEntry of result.schedule.entries) {
      // Schedule each entry for posting on futureEntry.date
      // (this is a monthly Dr 2100 / Cr 4000 over 12 months).
    }
  }
}
```

### Pre-expand `balance_transaction` before calling `mapEvent`

ledgerly is a pure function. It performs no I/O and does not call the Stripe API. Your webhook receiver must expand the `balance_transaction` field (and other nested objects) before invoking the engine — otherwise `MissingExpansionError` is thrown.

Recommended pattern with the `stripe` Node SDK:

```typescript
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

app.post('/webhook', async (req, res) => {
  const event = stripe.webhooks.constructEvent(
    req.body,
    req.headers['stripe-signature'] as string,
    process.env.STRIPE_WEBHOOK_SECRET!,
  );

  // Expand the balance_transaction for charge events.
  if (event.type.startsWith('charge.')) {
    const chargeId = (event.data.object as Stripe.Charge).id;
    const expanded = await stripe.charges.retrieve(chargeId, {
      expand: ['balance_transaction'],
    });
    event.data.object = expanded;
  }
  // Similar expansion for invoice/dispute events — see Architecture below.

  const result = mapEvent(event);
  // ... persist / forward
  res.json({ ok: true });
});
```

## Supported events

| Event | Variants covered |
|---|---|
| `charge.succeeded` | standard, with-app-fee (Connect), zero-amount, trial-conversion |
| `charge.refunded` | partial, full, multi-refund-sequence |
| `charge.failed` | informational (no entries) |
| `charge.dispute.created` | informational |
| `charge.dispute.funds_withdrawn` | standard |
| `charge.dispute.funds_reinstated` | won-path |
| `charge.dispute.closed` | lost, won, warning_closed |
| `invoice.payment_succeeded` | monthly, annual-deferred, with-tax, annual-with-tax, with-app-fee, prorated-upgrade, prorated-downgrade |
| `invoice.payment_failed` | informational |
| `customer.subscription.updated` | informational |
| `customer.subscription.deleted` | informational |
| `payout.paid` | standard (USD) |
| `payout.failed` | standard |

Events outside this list throw `UnhandledEventError`. Multi-currency / FX conversion (`charge.succeeded fx-conversion`, `payout.paid multi-currency`) is explicitly deferred — see the design spec.

## Chart of accounts

| Code | Name | Type | Purpose |
|------|------|------|---------|
| 1000 | Operating Bank | Asset | Real bank where Stripe payouts settle |
| 1010 | Stripe Clearing | Asset | Stripe balance — received, not yet paid out |
| 1100 | Accounts Receivable | Asset | Reserved for B2B invoice-then-pay flows (deferred) |
| 1200 | Disputes Receivable | Asset | Funds withdrawn for active disputes, pending outcome |
| 2000 | Sales Tax Payable | Liability | Stripe Tax / VAT collected, owed to authorities |
| 2100 | Deferred Revenue | Liability | Annual sub unearned portion, drawn down monthly |
| 4000 | Subscription Revenue | Revenue | Recognized recurring revenue |
| 4100 | Application Fee Revenue | Revenue | Connect platform cut on connected charges |
| 4900 | Refunds Issued | Contra-Revenue | Refund offsets (separate from 4000 for net-revenue reporting) |
| 6000 | Stripe Processing Fees | Expense | Per-transaction Stripe fees from `balance_transaction.fee` |
| 6100 | Payment Disputes | Expense | Closed-lost writeoffs + non-refundable dispute fees |
| 7000 | FX Gain/Loss | Other Income | Currency conversion P&L (deferred — multi-currency not yet supported) |

Map these codes to your own QBO and Xero account IDs at integration time via the `accountMap` parameter on each exporter.

## Architecture

```
mapEvent(event: Stripe.Event) ─▶ MapResult { entries: JournalEntry[], schedule: RecognitionSchedule | null }
```

Pure function. No state, no I/O, no Stripe API calls. Deterministic — same input always produces the same output.

Core invariants (test-enforced):

- Every emitted `JournalEntry` balances: `sum(debits) === sum(credits)` exactly (integer cents)
- Every entry has a non-empty `memo` and a `sourceEventId` starting with `evt_`
- Every `accountCode` is in the canonical `AccountCode` literal union (compile-time)
- All `Cents` values are integers (enforced by the `cents()` constructor)
- Same input → byte-identical JSON output across runs

Engine assumptions:

- **Integer minor units throughout** — `Cents = number & { readonly __brand: 'cents' }` prevents accidentally passing dollars where cents are expected
- **Single functional currency** — USD in MVP; multi-currency conversion deferred to a future phase
- **Caller pre-expands nested objects** — `balance_transaction` (and refund / dispute / invoice nested objects) must be expanded before invocation; the engine throws `MissingExpansionError` otherwise
- **Caller handles event deduplication** — Stripe redelivers; ledgerly is stateless, so the caller stores processed `event.id`s

For the full design rationale, decisions log, and invariants, see [`docs/superpowers/specs/2026-05-16-ledgerly-engine-design.md`](docs/superpowers/specs/2026-05-16-ledgerly-engine-design.md).

## Public API

Imported from `ledgerly` (after build, the barrel is at `dist/index.js`):

| Symbol | Kind | Purpose |
|---|---|---|
| `mapEvent` | function | Dispatch a Stripe event to its handler |
| `UnhandledEventError`, `MissingExpansionError` | class | Engine errors |
| `requireExpanded` | function | Helper for handlers that consume nested objects |
| `cents`, `ZERO_CENTS` | function/const | Constructor + zero value for the `Cents` type |
| `Cents` | type | Branded integer minor units |
| `ACCOUNTS` | const | Canonical chart of accounts (12 entries) |
| `AccountCode`, `AccountType`, `AccountDef`, `PostingSide` | type | Account types |
| `checkBalance`, `assertBalanced` | function | Balance validators |
| `JournalLine`, `JournalEntry`, `RecognitionSchedule`, `MapResult`, `BalanceReport` | type | Core data shapes |
| `toQbo`, `toQboSchedule` | function | QBO API JournalEntry exporters |
| `toXero`, `toXeroSchedule` | function | Xero ManualJournal exporters |
| `QboAccountMap`, `XeroAccountMap` | type | Per-tenant account-ID mapping |
| `QboJournalEntry`, `QboLine`, `XeroManualJournal`, `XeroJournalLine` | type | Exporter output shapes |

## Scripts

```bash
pnpm test           # Run all 180 tests
pnpm test:watch     # Vitest in watch mode
pnpm typecheck      # tsc --noEmit (strict mode + verbatimModuleSyntax)
pnpm lint           # eslint over src/ and test/
pnpm format         # prettier --write
pnpm e2e:fixtures   # Just the fixture-driven engine + exporter tests
pnpm build          # Emit dist/ for library publication
```

## Tech stack

- Node 20+
- TypeScript (strict, NodeNext ESM, `verbatimModuleSyntax`)
- Vitest
- ESLint + Prettier
- `stripe` package (types only — no runtime dependency)

## Status

The engine MVP is **feature-complete** for the design spec's §6 event coverage matrix, excluding two explicitly deferred items: multi-currency FX conversion (touches the 7000 account) and B2B AR flows (touches the 1100 account).

What's next: a webhook receiver layer that wraps this engine — verifying Stripe signatures, deduplicating redelivered events, expanding nested objects via the Stripe API, and persisting results.

## License

TBD.
