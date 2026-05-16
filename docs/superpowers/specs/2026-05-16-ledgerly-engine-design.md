# Ledgerly Engine — Design Spec

**Date:** 2026-05-16
**Status:** Approved (pending written-spec review)
**Scope of this spec:** the pure Stripe→journal mapping engine + fixture-driven test harness. No UI, no auth, no DB, no live webhook receiving.

## 1. Goal

Convert Stripe webhook events into balanced double-entry journal entries, exportable as **QBO API JournalEntry JSON** and **Xero ManualJournal JSON**. Target user: indie SaaS founders who need clean books without paying $500–$2,000/mo for manual Stripe reconciliation.

## 2. Decisions Log

Resolved during brainstorming on 2026-05-16:

| # | Decision | Rationale |
|---|---|---|
| D1 | **QBO target = QBO Accounting API `JournalEntry` JSON** (not IIF). | IIF is QB Desktop only. QBO Online rejects it. JSON is what real SaaS customers will push. |
| D2 | **Multi-currency = functional currency only** (default USD). | Indie founders have one reporting currency; FX rounding diff goes to 7000 FX Gain/Loss. |
| D3 | **Money type = branded `Cents` over `number`**. | Safe up to ~$90T in USD cents; brand prevents dollar/cent mixups; JSON-serializable. |
| D4 | **Deferred revenue output = `{ entries, schedule? }`** struct. | Cash-time entries separated from future-dated recognition entries; downstream scheduler owns posting cadence. |
| D5 | **Engine consumes pre-expanded events.** Caller is responsible for expanding `balance_transaction` (and any other needed nested objects) via Stripe API before invoking the engine. | Keeps engine pure/offline; handlers throw with clear message if expected expansion is missing. |
| D6 | **Engine is a pure function**; dedup is caller's problem. | `mapEvent(event) => MapResult`. Deterministic, trivially testable. |
| D7 | **Accounts identified by both numeric code and name**; code is canonical. | Codes follow standard SaaS COA (1xxx/2xxx/4xxx/6xxx/7xxx). |
| D8 | **Amounts always positive; explicit `side: 'debit' | 'credit'`**. | Matches QBO's `PostingType`. Xero exporter applies sign flip at boundary. |
| D9 | **Balance threshold = exact zero** in integer minor units. | Original `$0.005` tolerance was for floating-point. With integer cents, equality is free and stricter. |
| D10 | **Unknown event types throw `UnhandledEventError`**. | Caller decides whether to log-and-skip or alert. No silent drops. |
| D11 | **No standalone `balance_transaction.created` handler**. FX computed inline from parent event's expanded balance_transaction. | Prevents double-posting; keeps the source-of-truth event clear. |
| D12 | **Subscription cancellation = informational only** (engine returns empty `MapResult`). | Schedule revision is downstream scheduler's job; engine has no state. |

## 3. Chart of Accounts

Functional currency: USD (configurable). Standard SaaS numeric coding.

| Code | Name | Type | Normal | Purpose |
|------|------|------|--------|---------|
| 1000 | Operating Bank | Asset | Debit | Real bank account where Stripe payouts settle |
| 1010 | Stripe Clearing | Asset | Debit | Stripe balance — received, not yet paid out |
| 1100 | Accounts Receivable | Asset | Debit | Invoiced-but-unpaid; reserved (rarely populated MVP) |
| 1200 | Disputes Receivable | Asset | Debit | Funds withdrawn for active disputes, pending outcome |
| 2000 | Sales Tax Payable | Liability | Credit | Stripe Tax / VAT collected, owed to authorities |
| 2100 | Deferred Revenue | Liability | Credit | Annual sub unearned portion, drawn down monthly |
| 4000 | Subscription Revenue | Revenue | Credit | Recognized recurring revenue |
| 4100 | Application Fee Revenue | Revenue | Credit | Connect platform cut on connected charges |
| 4900 | Refunds Issued | Contra-Revenue | Debit | Refund offsets (kept separate from 4000) |
| 6000 | Stripe Processing Fees | Expense | Debit | Per-txn Stripe fees (`balance_transaction.fee`) |
| 6100 | Payment Disputes | Expense | Debit | Closed-lost writeoffs + non-refundable dispute fees |
| 7000 | FX Gain/Loss | Other Income | Credit* | Net P&L from currency conversion rounding |

