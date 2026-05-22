# ledgerly

[![CI](https://github.com/jakethehoffer/ledgerly/actions/workflows/ci.yml/badge.svg)](https://github.com/jakethehoffer/ledgerly/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/jakethehoffer/ledgerly/graph/badge.svg)](https://codecov.io/gh/jakethehoffer/ledgerly)
[![Release](https://img.shields.io/github/v/release/jakethehoffer/ledgerly?display_name=tag&sort=semver)](https://github.com/jakethehoffer/ledgerly/releases/latest)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![Container](https://img.shields.io/badge/ghcr.io-jakethehoffer%2Fledgerly-blue?logo=docker&logoColor=white)](https://github.com/jakethehoffer/ledgerly/pkgs/container/ledgerly)

A pure TypeScript engine that converts Stripe webhook events into balanced double-entry journal entries, ready to export as **QuickBooks Online `JournalEntry`** JSON or **Xero `ManualJournal`** JSON.

Built for indie SaaS founders who want clean books without paying an accountant $500–$2,000/mo to reconcile Stripe data manually.

```
Stripe event  ─▶  mapEvent  ─▶  JournalEntry[]  ─▶  toQbo / toXero
```

589 tests · 13 event types · 35 fixtures · `pnpm typecheck` and `pnpm lint` clean.

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

### Run the service

ledgerly's primary form is a webhook receiver + scheduler that maps Stripe events and posts to QBO/Xero. The published, build-provenance-attested Docker image is the fastest path — see [Deployment](#deployment) for the full `docker run` / Docker Compose setup:

```bash
docker pull ghcr.io/jakethehoffer/ledgerly:v0.1.13
```

### Use the engine as a library

The pure mapping functions (`mapEvent`, `toQbo`, `toXero`) can also be embedded directly in your own webhook handler — install the package alongside the Stripe SDK:

```bash
pnpm add ledgerly stripe
```

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

**Tax-aware refunds:** to correctly book refunds of Stripe Tax-bearing charges (drains 2000 Sales Tax Payable proportionally instead of leaving phantom tax liability), expand the charge's invoice when handling `charge.refunded`:

```typescript
if (event.type === 'charge.refunded') {
  const chargeId = (event.data.object as Stripe.Charge).id;
  const expanded = await stripe.charges.retrieve(chargeId, {
    expand: ['balance_transaction', 'refunds.data.balance_transaction', 'invoice'],
  });
  event.data.object = expanded;
}
```

If `charge.invoice` is not expanded (a string ID or null), refunds are booked as a flat Dr 4900 / Cr 1010 — no tax split. This matches the engine's prior behavior for backwards compatibility. The built-in `expandEvent` helper in `src/server/expand.ts` already includes `'invoice'` in its `charge.refunded` expansion.

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

Events outside this list throw `UnhandledEventError`.

### Currency support

Ledgerly accepts charges, refunds, invoices, disputes, and payouts in any
currency Stripe supports. The handler reads the source currency directly from
the Stripe object and stamps `entry.currency` accordingly. For FX scenarios
(customer-facing currency ≠ account settlement currency, e.g. a Canadian-default
account charging in USD), handlers that have access to the underlying
`balance_transaction` derive amounts and currency from `bt.amount` / `bt.currency`
so the entry posts in the settlement currency and stays balanced.

The QBO and Xero exporters scale amounts according to the currency's minor-unit
precision via [`currencyMinorUnits`](./src/currency.ts):

- **Two-decimal** currencies (USD, EUR, GBP, CAD, AUD, ...) → divide by 100.
  See `charge_succeeded_eur`.
- **Zero-decimal** currencies (JPY, KRW, VND, ...) → no scaling; major unit
  IS the smallest unit. See `charge_succeeded_jpy`.
- **Three-decimal** currencies (BHD, KWD, JOD, ...) → divide by 1000.

Unrecognized currency codes fall back to two-decimal, matching Stripe's default
normalization.

Caveats:
- Realized FX gain/loss is recognized on **refunds** and **dispute
  withdrawals** when the FX rate moved between the original charge and the
  follow-up event. On both paths: the cash leg posts at the follow-up's
  rate (actual clawback / refund deduction), the receivable / revenue-offset
  leg posts at the original-charge rate (matching what was originally
  booked), and account `7000 FX Gain/Loss` absorbs the rate-movement delta.
  See the `charge_refunded_fx` and `dispute_funds_withdrawn_fx_rate_drift`
  fixtures. Both handlers fall back gracefully (no 7000 line) when the
  original `charge.balance_transaction` isn't expanded, so callers
  bypassing the receiver's `expand.ts` see no behavior change for
  same-currency events.
- **Multi-period FX recognition is not auto-computed**, but the engine
  exposes enough information that downstream tools with a home-currency
  rate source can do it themselves. When an FX invoice is recognized
  monthly, every cash entry AND every monthly recognition entry carries
  an optional `fxContext` field (`{ customerCurrency, customerAmount,
  settlementCurrency, settlementAmount }`) with **pro-rated** amounts —
  so an operator with a USD-home rate source for, say, a USD→CAD
  account can revalue each month's `settlementAmount` against that
  month's rate and post their own FX gain/loss against the
  `customerAmount` baseline. See the `invoice_payment_succeeded_annual_fx`
  fixture: a USD-1200 invoice settled in CAD at rate 1.30 produces 12
  recognition entries, each with `fxContext: { customerAmount: 10000,
  settlementAmount: 13000, ... }`. Same-currency events omit `fxContext`
  entirely, so their JSON is unchanged.
- **Cross-currency payouts** (Stripe converting between settlement
  currency and the destination bank's currency, e.g. a CAD-settling
  account paying out to a USD bank account) are **explicitly rejected
  with a clear error**. The receiver's `expand.ts` expands
  `payout.destination` so the engine can compare `destination.currency`
  against `payout.currency`; on a mismatch the handler throws. The
  alternative — silently producing a 1000/1010 transfer in the source
  currency that doesn't account for Stripe's FX fee — was worse than
  refusing. The design analysis, the recommended entry shape, and the
  exact payload to capture when reporting a real one live in
  [`docs/cross-currency-payouts.md`](./docs/cross-currency-payouts.md);
  implementation follows once a real cross-currency payout payload is
  available.
- The operator's QBO/Xero company file must have multi-currency enabled
  (and the relevant accounts configured for the foreign currency) before
  posting non-home-currency entries will succeed downstream. The QBO
  exporter sets `JournalEntry.CurrencyRef = { value: entry.currency }` on
  every entry; Xero infers the currency from each line's account.

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

## Webhook receiver

ledgerly ships with an optional Express-based webhook receiver that wraps the pure engine with everything you need to run a production Stripe webhook endpoint: signature verification, event deduplication, and per-event-type Stripe API expansion of the nested objects the engine requires. The receiver lives in `src/server/` and is intentionally **not** re-exported from the main `ledgerly` barrel — library consumers who only need `mapEvent` don't have to pull Express into their bundles.

Required environment variables:

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Used for API expansion calls (e.g. `stripe.charges.retrieve` with `expand`) |
| `STRIPE_WEBHOOK_SECRET` | Used to verify the `Stripe-Signature` header (HMAC over the raw body) |
| `PORT` | Optional; defaults to `3000` |

Run it:

```bash
pnpm build
pnpm start
# or, after publication:
npx ledgerly-server
```

Endpoints:

- `POST /webhook` — Stripe event endpoint. Verifies the signature, dedupes by `event.id`, expands nested fields via the Stripe API, then calls `mapEvent`. Returns `200` on success, `200 { duplicate: true }` for redeliveries, `200 { unhandled: true }` for events outside the supported list, `400` for missing/invalid signatures, and `500` for expansion or processing errors.
- `GET /health` — Liveness probe; returns `{ ok: true, dedupSize }`.
- `GET /metrics` — Prometheus text exposition format (see [Metrics](#metrics) below).

To embed the receiver in a larger Express app, import `createServer` directly:

```typescript
import Stripe from 'stripe';
import { createServer } from 'ledgerly/dist/server/index.js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);
const { app } = createServer({
  stripe,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
});
app.listen(3000);
```

**Production caveat:** the default deduplicator is an in-memory `Map` with a 7-day TTL. That's fine for development and single-instance deployments but loses state on restart and doesn't survive horizontal scaling. Either set `LEDGERLY_DB_PATH` to enable the bundled SQLite backend (see [Persistence](#persistence)) or pass a custom `storage` implementation via `createServer({ ..., storage })` for other backends.

### Persistence

The receiver persists two things: a record of processed Stripe event IDs (so redeliveries are deduplicated across restarts) and every journal entry emitted by `mapEvent` (so a downstream poster can batch-sync them to QBO/Xero, an audit job can review them, or a recognition-schedule poster can post future-dated entries on their scheduled date).

Two backends ship in the box, both implementing the same `Storage` interface (`src/server/storage/types.ts`):

- **In-memory** — the default. Fine for tests and quick demos; loses everything on restart.
- **SQLite** (via `better-sqlite3`) — opt-in by setting `LEDGERLY_DB_PATH`. Survives restarts, uses WAL mode, durable across crashes by SQLite default.

Enable SQLite:

```bash
export LEDGERLY_DB_PATH=/var/lib/ledgerly/ledgerly.db
pnpm start
```

When the variable is unset (or empty), the receiver falls back to in-memory and logs a warning at startup.

#### Schema

The SQLite backend manages three tables. `openSqliteDatabase(path)` applies the schema on open (idempotent via `CREATE TABLE IF NOT EXISTS`):

| Table | Purpose |
|---|---|
| `processed_events` | One row per Stripe `event.id` we've successfully processed. Backs the deduplicator. |
| `journal_entries` | One row per emitted immediate `JournalEntry`. Full entry JSON in `payload`; `date`, `currency`, `memo`, `source_event_type`, `source_object_id` denormalized for indexed querying. |
| `scheduled_entries` | Future-dated entries from a `RecognitionSchedule` (e.g. monthly draws against an annual subscription's deferred-revenue balance). `status` starts as `'pending'` and transitions to `'posted'` once a downstream poster pushes them. |

#### What gets persisted

After a successful `mapEvent`, the server calls `storage.persistMapResult(eventId, result)` which atomically (in a single SQLite transaction):

1. Inserts every entry in `result.entries` into `journal_entries`.
2. Inserts every entry in `result.schedule?.entries` (if present) into `scheduled_entries` with `status='pending'`.
3. Records the event ID in `processed_events`.

If any insert throws (disk full, constraint violation), the entire bundle rolls back and the event ID is *not* recorded — so Stripe's next redelivery retries cleanly.

For unhandled event types (where `mapEvent` throws `UnhandledEventError` because there's nothing to emit), the event ID is recorded but no entries are written — Stripe redeliveries of the same unhandled event still get the dedup short-circuit.

#### Querying

The `JournalEntryStore` interface exposes three query methods used by downstream consumers:

```typescript
import { openSqliteDatabase, sqliteStorage } from 'ledgerly/dist/server/storage/sqlite.js';

const db = openSqliteDatabase('/var/lib/ledgerly/ledgerly.db');
const storage = sqliteStorage(db);

// All immediate entries for a single Stripe event:
storage.entries.findByEventId('evt_3OqXYZ...');

// Every future-dated entry due on or before today (for a daily recognition job):
storage.entries.findPendingScheduled('2026-05-16');

// Mark one as posted once you've pushed it to QBO/Xero:
storage.entries.markScheduledPosted(42);
```

For ad-hoc audit queries, the schema is straightforward and the SQLite CLI works fine:

```bash
sqlite3 /var/lib/ledgerly/ledgerly.db \
  'SELECT id, date, memo FROM journal_entries ORDER BY id DESC LIMIT 20'
```

### Scheduler

ledgerly's engine emits future-dated recognition entries for annual subscriptions (12 monthly Dr 2100 / Cr 4000 entries spread over the year). The receiver persists them to the `scheduled_entries` table as `pending`. The scheduler is a background loop that polls for due entries and dispatches them via a pluggable handler.

Enable it by setting `LEDGERLY_SCHEDULER_ENABLED=true` alongside `LEDGERLY_DB_PATH`:

```bash
LEDGERLY_DB_PATH=./ledger.db \
LEDGERLY_SCHEDULER_ENABLED=true \
LEDGERLY_SCHEDULER_INTERVAL_MS=60000 \
pnpm start
```

The default dispatcher logs each due entry to console. Production deployments will replace it with a QBO/Xero API pusher — see `src/server/dispatchers/` for the contract.

**Contract:** dispatchers must be idempotent. The scheduler may invoke a dispatcher more than once for the same entry if a prior attempt failed after dispatch but before the database recorded the success.

**Retry behavior:** when a dispatcher throws, the scheduler increments the entry's attempt counter and schedules the next retry via exponential backoff (default: 60s × 2^(attempts-1), capped at 24h — so attempt 1 waits 60s, attempt 2 waits 120s, attempt 10 waits ~8.5h). After `maxAttempts` failures (default 10, configurable via `LEDGERLY_SCHEDULER_MAX_ATTEMPTS`), the entry is moved to the `failed` state — operator intervention required.

**Dead-letter queue:** entries in `status='failed'` are surfaced via the `/health` endpoint's `failedScheduled` counter and via raw SQL:

```sql
SELECT id, event_id, subscription_id, scheduled_date, attempts, last_error
  FROM scheduled_entries WHERE status = 'failed';
```

To re-queue a failed entry after fixing the underlying issue (e.g., a missing account in your account map):

```sql
UPDATE scheduled_entries
   SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL
 WHERE id = <id>;
```

A future iteration will add an admin API for this; for now, direct SQL is the pattern.

**Multi-process safety:** the scheduler assumes single-writer access to `scheduled_entries`. Running multiple scheduler instances against the same SQLite database may double-post entries. For multi-process deployments, use a separate locking mechanism or a queue-based dispatcher.

#### QBO API dispatcher

The default scheduler dispatcher logs entries to console. For production, swap in the QBO dispatcher which POSTs each entry to QuickBooks Online's `JournalEntry` endpoint.

Configure via env vars alongside the scheduler:

```bash
LEDGERLY_DB_PATH=./ledger.db \
LEDGERLY_SCHEDULER_ENABLED=true \
LEDGERLY_QBO_ACCESS_TOKEN=ya29.a0AfH6S... \
LEDGERLY_QBO_REALM_ID=4620816365209... \
LEDGERLY_QBO_ACCOUNT_MAP_JSON='{"1010":{"qboId":"83","name":"Stripe Clearing"}, ...}' \
LEDGERLY_QBO_API_BASE=https://sandbox-quickbooks.api.intuit.com \
pnpm start
```

All three of `LEDGERLY_QBO_ACCESS_TOKEN`, `LEDGERLY_QBO_REALM_ID`, and `LEDGERLY_QBO_ACCOUNT_MAP_JSON` must be set to enable the QBO dispatcher; if only some are set the CLI logs a warning and falls back to the console dispatcher. `LEDGERLY_QBO_API_BASE` is optional and defaults to the QBO production base URL — point it at `https://sandbox-quickbooks.api.intuit.com` for testing.

The `LEDGERLY_QBO_ACCOUNT_MAP_JSON` maps ledgerly's 12 account codes to your real QBO account IDs and display names. All 12 codes must be present.

**OAuth is not handled by ledgerly.** The access token must be obtained out-of-band (via QBO's OAuth 2.0 authorization code flow) and refreshed before expiry (QBO tokens expire hourly). For a real SaaS deployment, you'll need a separate OAuth service that stores refresh tokens per-tenant and rotates access tokens; that's a future iteration.

**Idempotency caveat:** QBO does not enforce `DocNumber` uniqueness by default. A scheduler retry after a partial failure could create duplicate journal entries. Mitigations: use QBO's idempotency support (currently in beta), or query for an existing entry by `DocNumber` before posting.

#### Xero API dispatcher

Like the QBO dispatcher, but for Xero's `ManualJournals` endpoint. Useful for indie SaaS founders outside the US (UK, AU, NZ — Xero's strongholds).

Configure via env vars alongside the scheduler:

```bash
LEDGERLY_DB_PATH=./ledger.db \
LEDGERLY_SCHEDULER_ENABLED=true \
LEDGERLY_XERO_ACCESS_TOKEN=eyJhbGciOiJSUzI1NiI... \
LEDGERLY_XERO_TENANT_ID=70784a6d-c1c5-... \
LEDGERLY_XERO_ACCOUNT_MAP_JSON='{"1010":{"accountCode":"611"}, ...}' \
LEDGERLY_XERO_STATUS=DRAFT \
pnpm start
```

All three of `LEDGERLY_XERO_ACCESS_TOKEN`, `LEDGERLY_XERO_TENANT_ID`, and `LEDGERLY_XERO_ACCOUNT_MAP_JSON` must be set to enable the Xero dispatcher; if only some are set the CLI logs a warning and falls back to the console dispatcher. `LEDGERLY_XERO_API_BASE` is optional and defaults to `https://api.xero.com` — Xero has no separate sandbox base (the demo company is a flag on the user's tenant).

The `LEDGERLY_XERO_ACCOUNT_MAP_JSON` maps ledgerly's 12 account codes to your Xero account codes. All 12 codes must be present.

`LEDGERLY_XERO_STATUS` is `DRAFT` (default — entries land as drafts for user review) or `POSTED` (entries go straight into the ledger). DRAFT is safer for initial integration; switch to POSTED once you trust the mapping.

**OAuth is not handled by ledgerly.** Obtain access tokens via Xero's OAuth 2.0 authorization code flow out-of-band, store refresh tokens per-tenant, and refresh access tokens before they expire (Xero tokens expire in 30 minutes). For a real SaaS deployment, you'll need a separate OAuth service; that's a future iteration.

**Idempotency:** Xero supports a native `Idempotency-Key` header which ledgerly populates with `scheduled_entry.id`. A scheduler retry after a partial failure is safe — Xero will deduplicate.

**Precedence:** if both QBO and Xero env vars are configured, the QBO dispatcher wins (CLI selects the first match). For multi-target deployments, run two ledgerly processes — one per target — each with its own env config.

#### OAuth setup (QBO + Xero)

The static-token dispatchers above are fine for one-off testing, but for production you don't want to be copy-pasting access tokens every hour. ledgerly ships a built-in OAuth 2.0 authorization-code flow for both QBO and Xero: an operator clicks "Connect" once, completes consent in their browser, and ledgerly stores the tokens in its database. The managed dispatcher refreshes access tokens automatically before they expire and retries once on `401` after a fresh refresh.

**Why OAuth?**

Without it, you'd have to obtain access tokens out-of-band (via Postman, a curl script, the provider's playground, etc.) and rotate them every 60 minutes (QBO) or 30 minutes (Xero) by manually exchanging refresh tokens. The OAuth flow automates all of that: storage holds the refresh token, the managed dispatcher exchanges it for a new access token whenever needed.

**1. Register an OAuth app in each provider's developer console.**

QBO ([https://developer.intuit.com/app/developer/dashboard](https://developer.intuit.com/app/developer/dashboard)):

- Create an app in the Intuit Developer dashboard
- Add a redirect URI:
  - Production: `https://your-domain.example.com/oauth/qbo/callback`
  - Development: `http://localhost:3000/oauth/qbo/callback`
- Copy the client ID + secret

Xero ([https://developer.xero.com/app/manage](https://developer.xero.com/app/manage)):

- Create an app in the Xero developer portal
- Add a redirect URI: `https://your-domain.example.com/oauth/xero/callback` (same pattern as QBO)
- Copy the client ID + secret

**The redirect URI you register must match the URI ledgerly advertises EXACTLY** (down to scheme, host, port, and path). Mismatches produce opaque errors at the provider's end.

**2. Generate a state signing secret.**

The OAuth `state` parameter is HMAC-signed to prevent callback hijacking. The secret must be at least 32 characters; generate one with:

```bash
openssl rand -base64 48
```

**3. Set environment variables.**

```bash
LEDGERLY_DB_PATH=/var/lib/ledgerly/ledgerly.db \
LEDGERLY_SCHEDULER_ENABLED=true \
LEDGERLY_OAUTH_STATE_SECRET=<48+ char secret> \
LEDGERLY_QBO_CLIENT_ID=ABcd1234... \
LEDGERLY_QBO_CLIENT_SECRET=A1b2C3d4... \
LEDGERLY_QBO_REDIRECT_URI=https://your-domain.example.com/oauth/qbo/callback \
LEDGERLY_QBO_ACCOUNT_MAP_JSON='{"1010":{"qboId":"83","name":"Stripe Clearing"}, ...}' \
LEDGERLY_XERO_CLIENT_ID=ABCDEF... \
LEDGERLY_XERO_CLIENT_SECRET=GHIJKL... \
LEDGERLY_XERO_REDIRECT_URI=https://your-domain.example.com/oauth/xero/callback \
LEDGERLY_XERO_ACCOUNT_MAP_JSON='{"1010":{"accountCode":"611"}, ...}' \
pnpm start
```

When `LEDGERLY_*_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT_URI` are all set for a provider, ledgerly:

- Mounts `GET /oauth/<provider>/start` and `GET /oauth/<provider>/callback` routes.
- Uses the `managed<Qbo|Xero>Dispatcher` for scheduler dispatch (reads tokens from storage, refreshes automatically). The account map env var is still required.

The static-token variables (`LEDGERLY_QBO_ACCESS_TOKEN`, `LEDGERLY_XERO_ACCESS_TOKEN`, etc.) continue to work for environments that prefer to manage tokens outside ledgerly — the OAuth client config takes precedence when both are set.

**4. Complete the consent flow.**

Visit `https://your-domain.example.com/oauth/qbo/start` (or `/oauth/xero/start`) in a browser. Sign in to the QBO / Xero org you want ledgerly to manage, approve the requested scopes, and the receiver will redirect back to the callback URL. On success you'll see a one-line "Connected" page; the receiver has now persisted the token set to the `oauth_tokens` table.

**5. The scheduler dispatches automatically.**

From this point on, the background scheduler dispatches due scheduled entries to QBO / Xero using the stored tokens. Access tokens are refreshed proactively (60 seconds before expiry) and reactively (on a `401` from the provider). Xero refresh tokens rotate on every use — ledgerly always persists the new pair before issuing further calls.

**Production caveats:**

- **HTTPS is required.** Intuit and Xero both reject HTTP redirect URIs except for `localhost`. Terminate TLS at a reverse proxy in front of ledgerly.
- **Redirect URI must match the registered value exactly.** A trailing slash, port mismatch, or `http` vs. `https` will produce a hard error at consent.
- **Tokens live in SQLite.** They sit in the `oauth_tokens` table at `LEDGERLY_DB_PATH`. Protect the file with appropriate filesystem permissions (mode `0600`, owned by the ledgerly service user) and include it in your backup strategy.
- **Single-tenant MVP.** Storage is keyed by `(provider, tenant_id)` and ready for multi-tenant deployments, but the managed dispatchers and CLI currently use the first stored token set per provider. Connecting to a different QBO realm / Xero org overwrites the existing row.
- **Refresh token revocation.** If an admin manually revokes the connection from the QBO / Xero side, the next refresh attempt will fail with `invalid_grant`. The scheduler will dead-letter the entry after `maxAttempts` failures (default 10); the operator must re-run the consent flow to restore the connection.

#### Production caveats

The persistence layer is intentionally minimal — it solves "don't lose events on restart" and "give me a queryable audit log of every journal entry" without dragging in a separate database server. Things it does *not* do:

- **No automatic backups.** `cp ledgerly.db ledgerly.db.bak` while the receiver is running is safe (SQLite WAL mode supports concurrent readers), but you need to schedule it yourself.
- **No schema migrations beyond the initial DDL.** The schema is set in stone for v0; future changes will need a versioned migration runner.
- **Single-writer.** SQLite is fine for one webhook receiver process. Horizontal scaling (multiple instances behind a load balancer) will need a real database — implement the `Storage` interface against Postgres / MySQL / DynamoDB to do that.
- **No retention policy.** `processed_events` and `journal_entries` grow without bound. For a small SaaS that's many years of data before it matters, but plan for it.
- **No PII redaction.** `JournalEntry.memo` may contain customer references inherited from Stripe (`subscriptionId`, `chargeId`). The receiver does not redact, encrypt, or otherwise sanitize — treat the database with the same care you'd give a Stripe export.

### Logging

The receiver, scheduler, and dispatchers all log through a small `Logger` interface so you can wire ledgerly to pino, winston, datadog, etc. without dragging a logger dependency into ledgerly itself:

```typescript
interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}
```

The default logger writes to `console.*` with an `info`-level threshold. Override the threshold by setting `LEDGERLY_LOG_LEVEL` to `debug`, `info`, `warn`, or `error` (invalid values warn once and fall back to `info`). The CLI constructs one logger at startup and threads it through `createServer`, `createScheduler`, and the dispatcher factories.

For containerized / cloud deployments, set `LEDGERLY_LOG_FORMAT=json` to switch the CLI to the built-in `jsonLogger`: one JSON object per line, written to stdout (debug/info) or stderr (warn/error), with the schema `{ts, level, msg, ...meta}`. Object-valued meta is merged into the root record (pino convention), Error instances are converted to `{name, message, stack}` so their fields survive `JSON.stringify`, and the standard fields (`ts`, `level`, `msg`) always win against meta keys with the same name. This format ingests directly into Datadog, CloudWatch, Loki, Splunk, and Vector without any parser configuration.

To plug in pino:

```typescript
import pino from 'pino';
import { createServer } from 'ledgerly/dist/server/index.js';
import type { Logger } from 'ledgerly/dist/server/logger.js';

const p = pino();
const log: Logger = {
  debug: (msg, meta) => p.debug(meta, msg),
  info:  (msg, meta) => p.info(meta, msg),
  warn:  (msg, meta) => p.warn(meta, msg),
  error: (msg, meta) => p.error(meta, msg),
};

const { app } = createServer({ stripe, webhookSecret, storage, log });
```

For tests, ledgerly also exports `silentLogger()` — a no-op `Logger` that discards everything.

### Metrics

The receiver exposes a `GET /metrics` endpoint in Prometheus text exposition format (v0.0.4). The default backend is an in-memory implementation with zero runtime dependencies — point a Prometheus scraper at the receiver and you get counters and gauges for free.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: ledgerly
    scrape_interval: 30s
    static_configs:
      - targets: ['localhost:3000']
```

Exposed metrics:

**Counters** (monotonically increasing; `_total` suffix per Prometheus convention):

- `ledgerly_webhook_received_total` — every inbound POST `/webhook`
- `ledgerly_webhook_duplicate_total` — events suppressed by the deduplicator
- `ledgerly_webhook_signature_error_total` — missing or invalid `Stripe-Signature` header
- `ledgerly_webhook_expansion_error_total` — Stripe API expansion failed
- `ledgerly_webhook_processed_total{type="<event.type>"}` — successful map + persist, partitioned by event type
- `ledgerly_webhook_unhandled_total{type="<event.type>"}` — event type outside the supported list
- `ledgerly_webhook_error_total{type="<event.type>"}` — `mapEvent` or persistence threw
- `ledgerly_scheduler_ticks_total` — scheduler tick invocations
- `ledgerly_scheduler_attempts_total` — dispatcher invocations across all ticks
- `ledgerly_scheduler_posted_total` — successful dispatches
- `ledgerly_scheduler_failed_total` — failed dispatches (sums retries and dead-letters)
- `ledgerly_scheduler_deadlettered_total` — entries transitioned to `'failed'` on this tick

**Gauges** (snapshot values; refreshed from storage on every scrape):

- `ledgerly_dedup_size` — current number of recorded event IDs
- `ledgerly_journal_entries` — count of persisted immediate journal entries
- `ledgerly_scheduled_pending` — pending future-dated entries
- `ledgerly_scheduled_failed` — dead-lettered scheduled entries

Override the namespace prefix (`ledgerly_`) by setting `LEDGERLY_METRICS_NAMESPACE`. Example: `LEDGERLY_METRICS_NAMESPACE=myapp` exposes `myapp_webhook_received_total`, etc.

**Production caveats:**

- **In-memory state is per-process.** Multi-process or horizontally scaled deployments will see each instance reporting its own counters. Either scrape each instance individually (Prometheus' `static_configs` supports this trivially) or implement the `Metrics` interface against a shared backend (statsd, push gateway).
- **No authentication on `/metrics`.** Anyone who can reach the endpoint can read the metrics. Use network-level access control (only your scraper can reach the port) or a reverse proxy with basic auth.
- **Bring your own backend.** To use prom-client, OpenTelemetry, or any other library, implement the `Metrics` interface against it and pass to `createServer({ ..., metrics })`. The receiver only calls `inc(...)` / `setGauge(...)` / `render()`, so swapping the implementation is a few lines:

  ```typescript
  import client from 'prom-client';
  import type { Metrics } from 'ledgerly/dist/server/metrics.js';

  const registry = new client.Registry();
  const counters = new Map<string, client.Counter<string>>();
  const gauges = new Map<string, client.Gauge<string>>();

  const metrics: Metrics = {
    inc(name, labels, value = 1) { /* lookup or create counter, .inc(labels, value) */ },
    setGauge(name, value, labels) { /* lookup or create gauge, .set(labels, value) */ },
    render() { return registry.metrics(); },
  };
  ```

### Admin endpoints

When `LEDGERLY_ADMIN_TOKEN` is set (min 32 characters), the receiver mounts
four operator-facing endpoints, all gated behind a constant-time bearer
comparison. When the env var is unset, the routes are not mounted at all —
unauthenticated requests get a generic 404 and the admin surface is invisible
to scanners.

- `GET /admin/entries?limit=N` — list immediate journal entries, newest-first.
  `limit` defaults to 50, capped at 500.
- `GET /admin/scheduled?status=pending|posted|cancelled|failed&limit=N` — list
  scheduled entries (recognition rows + immediate-dispatch rows). `status`
  defaults to `pending`.
- `GET /admin/scheduled/:id` — fetch one scheduled entry with full retry
  metadata (attempts, lastError, nextAttemptAt). 404 when not found.
- `POST /admin/scheduled/:id/retry` — re-queue a dead-lettered entry. Resets
  `status='pending'`, `attempts=0`, `lastAttemptedAt=null`, `nextAttemptAt=null`,
  `lastError=null`. The next scheduler tick picks it up. Idempotent on
  already-pending rows. 404 when the id does not exist.

  ```bash
  # See the most recent failed dispatches
  curl -H "Authorization: Bearer $LEDGERLY_ADMIN_TOKEN" \
       http://localhost:3000/admin/scheduled?status=failed

  # Re-queue scheduled entry id=42 after fixing the underlying issue
  # (e.g., revoked OAuth grant, missing account map entry)
  curl -X POST -H "Authorization: Bearer $LEDGERLY_ADMIN_TOKEN" \
       http://localhost:3000/admin/scheduled/42/retry
  ```

  Replaces the prior "edit SQLite by hand" recovery path documented under the
  scheduler's dead-letter section.

## Deployment

### Docker

Pre-built multi-arch images (linux/amd64 + linux/arm64) are published to
[GitHub Container Registry](https://github.com/jakethehoffer/ledgerly/pkgs/container/ledgerly)
on every tagged release:

```bash
# Pull a specific release (recommended for production):
docker pull ghcr.io/jakethehoffer/ledgerly:v0.1.0

# Or track latest stable:
docker pull ghcr.io/jakethehoffer/ledgerly:latest
```

The image is built from a multi-stage `Dockerfile`: the build stage installs
all dependencies, compiles TypeScript, and prunes devDependencies; the
runtime stage carries only `node:20-slim` + the pruned `node_modules` +
compiled `dist/`. It runs as a non-root user (UID 10001), exposes port
3000, and declares a `HEALTHCHECK` against `/health`. You can also build
locally from source:

```bash
docker build -t ledgerly:local .
```

Run it with persistent SQLite state:

```bash
docker volume create ledgerly-data

docker run -d --name ledgerly \
  -p 3000:3000 \
  -v ledgerly-data:/data \
  -e STRIPE_SECRET_KEY=sk_test_... \
  -e STRIPE_WEBHOOK_SECRET=whsec_... \
  -e LEDGERLY_OAUTH_STATE_SECRET="$(openssl rand -base64 48)" \
  -e LEDGERLY_ADMIN_TOKEN="$(openssl rand -base64 48)" \
  -e LEDGERLY_SCHEDULER_ENABLED=true \
  ghcr.io/jakethehoffer/ledgerly:v0.1.0
```

The image's default `LEDGERLY_DB_PATH=/data/ledger.db` matches the volume
mount point above. Add QBO/Xero env vars from `.env.example` to enable the
corresponding dispatchers — without them, the scheduler falls back to a
console dispatcher that logs entries instead of posting.

### Docker Compose (local dev)

`docker-compose.yml` ships in the repo for running ledgerly locally
without installing Node. Two terminals — `stripe listen` on the host
mints a fresh webhook signing secret per session and you feed it to
ledgerly via `.env`:

```bash
# Terminal 1 — forward Stripe webhooks to local ledgerly.
$ stripe listen --forward-to localhost:3000/webhook
> Ready! Your webhook signing secret is whsec_...

# Terminal 2 — paste the whsec_ value into .env, then bring up ledgerly.
$ cp .env.example .env
$ vi .env   # set STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (and others as needed)
$ docker compose up

# Anytime later, in any terminal — trigger a synthetic event.
$ stripe trigger charge.succeeded
```

Compose uses the GHCR image by default (`ghcr.io/jakethehoffer/ledgerly:latest`).
To build from the local Dockerfile instead — e.g. when iterating on
ledgerly itself — uncomment the `build:` line in `docker-compose.yml`
and comment out `image:`, then `docker compose up --build`.

SQLite state lives in a named volume (`ledgerly-data`) that survives
`docker compose down`. To wipe state between tests, use
`docker compose down -v`.

**No `stripe-cli` sidecar by design.** `stripe listen` mints a new
webhook signing secret on every startup, which ledgerly needs at boot
to verify signatures. Wiring them together inside Compose would
require a shared volume + entrypoint wait script in the ledgerly
container — more complexity than it earns for a problem the documented
Stripe dev workflow already handles cleanly with the host-side `stripe
listen` above.

### Verifying the image (build provenance)

Every published image carries a [SLSA-style build provenance attestation](https://slsa.dev/spec/v1.0/provenance)
signed via Sigstore by the release workflow's OIDC identity. The attestation
binds the image's digest to the exact workflow run, commit SHA, and Dockerfile
that produced it — no long-lived signing key, nothing to rotate.

Verify before pulling into production:

```bash
gh attestation verify oci://ghcr.io/jakethehoffer/ledgerly:v0.1.13 \
  --repo jakethehoffer/ledgerly
```

A passing verification confirms the image was built by this repo's release
workflow on a tagged commit, not by an attacker who compromised the registry.

### Cross-platform builds

The published GHCR images cover both `linux/amd64` and `linux/arm64` natively
(M-series Macs deploying to ARM cloud instances, and vice versa, both pull
the right binary). If you're building locally with `docker build` on macOS
arm64 but deploying to linux/amd64, force the target platform:

```bash
docker buildx build --platform linux/amd64 -t ledgerly:local .
```

`better-sqlite3` is a native module; the published images ship prebuilt
bindings for both supported architectures.

### Health and readiness probes

Two endpoints distinguish "process alive" from "ready to serve":

- `GET /health` — always 200; body includes dedup size + entry counts. Suitable for Docker's `HEALTHCHECK` (which the image already declares) and as a Kubernetes `livenessProbe`. Storage counts are observability sugar, not a readiness gate — slow counts won't restart your pod.
- `GET /readyz` — 200 if the storage backend responds to a cheap reachability ping (SQLite: `SELECT 1`; in-memory: no-op), 503 otherwise with the error message under `checks.storage`. Use as a Kubernetes `readinessProbe` so a corrupt or unmounted SQLite file pulls the pod out of the load balancer without triggering a liveness restart.

```yaml
# Kubernetes pod-spec excerpt
livenessProbe:
  httpGet: { path: /health, port: 3000 }
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet: { path: /readyz, port: 3000 }
  initialDelaySeconds: 5
  periodSeconds: 10
```

### Behind a reverse proxy

The Stripe webhook handler verifies signatures against the raw request body.
Any reverse proxy in front of ledgerly (nginx, Caddy, Cloudflare, Traefik,
...) must pass `POST /webhook` through unmodified — no buffering, no body
rewrites, no JSON normalization. Other routes are well-behaved JSON and need
no special handling.

### Required environment

| Variable | Required for |
|---|---|
| `STRIPE_SECRET_KEY` | Webhook expansion (always) |
| `STRIPE_WEBHOOK_SECRET` | Signature verification (always) |
| `LEDGERLY_DB_PATH` | SQLite persistence (defaults to `/data/ledger.db` in the image) |
| `LEDGERLY_OAUTH_STATE_SECRET` | Required if using QBO/Xero OAuth |
| `LEDGERLY_ADMIN_TOKEN` | Required if using `/admin/*` endpoints (≥32 chars) |
| `LEDGERLY_SCHEDULER_ENABLED` | Set to `true` to actually post entries to QBO/Xero |

The CLI exits at startup if `STRIPE_SECRET_KEY` or `STRIPE_WEBHOOK_SECRET` is
missing, or if any partial-config conditions are detected (e.g. some QBO
OAuth vars set but not all). See `.env.example` for the complete inventory.

## Scripts

```bash
pnpm test           # Run all tests
pnpm test:watch     # Vitest in watch mode
pnpm typecheck      # tsc --noEmit (strict mode + verbatimModuleSyntax)
pnpm lint           # eslint over src/ and test/
pnpm format         # prettier --write
pnpm e2e:fixtures   # Just the fixture-driven engine + exporter tests
pnpm build          # Emit dist/ for library publication
pnpm start          # Run the built webhook receiver (requires pnpm build first)
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

Copyright 2026 Jake Hoffman

Licensed under the Apache License, Version 2.0 — see [LICENSE](LICENSE) for the full text.
