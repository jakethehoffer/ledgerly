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

#### Production caveats

The persistence layer is intentionally minimal — it solves "don't lose events on restart" and "give me a queryable audit log of every journal entry" without dragging in a separate database server. Things it does *not* do:

- **No automatic backups.** `cp ledgerly.db ledgerly.db.bak` while the receiver is running is safe (SQLite WAL mode supports concurrent readers), but you need to schedule it yourself.
- **No schema migrations beyond the initial DDL.** The schema is set in stone for v0; future changes will need a versioned migration runner.
- **Single-writer.** SQLite is fine for one webhook receiver process. Horizontal scaling (multiple instances behind a load balancer) will need a real database — implement the `Storage` interface against Postgres / MySQL / DynamoDB to do that.
- **No retention policy.** `processed_events` and `journal_entries` grow without bound. For a small SaaS that's many years of data before it matters, but plan for it.
- **No PII redaction.** `JournalEntry.memo` may contain customer references inherited from Stripe (`subscriptionId`, `chargeId`). The receiver does not redact, encrypt, or otherwise sanitize — treat the database with the same care you'd give a Stripe export.

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

TBD.