*FX 7000 swings both ways at runtime (FX gain → credit, FX loss → debit). The `normalBalance` field is set to `'credit'` for typing/exporter purposes only; handlers post either side based on the conversion direction.

### Sample postings

**Standard $100 charge, $3 Stripe fee, no tax:**
```
Dr 1010 Stripe Clearing        $97.00
Dr 6000 Stripe Processing Fees  $3.00
Cr 4000 Subscription Revenue           $100.00
```

**Annual $1,200 charge, $36 fee, deferred:**
```
Dr 1010 Stripe Clearing      $1,164.00
Dr 6000 Stripe Processing Fees   $36.00
Cr 2100 Deferred Revenue            $1,200.00
+ schedule: 12 monthly entries  Dr 2100 / Cr 4000 $100
```

**Partial $30 refund of the $100 charge:**
```
Dr 4900 Refunds Issued       $30.00
Cr 1010 Stripe Clearing             $30.00
```
(Stripe doesn't refund the original processing fee; 6000 stays.)

**Payout $97 Stripe → bank:**
```
Dr 1000 Operating Bank       $97.00
Cr 1010 Stripe Clearing             $97.00
```

**Dispute funds withdrawn ($100 + $15 dispute fee):**
```
Dr 1200 Disputes Receivable  $100.00
Dr 6100 Payment Disputes      $15.00
Cr 1010 Stripe Clearing             $115.00
```

**Dispute closed lost:**
```
Dr 6100 Payment Disputes     $100.00
Cr 1200 Disputes Receivable          $100.00
```

## 4. Core Data Types

### `Cents` — branded integer minor units

```typescript
// src/money.ts
export type Cents = number & { readonly __brand: 'cents' };

export function cents(n: number): Cents {
  if (!Number.isInteger(n)) {
    throw new RangeError(`Cents must be an integer, got ${n}`);
  }
  return n as Cents;
}

export const ZERO_CENTS = cents(0);
```

### `AccountCode` + `ACCOUNTS`

```typescript
// src/accounts.ts
export type AccountCode =
  | '1000' | '1010' | '1100' | '1200'
  | '2000' | '2100'
  | '4000' | '4100' | '4900'
  | '6000' | '6100'
  | '7000';

export interface AccountDef {
  readonly code: AccountCode;
  readonly name: string;
  readonly type: 'Asset' | 'Liability' | 'Revenue' | 'ContraRevenue' | 'Expense' | 'OtherIncome';
  readonly normalBalance: 'debit' | 'credit';
}

export const ACCOUNTS: Readonly<Record<AccountCode, AccountDef>> = {
  // ...one entry per code as listed in §3
};
```

### `JournalEntry` + `JournalLine`

```typescript
// src/journal.ts
export type PostingSide = 'debit' | 'credit';

export interface JournalLine {
  readonly accountCode: AccountCode;
  readonly side: PostingSide;
  readonly amount: Cents;           // always positive; side carries sign
  readonly memo?: string;
}

export interface JournalEntry {
  readonly date: string;            // ISO YYYY-MM-DD
  readonly currency: string;        // 'USD'
  readonly memo: string;            // required, human-readable
  readonly sourceEventId: string;   // 'evt_xxx'
  readonly sourceEventType: string; // 'charge.succeeded'
  readonly sourceObjectId?: string; // 'ch_xxx', 'in_xxx', 'po_xxx'
  readonly lines: ReadonlyArray<JournalLine>;
}
```

### `RecognitionSchedule`

```typescript
export interface RecognitionSchedule {
  readonly subscriptionId: string;       // 'sub_xxx'
  readonly sourceEventId: string;
  readonly entries: ReadonlyArray<JournalEntry>; // future-dated
}
```

### `MapResult`

```typescript
export interface MapResult {
  readonly entries: ReadonlyArray<JournalEntry>;
  readonly schedule: RecognitionSchedule | null;
}
```

### Balance helpers

```typescript
export interface BalanceReport {
  readonly debitTotal: Cents;
  readonly creditTotal: Cents;
  readonly difference: number;   // signed: + = excess debits
  readonly balanced: boolean;    // difference === 0
}

export function checkBalance(entry: JournalEntry): BalanceReport;
export function assertBalanced(entry: JournalEntry): void; // throws if !balanced
```

## 5. Engine + Handlers

```typescript
// src/engine.ts
import type Stripe from 'stripe';

export class UnhandledEventError extends Error {
  constructor(public readonly eventType: string, public readonly eventId: string) {
    super(`No handler registered for event type "${eventType}" (event ${eventId})`);
    this.name = 'UnhandledEventError';
  }
}

export class MissingExpansionError extends Error {
  constructor(field: string, eventId: string) {
    super(`Expected ${field} to be an expanded object in event ${eventId}, got string ID`);
    this.name = 'MissingExpansionError';
  }
}

type Handler = (event: Stripe.Event) => MapResult;

const HANDLERS: Readonly<Record<string, Handler>> = {
  'charge.succeeded': handleChargeSucceeded,
  'charge.refunded': handleChargeRefunded,
  'charge.failed': handleChargeFailed,
  'charge.dispute.created': handleDisputeCreated,
  'charge.dispute.funds_withdrawn': handleDisputeFundsWithdrawn,
  'charge.dispute.funds_reinstated': handleDisputeFundsReinstated,
  'charge.dispute.closed': handleDisputeClosed,
  'invoice.payment_succeeded': handleInvoicePaymentSucceeded,
  'invoice.payment_failed': handleInvoicePaymentFailed,
  'customer.subscription.updated': handleSubscriptionUpdated,
  'customer.subscription.deleted': handleSubscriptionDeleted,
  'payout.paid': handlePayoutPaid,
  'payout.failed': handlePayoutFailed,
};

export function mapEvent(event: Stripe.Event): MapResult {
  const handler = HANDLERS[event.type];
  if (!handler) throw new UnhandledEventError(event.type, event.id);
  const result = handler(event);
  result.entries.forEach(assertBalanced);
  result.schedule?.entries.forEach(assertBalanced);
  return result;
}
```

### Handler contract

Each handler is a pure function: `(event: Stripe.Event) => MapResult`.

1. Narrow `event.data.object` to the expected Stripe type.
2. Assert pre-expansion: any field documented as needing expansion must be an object, not a string. Throw `MissingExpansionError` otherwise.
3. Build entries in integer cents.
4. Call `assertBalanced` on each entry before returning (defense in depth; the engine re-asserts).

### Expected expansions by event

| Event | Required expanded fields |
|---|---|
| `charge.succeeded` | `data.object.balance_transaction` |
| `charge.refunded` | `data.object.balance_transaction`, each `refunds.data[].balance_transaction` |
| `invoice.payment_succeeded` | `data.object.charge.balance_transaction`, `data.object.lines.data[]` |
| `payout.paid` / `payout.failed` | (no expansion needed; payout itself has amount + currency) |
| `charge.dispute.*` | `data.object.balance_transactions[]` (note: array on dispute) |

## 6. Event Coverage Matrix (target ~50 fixtures)

| Event | Fixture variants |
|---|---|
| `charge.succeeded` | standard-usd, with-tax, with-app-fee, fx-conversion, zero-amount, trial-conversion |
| `charge.refunded` | full, partial, multi-refund-sequence |
| `charge.failed` | informational (no entries) |
| `charge.dispute.created` | informational |
| `charge.dispute.funds_withdrawn` | withdrawn |
| `charge.dispute.funds_reinstated` | reinstated |
| `charge.dispute.closed` | won, lost, warning_closed |
| `invoice.payment_succeeded` | monthly, annual-deferred, with-tax, with-app-fee, prorated-upgrade, prorated-downgrade |
| `invoice.payment_failed` | informational |
| `customer.subscription.updated` | informational |
| `customer.subscription.deleted` | informational |
| `payout.paid` | usd, multi-currency |
| `payout.failed` | failed |

Edge-case fixtures count separately: idempotent redelivery (same event twice), rounding-on-FX, mid-amount currency.

## 7. Exporters

Both pure functions, golden-file tested.

### QBO API JournalEntry

```typescript
// src/exporters/qbo.ts
export interface QboAccountMap {
  readonly [code: string]: { qboId: string; name: string };
}

export interface QboJournalEntry {
  TxnDate: string;
  DocNumber?: string;                       // event ID, truncated to 21 chars
  PrivateNote: string;
  Line: ReadonlyArray<{
    DetailType: 'JournalEntryLineDetail';
    Amount: number;                         // major units
    Description?: string;
    JournalEntryLineDetail: {
      PostingType: 'Debit' | 'Credit';
      AccountRef: { value: string; name: string };
    };
  }>;
}

export function toQbo(entry: JournalEntry, accountMap: QboAccountMap): QboJournalEntry;
export function toQboSchedule(schedule: RecognitionSchedule, accountMap: QboAccountMap): QboJournalEntry[];
```

### Xero ManualJournal

```typescript
// src/exporters/xero.ts
export interface XeroAccountMap {
  readonly [code: string]: { accountCode: string };  // Xero's own code (usually 1:1 with ours)
}

export interface XeroManualJournal {
  Narration: string;
  Date: string;
  Status: 'DRAFT' | 'POSTED';                // default 'DRAFT'
  JournalLines: ReadonlyArray<{
    LineAmount: number;                      // signed: + = debit, − = credit
    AccountCode: string;
    Description?: string;
  }>;
}

export function toXero(entry: JournalEntry, accountMap: XeroAccountMap): XeroManualJournal;
export function toXeroSchedule(schedule: RecognitionSchedule, accountMap: XeroAccountMap): XeroManualJournal[];
```

### Conversion rules

- **Major units:** `cents / 100` for USD. Divisor parameterized at export time (`{ minorUnits: 100 }`) for non-USD functional currencies. Out of scope for MVP.
- **DocNumber:** Stripe event ID, truncated to 21 chars (QBO limit). Xero has no equivalent constraint; reuse the same value as a `Reference` line if needed (deferred).
- **Sign flip:** Xero only. `debit` → `+amount`, `credit` → `-amount`.
- **Status:** Xero entries default `'DRAFT'` so the user reviews before posting; configurable.

## 8. Folder Layout

```
ledgerly/
  package.json                  pnpm, "type": "module"
  tsconfig.json                 strict, target ES2022, NodeNext
  vitest.config.ts
  .eslintrc.json, .prettierrc.json
  src/
    money.ts
    accounts.ts
    journal.ts
    engine.ts
    events/
      index.ts                  re-exports + HANDLERS registry
      charges/ {chargeSucceeded, chargeRefunded, chargeFailed}.ts
      disputes/ {disputeCreated, disputeFundsWithdrawn, disputeFundsReinstated, disputeClosed}.ts
      invoices/ {invoicePaymentSucceeded, invoicePaymentFailed}.ts
      subscriptions/ {subscriptionUpdated, subscriptionDeleted}.ts
      payouts/ {payoutPaid, payoutFailed}.ts
    exporters/ {qbo, xero, types}.ts
    util/ {fx, memo}.ts
  test/
    fixtures/                   {name}.event.json + {name}.expected.json + {name}.qbo.json + {name}.xero.json
    {engine, journal, money, accounts}.spec.ts
    exporters/{qbo, xero}.spec.ts
  docs/superpowers/specs/2026-05-16-ledgerly-engine-design.md
```

## 9. Build Order (TDD)

1. **Scaffold:** `pnpm init`, install dev deps (`typescript`, `vitest`, `eslint`, `prettier`, `stripe` for types), tsconfig with `strict: true`, vitest config, eslint config. Verify `pnpm test` runs with zero specs.
2. **`money.ts` + tests:** `cents()` rejects non-integer; brand prevents mixing.
3. **`accounts.ts` + tests:** snapshot of ACCOUNTS; account-code typing.
4. **`journal.ts` + tests:** `checkBalance` / `assertBalanced` on synthetic entries.
5. **`engine.ts` skeleton:** `HANDLERS` registry, `UnhandledEventError`, top-level balance recheck. Tests for unknown-event throw.
6. **First 5 handlers**, each red→green via fixture pair (`{name}.event.json` + `{name}.expected.json`):
   - `charge.succeeded` (standard-usd)
   - `charge.refunded` (partial)
   - `invoice.payment_succeeded` (monthly)
   - `invoice.payment_succeeded` (annual-deferred)
   - `payout.paid` (usd)
7. **Exporters:** `qbo.ts` + `xero.ts` with golden-file tests against `*.qbo.json` and `*.xero.json` for the same 5 fixtures.
8. **Expand to full ~50 fixtures** under the `/goal` exit condition.

## 10. Invariants (test-enforced)

- Every emitted entry balances: `checkBalance(entry).balanced === true`.
- Every entry has non-empty `memo` and a `sourceEventId` of form `evt_*`.
- Every `accountCode` is in `AccountCode` (compile-time) and `ACCOUNTS` (runtime).
- All `Cents` values are integers (enforced by constructor).
- QBO output: every entry's `Line[]` debit sum equals credit sum (in major units, integer-cents-aware comparison).
- Xero output: every entry's `JournalLines[]` `LineAmount` sum equals 0.
- Same event input → byte-identical JSON output across runs (determinism).

## 11. `/goal` exit condition (user-provided, verbatim)

```
pnpm test passes AND `pnpm run e2e:fixtures` shows zero diffs across every fixture in test/fixtures/
AND every emitted journal balances to within $0.005
AND `pnpm run typecheck` passes with zero errors
AND `pnpm run lint` passes
```

(Note: integer-cents arithmetic makes the `$0.005` tolerance equivalent to exact zero. Spec keeps user wording for traceability; implementation uses `=== 0`.)

## 12. Out of Scope (deferred to later sessions)

- Database persistence
- Authentication / multi-tenancy
- Live Stripe webhook receiving (signature verification, deduplication, retries)
- UI / dashboard
- Billing for the ledgerly SaaS itself
- Non-USD functional currencies (parameterized in design but not implemented)
- Stripe Connect: only platform-side handling via `application_fee_amount`. Connected-account perspective and `transfer.*` events deferred.
- `customer.subscription.updated` proration handling beyond what's already on `invoice.payment_succeeded` line items (complex mid-cycle credit balances are TODO).
- AR-first invoicing flow (`invoice.finalized` → AR; `invoice.payment_succeeded` → clear AR). MVP collapses both into the payment event.

## 13. References

- Stripe API events: `https://docs.stripe.com/api/events/types`
- Stripe balance_transaction (source of `fee`, `net`, `exchange_rate`): `https://docs.stripe.com/api/balance_transactions/object`
- QBO `JournalEntry` resource: `https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/journalentry`
- Xero `ManualJournal` endpoint: `https://developer.xero.com/documentation/api/accounting/manualjournals`
