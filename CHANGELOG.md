# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 means breaking changes can happen in any minor release.

## [Unreleased]

### Added

- **Void reversal for B2B invoices issued in error** (`invoice.voided`). A
  net-terms (`send_invoice`) invoice that is voided is now reversed as if never
  issued — the opposite of a write-off: Dr 4000 Subscription Revenue, Dr 2000
  Sales Tax Payable, Cr 1100 Accounts Receivable. Because a void only applies to
  an open, unpaid invoice, 1100 still holds the full gross from finalization, so
  reversing against the same gross zeroes every account the invoice touched.
  `charge_automatically` invoices never booked a receivable, so the event is a
  no-op for them. No new accounts, no account-map changes.
- **Stateful void reconciliation for deferred-schedule invoices** (bundled
  server). When a voided net-terms invoice carried a deferred-revenue schedule
  (part deferred to 2100, recognized monthly), the pure engine can't reverse it —
  a correct reversal depends on how much has already recognized and on cancelling
  the unposted schedule. The receiver now reconciles this against the ledger: it
  reverses recognized revenue (Dr 4000) and the remaining deferred balance (Dr
  2100), clears the receivable (Cr 1100), and transitions the still-pending
  schedule rows to a new `cancelled` status so the scheduler never recognizes
  against the voided invoice again — every account returns to zero regardless of
  when the void arrives. Read + cancel + post happen in one transaction. New
  storage methods `findScheduledBySubscription`, `cancelScheduled`, and
  `persistVoidReversal` (both the in-memory and SQLite backends).
- The **pure engine** still refuses a deferred-schedule void with a clear error
  (mirroring the cross-currency B2B refusal): a consumer calling the engine
  directly has no ledger to reconcile against. The refusal gate matches
  finalization's own `deferredPreTax > 0` test, so it triggers on exactly the
  invoices for which a schedule was built. A full server deployment never hits
  the refusal — the webhook routes those voids to the reconciler.

## [0.4.0] — 2026-07-08

### Added

- **Bad-debt write-off for uncollectible B2B invoices.** A net-terms
  (`send_invoice`) invoice marked `invoice.marked_uncollectible` now writes its
  receivable off to the new **6200 Bad Debt Expense** account (Dr 6200 / Cr
  1100). Revenue already recognized stays recognized — under accrual accounting
  you earned it on delivery; the customer's non-payment is an expense, not a
  revenue reversal. Because 1100 carries the full gross from finalization until
  the invoice is paid or written off (recognition moves 2100 → 4000 and never
  touches 1100), the write-off clears the receivable exactly regardless of how
  much has been recognized. `charge_automatically` invoices never booked a
  receivable, so the event is a no-op for them. (Voiding an invoice reverses the
  revenue and interacts with the recognition schedule; it remains unmodeled.)

### Changed

- **New account code `6200` Bad Debt Expense — the canonical chart now has 13
  accounts.** `QboAccountMap` / `XeroAccountMap` require an entry for every code,
  so account maps must add `6200`. This is a compile-time requirement for
  TypeScript consumers; at runtime the exporters only reference `6200` when an
  uncollectible event is processed, so existing maps keep working until then.
  Pre-1.0, this ships in a minor per the versioning note at the top of this file.

## [0.3.0] — 2026-07-07

### Added

- **B2B net-terms invoicing (accounts receivable).** Invoices with
  `collection_method = send_invoice` — issued now, paid later on terms — are now
  modeled on the accrual basis, using the previously-reserved `1100` account. At
  `invoice.finalized` the revenue is recognized against **1100 Accounts
  Receivable** (immediately-earned lines to 4000, longer-term lines deferred to
  2100 with a recognition schedule, sales tax to 2000); there is no cash or
  Stripe fee yet. At `invoice.payment_succeeded` the cash arrives net of the fee
  and clears 1100, with no second revenue recognition — so across the two events
  1100 nets to zero and revenue is recognized exactly once.
  `charge_automatically` invoices are unchanged: `invoice.finalized` is a no-op
  for them and revenue is still booked at payment, so every existing fixture is
  byte-identical. Cross-currency net-terms settlement (an invoice billed in one
  currency but paid in another) is rejected with a clear error rather than mixing
  currencies in the receivable; same-currency net-terms invoicing is fully
  modeled. The shared line-item recognition logic (per-line term classification
  and the deferred-revenue schedule) is now factored into `recognition.ts` so the
  finalization and payment handlers can't drift apart.

## [0.2.1] — 2026-07-04

### Fixed

- **One-off invoices no longer error on the webhook.** A pure one-time invoice —
  no subscription, every line a one-off item with an instant period
  (`period.start === period.end`) — tripped the "no line-item periods; cannot
  classify subscription term" guard and threw, 500ing the webhook and forcing
  Stripe to retry a legitimate invoice indefinitely (a one-off consulting or
  usage charge, say). Per-line recognition treats it as all-immediate and books
  it now; the term calculation is only reached once a genuinely deferred line
  exists, so it never sees a zero span. Monthly, annual, and mixed invoices are
  byte-identical.

## [0.2.0] — 2026-07-04

### Added

- **Per-line revenue recognition.** Recognition is now decided per invoice line
  item by each line's own billing span, instead of classifying the whole invoice
  by its longest line. A one-time charge billed alongside an annual subscription
  — a setup or onboarding fee on the same invoice — is recognized immediately
  (`4000`) while only the subscription line is deferred (`2100`) and drawn down
  over its term; previously the whole invoice was deferred over 12 months.
  Pre-tax revenue is split between immediate and deferred in proportion to each
  portion's share of the pre-tax line total, and sales tax stays wholly in `2000`
  at collection. Pure single-term invoices (all lines immediate, or all deferred)
  reduce to the existing monthly / annual paths with byte-identical output.

### Fixed

- **Dispute fee vs. disputed principal are now split by Stripe's `fee_details`,
  not by balance-transaction magnitude.** `funds_withdrawn` treated the largest
  balance transaction as the disputed principal and the rest as the fee, which
  inverts for a small-value dispute: a $9.99 charge incurs a ~$15 dispute fee, so
  the fee transaction is the larger one — parking $15 in `1200` Disputes
  Receivable and expensing $9.99, then stranding the receivable when the dispute
  resolved against `dispute.amount` (and, under FX, booking a phantom `7000`
  line). The fee is now identified by its `fee_details` type tag, so the split is
  correct regardless of which amount is larger. Existing standard and FX fixtures
  (principal > fee) are byte-identical.
- **Multi-refund sales-tax drainage no longer strands a penny under FX.** The
  cumulative tax allocation telescoped on per-refund settlement amounts
  (`Σ round(refundAmount × rate)`), which can drift a cent from the charge's
  balance-transaction amount, leaving `2000` off by ±1 after a full refund of a
  taxed sale. It now telescopes on customer-currency amounts (which sum exactly
  to the charge amount) with the settlement rate folded into the tax factor, so
  it drains to exactly the tax booked at charge time. Same-currency books are
  byte-identical.
- **Invoices paid with no charge are acknowledged instead of erroring.** An
  invoice paid entirely from the customer's credit balance or out of band
  (`charge` is `null`, `amount_paid > 0`) ran into the charge-expansion guard and
  threw `MissingExpansionError`, 500ing the webhook and putting Stripe into a
  perpetual retry loop. No cash moves through the Stripe balance on these and the
  engine doesn't model customer credit balances, so they now produce no entry,
  like the other no-accounting-impact events. A charge present as an unexpanded
  string id still throws — that's a caller error, not a credit-balance invoice.

### Security

- **The QBO OAuth callback success page now HTML-escapes the tenant id.** For QBO
  the tenant id is the `realmId` query parameter, which is attacker-controllable
  on the callback URL, so reflecting it verbatim into the page was a
  reflected-XSS vector. The value is now escaped before interpolation.

## [0.1.16] — 2026-06-10

### Fixed

- **Multi-refund sales-tax drainage no longer strands a penny in `2000` Sales
  Tax Payable.** Each refund reversed its own tax share as
  `round(refundAmount × taxRatio)`, rounded independently. Across a sequence of
  partial refunds those roundings drift: e.g. an `11000` charge carrying `825`
  tax, refunded as two `5500` halves, reversed `413 + 413 = 826` against the
  `825` collected — leaving `2000` at `−1` after a full refund instead of zero
  (and the reverse, stranding `+1`, for other splits). Sales-tax shares are now
  allocated with cumulative rounding —
  `round(cumulativeThrough × taxRatio) − round(cumulativeBefore × taxRatio)`,
  with refunds ordered by creation — so the reversals telescope to exactly the
  tax collected once the charge is fully refunded. Single-refund and
  no-tax-refund books are byte-identical (cumulativeBefore = 0 or taxRatio = 0).

## [0.1.15] — 2026-06-10

### Fixed

- **Duplicate webhook deliveries can no longer double-post journal entries.**
  Idempotency was enforced only by an in-memory `dedup.has()` pre-check that is
  separated from the dedup `record()` by the `await` that expands the event, so
  two concurrent deliveries of the same Stripe event could both pass the check
  and both persist — writing a duplicate set of journal and dispatch rows. The
  SQLite path made it worse by inserting all entries first and only
  `INSERT OR IGNORE`-ing the dedup row last, discarding the very signal that
  should have stopped it. `persistMapResult` is now the idempotency boundary on
  every backend: it claims the event ID atomically (SQLite via the
  `processed_events` primary key inside the existing transaction; in-memory via
  a synchronous guard) and writes entries only if it wins the claim, returning
  `{ duplicate }`. A delivery that loses the race writes nothing and the
  receiver acks it as a duplicate. No schema change; single-delivery behavior is
  unchanged.
- **FX dispute resolution no longer strands the `1200` Disputes Receivable
  clearing account.** When a charge settled in a currency different from the
  dispute's customer-facing currency, `funds_withdrawn` parked the receivable
  at the original charge rate (in settlement currency), but the resolution
  handlers released it at the wrong basis: `funds_reinstated` credited `1200`
  at the reinstatement-time rate, and a lost `closed` wrote it off using the
  customer-facing amount in the customer-facing currency. Both left a residual
  balance in `1200` across the dispute lifecycle, and the lost path also mixed
  two currencies within one account. Both handlers now release `1200` at the
  same original-charge-rate amount it was parked at, posting in the settlement
  currency: `funds_reinstated` books the actual funds returned to `1010` and
  routes the rate-movement delta to `7000` (FX gain/loss), and a lost `closed`
  writes the receivable off to `6100` at its carried value. The clearing
  account now nets to exactly zero on both the won and lost paths. Same-currency
  and unexpanded-charge disputes stay byte-identical. The shared original-rate
  computation is now factored into `disputeRate.ts` so the leg that parks the
  receivable and the legs that release it can never drift apart.

## [0.1.14] — 2026-05-28

### Changed

- **Server-only dependencies are now optional `peerDependencies`**
  ([#1](https://github.com/jakethehoffer/ledgerly/issues/1)). `express`,
  `better-sqlite3`, and `dotenv` moved out of `dependencies`, so
  `npm install ledgerly` for engine-only consumers (`mapEvent` /
  `toQbo` / `toXero`) no longer pulls in Express or the native
  `better-sqlite3` build — a fresh install drops from 109 packages to
  23. `stripe` is now a required `peerDependency` (the public types
  reference `Stripe.*`); installing it alongside ledgerly was already
  the documented pattern.

  **Breaking for npm consumers who run the bundled webhook receiver:**
  `npm install ledgerly` no longer installs the server's runtime
  dependencies. Install them explicitly —
  `pnpm add ledgerly express better-sqlite3 dotenv stripe` — or use the
  Docker image, which bundles them. The pure engine and the exporters
  are unaffected.
- The `Dockerfile` now assembles the server's production
  `node_modules` explicitly in the build stage (the server deps are no
  longer in `dependencies`, so `pnpm prune --prod` would otherwise drop
  them). Runtime image contents are unchanged.

## [0.1.13] — 2026-05-20

### Added

- **ledgerly is published to npm** — `pnpm add ledgerly` /
  `npm install ledgerly` now installs the engine and server. (v0.1.12
  was the first release, hand-published; from v0.1.13 on, publishing
  is automated — see below.)
- **Automated npm publishing.** `release.yml` now publishes the npm
  package on every `v*` tag push, alongside the existing GHCR image
  job. It runs `npm publish --provenance`, so the package carries a
  Sigstore-signed build-provenance attestation — the same supply-chain
  guarantee the container images already have. The npm job is
  push-only: npm rejects republishing an existing version, so a
  `workflow_dispatch` image re-run skips it.
- `package.json` metadata for a complete npm listing — `license`
  (Apache-2.0), `repository`, `homepage`, `bugs`, `keywords`,
  `author` — plus `CHANGELOG.md` in the published `files` and a
  `prepublishOnly` gate (typecheck + lint + test + build) so a broken
  or stale build can't be published.
- `docs/cross-currency-payouts.md` — design notes for the deferred
  cross-currency payout accounting: the analysis, the recommended
  journal-entry shape, and the exact Stripe payload to capture when
  reporting one.

### Fixed

- `bin` path no longer carries a `./` prefix
  (`"ledgerly-server": "dist/server/cli.js"`) — npm flagged the
  prefixed form at publish time. The published v0.1.12 bin still works
  (npm auto-corrected it); v0.1.13 onward publishes warning-free.

### Changed

- README Quick start restructured to lead with `docker pull` (the
  install path that always works) and to reflect the now-published
  npm package.

## [0.1.12] — 2026-05-20

### Added

- **`docker-compose.yml`** for running ledgerly locally without
  installing Node. Single `ledgerly` service using the published GHCR
  image, a named volume (`ledgerly-data`) for SQLite persistence, and
  `env_file: .env` for configuration. The README's new "Docker Compose
  (local dev)" subsection documents the two-terminal workflow: run
  `stripe listen` on the host to mint a webhook signing secret, paste
  it into `.env`, then `docker compose up`.

  No `stripe-cli` sidecar by design — `stripe listen` mints a fresh
  signing secret per session, which ledgerly needs at boot to verify
  signatures; bridging them inside Compose would need a shared volume
  + entrypoint wait script for more complexity than it earns. The
  compose file's header comment and the README both explain this so
  the next reader doesn't retry that approach.

### Changed

- Test coverage on the managed dispatchers (`managedQbo`,
  `managedXero`) raised from 80% to 100% branch coverage. Three tests
  per file now exercise the previously-untested branches: the
  `globalThis.fetch` fallback when no `fetch` is configured, the
  custom-`apiBase` forwarding path, and the `String(err)` coercion in
  the 401-retry catch when a non-Error value is thrown. No source
  changes — the branches were always reachable, just untested.
  Overall coverage: 93.23% statements, 88.94% branches.

## [0.1.11] — 2026-05-19

### Changed

- **Cross-currency payouts are now detected and rejected with a clear
  error** instead of silently producing wrong journal entries. Previously,
  a CAD-settling account paying out to a USD bank account would produce
  a clean-looking `1000 debit / 1010 credit` transfer in CAD that didn't
  account for Stripe's FX conversion fee or the destination amount. The
  journal balanced internally but didn't match the operator's actual
  books. The receiver's `expand.ts` now requests
  `expand: ['destination']` on payout events; both `payoutPaid` and
  `payoutFailed` compare `destination.currency` to `payout.currency` and
  throw on mismatch with the actual currencies plus a pointer to open an
  issue with the BT shape so the case can be modeled against real data.

  **This is not an implementation of cross-currency payouts** — the
  Stripe BT shape (FX fee inline on the payout BT vs separate adjustment
  BT, `destination_amount` semantics, reverse-conversion behavior on
  `payout.failed`) isn't documented well enough to implement against
  without real payloads. Refusing loudly is the honest interim: operators
  hitting this know immediately that their setup isn't supported, can
  open an issue with their actual BT structure, and the implementation
  can follow against real data.

### Added

- New `src/events/payouts/crossCurrency.ts` with
  `detectCrossCurrencyPayout` (returns the destination currency on
  mismatch, null otherwise) and `rejectCrossCurrencyPayout` (throw-on-
  mismatch convenience wrapper). Both payout handlers call the rejector
  immediately after extracting the payout, before any accounting work.

- New `test/events/payouts/crossCurrency.spec.ts` covering the detection
  logic across all 5 input shapes (string destination, null destination,
  same-currency object, mismatched currency, object missing currency)
  plus integration tests asserting `mapEvent` throws on cross-currency
  `payout.paid` / `payout.failed` and the actionable error message
  format. Sanity check: same-currency expanded destination still
  produces a normal 1000/1010 entry.

### Compatibility

Existing `payout_paid_standard` and `payout_failed_standard` fixtures
use string `destination` IDs (predate this expansion). They pass
byte-identical because the detector returns `null` on string
destinations, falling through to the same accounting as v0.1.10.
The `server.spec.ts` test suite mocks `stripe.payouts.retrieve` at
module scope so the existing webhook-flow tests stay off the Stripe
network now that payout events get expanded.

## [0.1.10] — 2026-05-19

### Added

- **`fxContext` is now populated consistently across all four
  FX-affected handlers**, not just `invoicePaymentSucceeded`. The field
  was introduced in v0.1.9 but only on invoice payments; this release
  closes the consistency hole by populating it on `chargeSucceeded`,
  `chargeRefunded`, and `disputeFundsWithdrawn` as well.

  Per-handler semantics:
  | Handler | `customerAmount` | `settlementAmount` |
  | --- | --- | --- |
  | `chargeSucceeded` | `charge.amount` | `bt.amount` |
  | `chargeRefunded` | `refund.amount` (per refund) | `|refund_bt.amount|` |
  | `disputeFundsWithdrawn` | `dispute.amount` | `actualClawback` |
  | `invoicePaymentSucceeded` | `invoice.amount_paid` (+ pro-rated per schedule entry) | `bt.amount` (+ pro-rated) |

  Note on dispute design: `fxContext.settlementAmount` is the
  **actual clawback at dispute time**, not the `expectedClawback`
  computed at the original-charge rate. `fxContext` describes the
  conversion that actually happened on the event; the realized FX
  gain/loss against the original is already captured by the 7000 line
  (when present). Two pieces of information, two slots.

- New `src/util/fxContext.ts` houses the shared `buildFxContext` +
  `withFx` helpers. Previously inlined in `invoicePaymentSucceeded`;
  now imported by all four FX-aware handlers.

- New fixture `charge_succeeded_fx` exercises the chargeSucceeded FX
  path end-to-end: USD-50 charge converted to CAD at rate 1.375 →
  CAD 68.75 entry with `fxContext { USD 5000 / CAD 6875 }`. Plus QBO
  and Xero exporter goldens.

### Changed

- Existing FX fixtures' `expected.json` regenerated to include the
  new `fxContext` field: `charge_refunded_fx`,
  `dispute_funds_withdrawn_fx`, `dispute_funds_withdrawn_fx_rate_drift`.
  Exporter (`.qbo.json` / `.xero.json`) goldens unchanged — the
  exporters ignore `fxContext`; it's engine-output metadata only.

### Compatibility

Same-currency events on all four handlers continue to omit `fxContext`
from their JSON output (`buildFxContext` returns `undefined`, `withFx`
returns the entry untouched). Every existing same-currency fixture
passes byte-identical to v0.1.9.

## [0.1.9] — 2026-05-19

### Added

- **`JournalEntry.fxContext`** (optional). When the source event involved
  an FX conversion (`charge.currency ≠ bt.currency`), entries now carry
  a structured `FxContext` field exposing both sides of the conversion:

  ```ts
  interface FxContext {
    readonly customerCurrency: string;     // uppercase ISO 4217
    readonly customerAmount: Cents;
    readonly settlementCurrency: string;
    readonly settlementAmount: Cents;
  }
  ```

  This is the engine's contribution to **multi-period FX recognition**.
  Ledgerly can't auto-compute month-by-month FX gain/loss on annual
  recognition schedules without external monthly rate lookups (Stripe
  only tells us the rate at the original charge moment). But it can —
  and now does — expose enough FX provenance on every recognition entry
  that a downstream tool with a home-currency rate source can compute
  the revaluation itself.

- Populated by `invoicePaymentSucceeded` on FX invoices:
  - **Cash entry**: full conversion (`customerAmount` = invoice
    `amount_paid`, `settlementAmount` = `bt.amount`).
  - **Each monthly recognition entry**: PRO-RATED amounts so per-month
    customer/settlement totals across the 12-entry schedule sum to the
    invoice's preTax exactly. Month 12 absorbs both customer-side AND
    settlement-side rounding remainders.

- New fixture `invoice_payment_succeeded_annual_fx` and its QBO + Xero
  cash and `.schedule` goldens. Scenario: USD-1200 invoice settled to
  CAD at rate 1.30, no tax. Cash entry: `1010 debit CAD 1513.20 /
  6000 debit CAD 46.80 / 2100 credit CAD 1560.00`. Each of the 12
  recognition entries: `2100 debit CAD 130 / 4000 credit CAD 130` plus
  `fxContext { USD 10000 / CAD 13000 }`.

### Changed

- README's currency caveats updated. Multi-period FX recognition moved
  from "spec-deferred" to "engine exposes the data; downstream computes
  the revaluation." Cross-currency payouts (Stripe converting between
  settlement currencies before bank delivery) remain deferred — they
  need real fixture data on Stripe's BT shape that ledgerly doesn't
  have.

### Compatibility

`fxContext` is **omitted entirely** from JournalEntry JSON when undefined
(same-currency events). All existing same-currency fixtures —
charge_succeeded_*, invoice_payment_succeeded_monthly / annual /
annual_with_tax / prorated_upgrade / prorated_downgrade / with_app_fee /
with_tax, the charge_refunded_* family, dispute_* — are byte-identical
to v0.1.8.

## [0.1.8] — 2026-05-19

### Added

- **Realized FX gain/loss is now recognized on dispute withdrawals**, not
  just refunds. When the FX rate moved between the original charge and
  the dispute, the `chargeDisputeFundsWithdrawn` handler routes the
  rate-movement delta to account `7000 FX Gain/Loss` — same accounting
  model as the refund path shipped in v0.1.7:

  - `1200 Disputes Receivable` debits the **original-rate** settlement
    amount (`dispute.amount × originalRate`), so it cleanly releases the
    receivable the original `chargeSucceeded` booked.
  - `1010 Stripe Clearing` credits the **dispute-time-rate** settlement
    that Stripe actually clawed back (`|clawbackBt.amount| + feeTotal`).
  - `6100 Payment Disputes` debits the dispute fee at the dispute rate.
  - `7000 FX Gain/Loss` absorbs the difference — debit on rate move
    against the operator (realized loss), credit on rate move in their
    favor (realized gain).

  See the new `dispute_funds_withdrawn_fx_rate_drift` fixture for a
  worked example: USD-50 charge at CAD 1.30 (CAD 65 receivable),
  disputed later at CAD 1.40 (CAD 70 clawed back) + C$20 dispute fee →
  `1200 debit 65, 6100 debit 20, 7000 debit 5, 1010 credit 90`.

- `expand.ts` now requests `charge.balance_transaction` on every
  dispute event (added to the existing `balance_transactions`
  expansion). The original charge's BT is what the handler needs to
  compute the rate Stripe used at charge time. Same one-line pattern
  that enabled the refund FX gain/loss work in v0.1.7.

- New fixture `dispute_funds_withdrawn_fx_rate_drift` plus QBO and
  Xero exporter goldens.

### Changed

- README's currency caveats updated. Refunds **and** dispute
  withdrawals are now both 7000-aware. The remaining deferrals
  (multi-period recognition rate drift, cross-currency payouts) are
  documented with their genuine blockers — multi-period drift would
  need a home-currency config or month-by-month rate lookups;
  cross-currency payouts need real fixture data on Stripe's BT shape.

### Compatibility

Same-currency dispute fixtures and the existing
`dispute_funds_withdrawn_fx` fixture (which has a string
`dispute.charge`) are **byte-identical** to v0.1.7. The handler's
graceful fallback — when `charge.balance_transaction` isn't expanded,
treat `expectedClawback = actualClawback` and skip the 7000 line —
preserves v0.1.6/v0.1.7 behavior for any caller bypassing `expand.ts`.
Same-currency disputes through `expand.ts` also produce no 7000 line
because their true rate is 1.0 and `fxDelta = 0` arithmetically.

## [0.1.7] — 2026-05-18

### Added

- **Account 7000 FX Gain/Loss is now actually posted to.** Realized FX
  gain/loss is recognized on refunds when the FX rate moved between the
  original charge and the refund. The `chargeRefunded` handler now reads
  the original charge's `balance_transaction` (already expanded by the
  receiver's `expand.ts`), computes the rate Stripe used at charge time,
  and books each refund's three legs at the rates that match the
  underlying movement:

  - `4900 Refunds Issued` debits the **original-rate** settlement
    amount, so it cleanly offsets the original revenue booking (revenue
    nets to zero on a full refund).
  - `2000 Sales Tax Payable` debits the proportional tax portion at the
    same original-rate basis.
  - `1010 Stripe Clearing` credits the **actual** settlement (refund-rate)
    that Stripe clawed back.
  - `7000 FX Gain/Loss` absorbs the difference — debit when the rate
    moved against the operator (realized loss), credit when it moved in
    their favor (realized gain).

  See the `charge_refunded_fx` fixture for a worked example:
  $100 USD charge originally at rate 1.35 (CAD 135 booked), fully
  refunded later at rate 1.40 (CAD 140 clawed back), producing
  `4900 debit CAD 135 / 7000 debit CAD 5 / 1010 credit CAD 140`.

- New fixture `charge_refunded_fx` plus QBO and Xero exporter goldens.

### Changed

- README's currency caveat replaced with a precise scope statement:
  refunds are recognized; multi-period recognition rate drift, disputes
  settled at a different rate than the original charge, and
  cross-currency payouts still post in BT settlement currency without
  7000 lines (those would require state across events or additional
  config).

### Compatibility

Same-currency refunds are **byte-identical** to v0.1.6: when
`charge.currency == bt.currency`, both rates are exactly 1.0, the
expected and actual settlements match, and no 7000 line is emitted.
All 5 existing same-currency refund fixtures pass unchanged.

Callers bypassing `expand.ts` (where `charge.balance_transaction` is a
string ID rather than an expanded object) fall back to rate-1.0 and
skip the 7000 line — same-currency behavior unchanged; FX behavior in
that path just loses the FX recognition (not worse than v0.1.6).

## [0.1.6] — 2026-05-18

### Fixed

- **FX disputes are now supported.** `charge.dispute.funds_withdrawn`
  events whose `balance_transactions` are in a different currency than
  `dispute.currency` (the standard case for Connect platforms or any
  Stripe account where the customer-facing currency differs from the
  account's settlement currency) used to throw
  `"FX disputes not yet supported"`; they now produce balanced journal
  entries in the settlement currency.

  The previous fee-detection heuristic compared `|bt.amount|` against
  `dispute.amount`, which only works when both sides share a currency.
  The new heuristic identifies the clawback BT as the one with the
  largest `|bt.amount|` within the dispute-category set, and every
  other dispute-category BT contributes both its `|amount|` and its
  inline `fee` to the fee total. This works across the three documented
  Stripe BT shapes (single combined BT, split clawback + fee BTs, FX
  variants of either) without comparing amounts across currencies.

  The entry's `currency` field now derives from the BT settlement
  currency (not `dispute.currency`), so an FX dispute posts in the
  account's settlement currency — matching what the FX-safe
  `chargeSucceeded` handler already does for the original receivable.
  This keeps the `1200 Disputes Receivable` account single-currency in
  the operator's books.

  **Same-currency dispute behavior is unchanged**: the existing
  `dispute_funds_withdrawn_standard` fixture passes byte-identical. The
  new heuristic produces the same `(clawback, feeTotal, totalWithdrawn)`
  tuple as the old one when `bt.currency == dispute.currency`, for both
  single-BT and split-BT shapes.

### Added

- New fixture `dispute_funds_withdrawn_fx` covering a Canadian-settling
  account disputing a $50 USD charge with a split-fee CAD BT shape
  (C$68.75 clawback BT + C$20 fee BT = C$88.75 total withdrawn).
  Engine + QBO + Xero goldens validate end-to-end.
- Two defensive guards in `disputeFundsWithdrawn`: empty
  dispute-category BT array, and mixed-currency BT array. Both throw
  with clear messages rather than silently producing wrong entries.

### Notes

The FX implementation is best-effort against Stripe's
[documented BT shapes](https://stripe.com/docs/disputes/responding) for
dispute withdrawals; the synthetic fixture uses plausible amounts and
an exchange-rate hint. Operators hitting a real FX dispute whose BT
shape doesn't match (e.g. Stripe attaches a third BT for an unmodeled
adjustment) should open an issue with the actual BT structure so the
heuristic can be refined against real data.

`charge.dispute.closed` paths under FX without a preceding
`funds_withdrawn` still post in `dispute.currency` — that path doesn't
expand BTs the way `funds_withdrawn` does, so it can't reach the
settlement currency without an extra Stripe API call. Same caveat as
before.

## [0.1.5] — 2026-05-18

Patch release. Supply-chain hardening on the published Docker images;
no source-code or operator-visible behavior changes.

### Added

- **SLSA build provenance attestations on every GHCR image** via
  [`actions/attest-build-provenance@v2`](.github/workflows/release.yml).
  Sigstore signs each image's digest with the workflow's OIDC identity,
  binding the image to the exact commit + workflow run + Dockerfile that
  produced it. Attestations are pushed both to the registry
  (`push-to-registry: true`) and to the GitHub attestations API, so
  consumers can verify before pulling:

  ```bash
  gh attestation verify oci://ghcr.io/jakethehoffer/ledgerly:v0.1.5 \
    --repo jakethehoffer/ledgerly
  ```

  A passing verification confirms the image was built by this repo's
  release workflow on a tagged commit — defense against a registry
  compromise substituting a backdoored image at the same tag. No
  long-lived signing key is involved; the OIDC token Sigstore trusts
  is minted per-workflow-run.
- README: new "Verifying the image (build provenance)" subsection
  under Docker deployment with the verify command and a one-paragraph
  rationale (what the attestation proves vs what it doesn't).

### Notes

The v0.1.4 image was retroactively re-published with an attestation via
`workflow_dispatch` after the workflow change landed; `gh attestation
verify` against v0.1.4 also passes.

## [0.1.4] — 2026-05-18

Patch release. Test quality improvements driven by the v0.1.3 coverage
report — no source-code or operator-visible behavior changes.

### Added

- Schedule goldens for `invoice_payment_succeeded_annual_with_tax`
  ([`*.schedule.qbo.json`](test/fixtures/invoice_payment_succeeded_annual_with_tax.schedule.qbo.json)
  and `.schedule.xero.json`). Covers the tax-aware annual recognition
  path's distinctive rounding pattern: months 1-11 at $83.33, month 12
  absorbing the 4-cent remainder ($83.37) so the schedule sums to preTax
  ($1000) exactly. Tests now include a separate "schedule debit total
  equals preTax exactly" assertion that catches remainder-absorption
  bugs independently of the golden.
- Direct unit tests for `src/util/memo.ts` and `src/util/lines.ts`
  ([`test/util/memo.spec.ts`](test/util/memo.spec.ts),
  [`test/util/lines.spec.ts`](test/util/lines.spec.ts)). Both files
  reach 100% statement / branch / function / line coverage; the
  polymorphic-input branches (customer / destination / dispute.charge
  as null vs string id vs expanded object) and `sortLines`'s
  amount-descending tiebreaker now have direct coverage rather than
  relying on incidental hits from engine fixtures.
- Payload-validation tests for `src/server/oauth/state.ts`
  ([`test/server/oauth/state.spec.ts`](test/server/oauth/state.spec.ts)).
  Closes the post-HMAC validator coverage hole: an attacker with a
  leaked state secret can sign tokens with any body, so the JSON-parse
  / key-presence / type-check validators are the last line of CSRF
  defense. New tests craft tokens with valid signatures and malformed
  payloads (non-JSON body, null/primitive payload, missing keys,
  unrecognized provider, wrong-type nonce/expiresAt, short signature
  triggering the length guard before `timingSafeEqual`).

### Changed

- Overall coverage 92.69% / 85.87% → 93.17% / 87.53%
  (statements / branches). State.ts moved from 88.37% / 85.71% to
  97.67% / 97.36%; memo.ts from 88.23% / 66.66% to 100% / 100%;
  lines.ts from 85.71% / 90% to 100% / 100%.
- Test count 504 → 540 (+36).

## [0.1.3] — 2026-05-18

Patch release. Pure tooling and repo polish — no source-code or operator-
visible behavior changes since v0.1.2.

### Added

- **Code coverage reporting** via `@vitest/coverage-v8` (`pnpm test:coverage`).
  CI runs the suite with v8 coverage instrumentation and uploads `lcov.info`
  to Codecov via the `codecov/codecov-action@v5` action; for public repos
  the action uses GitHub OIDC, so no token is required. Baseline measured
  at 92.69% / 85.87% / 97.46% / 92.69% (statements / branches / functions /
  lines). Soft thresholds set ~5 points below the baseline so meaningful
  regressions get flagged without blocking PRs on noise.
- **README Codecov badge** next to the existing CI / Release / License /
  Container badges.
- **GitHub issue and PR templates**
  ([`.github/ISSUE_TEMPLATE/*`](.github/ISSUE_TEMPLATE),
  [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md)).
  Bug-report and feature-request YAML forms with structured fields;
  `config.yml` disables blank issues and routes security reports to
  [`SECURITY.md`](./SECURITY.md). PR template prompts authors to confirm
  the standard typecheck/lint/test/build checks plus the relevant docs +
  CHANGELOG updates.

## [0.1.2] — 2026-05-18

Patch release. The only operator-visible change is the QBO `DocNumber`
disambiguation; everything else is CI plumbing and test coverage.

### Fixed

- **`toQboSchedule` now assigns a unique `DocNumber` to each recognition
  entry.** Previously all 12 monthly entries in an annual schedule shared
  the same truncated `sourceEventId`-derived `DocNumber`, which broke
  reconciliation for QBO operators using `DocNumber` as a lookup key. The
  fix reserves the last 4 chars of QBO's 21-char budget for a `-mNN`
  suffix (`-m01` through `-m12`), yielding 12 distinct values within the
  limit. `toQbo`'s per-entry behavior is unchanged.

### Added

- Schedule goldens for `invoice_payment_succeeded_annual` covering both
  the QBO and Xero exporter outputs. The tests now do a full
  `toEqual(expected)` diff against the goldens instead of relying on
  per-entry shape checks alone — regressions in line memos, account
  refs, per-month amounts, or `CurrencyRef` will surface immediately.

### Changed

- CI workflows (`ci.yml`, `release.yml`) opt JavaScript-based actions into
  Node.js 24 via `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`, ahead of
  GitHub's June 2 2026 forced upgrade. Silences the "Node.js 20 actions
  are deprecated" warning on every run; if any action breaks under
  Node 24, the failure surfaces now rather than at the forced cutover.

## [0.1.1] — 2026-05-18

Patch release covering distribution and discoverability polish. No runtime
or engine behavior changes; the only source-of-truth surface that moved is
CI and docs.

### Added

- Multi-arch (linux/amd64 + linux/arm64) Docker images published to
  GitHub Container Registry on every `v*` tag push via
  [`.github/workflows/release.yml`](.github/workflows/release.yml).
  Operators can now `docker pull ghcr.io/jakethehoffer/ledgerly:v0.1.1`
  (or `:0.1.1`, or `:latest`) instead of building from source. Images
  carry OCI labels (`source`, `version`, `licenses=Apache-2.0`, `title`,
  `description`) so the GitHub Packages page renders correctly.
- README header badges: CI status, latest release, license, GHCR image.
- Updated README test-count stat from the stale 437/25 to the current
  504/30 (tests/fixtures).

### Changed

- README's Docker section now leads with `docker pull` from GHCR as the
  recommended production path; local `docker build` repositioned as a
  fallback. The cross-platform note updated to reflect that the
  published images already cover both architectures natively.

## [0.1.0] — 2026-05-18

Initial public release. Ledgerly is a Stripe-webhook-to-double-entry mapping
engine for indie SaaS founders — a pure TypeScript core that converts Stripe
events into balanced journal entries, paired with a persistent receiver,
background scheduler, OAuth-managed QBO / Xero dispatchers, admin endpoints,
structured logging, and a deployable Docker image.

### Engine

- `mapEvent(event)` maps Stripe events to balanced double-entry journal entries.
- Supported event types: `charge.succeeded` (standard, with-app-fee, zero-amount,
  trial-conversion), `charge.refunded` (partial, full, multi-refund, with-tax),
  `charge.failed` (informational), `charge.dispute.*` (created /
  funds_withdrawn / funds_reinstated / closed), `invoice.payment_succeeded`
  (monthly, annual-deferred, with-tax, prorated upgrade/downgrade, with-app-fee),
  `invoice.payment_failed`, `customer.subscription.updated`,
  `customer.subscription.deleted`, `payout.paid`, `payout.failed`.
- Annual subscription invoices generate a 12-month recognition schedule drawn
  down from `2100 Deferred Revenue` to `4000 Subscription Revenue`.
- Tax-aware refunds proportionally drain `2000 Sales Tax Payable`.
- FX-safe pattern: handlers with access to a `balance_transaction` derive
  amounts and entry currency from `bt.amount` / `bt.currency`, so a
  Canadian-settling Stripe account charging in USD posts balanced CAD
  entries.
- Multi-currency support for any Stripe-supported currency; exporters scale
  amounts according to the currency's smallest-currency-unit precision
  (2-decimal default, 0-decimal for JPY/KRW/VND/..., 3-decimal for
  BHD/KWD/JOD/...).

### Exporters

- QBO `JournalEntry` exporter (`toQbo`, `toQboSchedule`) emits `CurrencyRef`
  on every entry so multi-currency company files post in the correct currency.
- Xero `ManualJournal` exporter (`toXero`, `toXeroSchedule`) with
  `DRAFT` / `POSTED` status control.

### Webhook receiver

- Express-based `POST /webhook` with Stripe signature verification.
- Event deduplication (7-day TTL in-memory; persistent across restarts in
  SQLite).
- Atomic persistence: dedup record + journal entries + scheduled entries land
  in one transaction.
- `balance_transaction` auto-expansion via the Stripe SDK before mapping.

### Persistence

- SQLite backend (`better-sqlite3`) and in-memory backend behind a shared
  `Storage` interface.
- Schema migrations on startup.
- `persistMapResult` dual-writes immediate entries to both the journal-entry
  audit log AND the scheduled-entries dispatch queue (synthetic
  `subscription_id = "immediate:<sourceEventId>"`), so immediate entries flow
  through the same dispatcher path as recognition entries.

### Scheduler

- Background poller dispatches due `scheduled_entries` rows.
- Exponential backoff with configurable max-attempts
  (`LEDGERLY_SCHEDULER_MAX_ATTEMPTS`, default 10).
- Dead-letter queue (`status='failed'`) for entries that exhaust retries.

### Dispatchers

- Console dispatcher (default; logs entries rather than posting).
- QBO API dispatcher in static-token and OAuth-managed variants.
- Xero API dispatcher in static-token and OAuth-managed variants.
- Managed dispatchers refresh OAuth tokens automatically and persist refreshed
  tokens through the storage's `OAuthTokenStore`.

### OAuth flows

- `/oauth/{qbo,xero}/{start,callback}` endpoints.
- HMAC-signed state tokens (CSRF protection;
  `LEDGERLY_OAUTH_STATE_SECRET` ≥ 32 chars).
- Token sets persisted by `(provider, tenantId)` so a future multi-tenant
  deployment can hold many token sets per provider without schema churn.

### Admin endpoints

- Bearer-token-gated (`LEDGERLY_ADMIN_TOKEN` ≥ 32 chars; `timingSafeEqual`
  comparison).
- `GET /admin/entries?limit=N` — recent immediate entries.
- `GET /admin/scheduled?status=pending|posted|cancelled|failed&limit=N`.
- `GET /admin/scheduled/:id` — single-entry detail with full retry metadata.
- `POST /admin/scheduled/:id/retry` — re-queue dead-lettered entries.
- Routes return 404 (not 401) when the token is unset, hiding the surface
  from unauthenticated scanners.

### Observability

- `GET /health` — liveness + storage counters.
- `GET /readyz` — readiness with a cheap storage reachability ping; returns
  503 with the error message under `checks.storage` on failure.
- `GET /metrics` — Prometheus text exposition format.
- `Logger` interface with two built-in adapters: `consoleLogger`
  (human-readable, default) and `jsonLogger` (one JSON object per line for
  Datadog / CloudWatch / Loki / Splunk / Vector ingestion). The JSON adapter
  serializes `Error` instances properly and protects the standard `ts` /
  `level` / `msg` fields from accidental shadowing by meta keys.
- `LEDGERLY_LOG_LEVEL` (debug / info / warn / error) and `LEDGERLY_LOG_FORMAT`
  (console / json) configure the CLI logger.

### Deployment

- Multi-stage `Dockerfile` (`node:20-slim`), non-root user (UID 10001),
  declared `HEALTHCHECK` against `/health`, ~150 MB runtime image.
- `.dockerignore` keeps `.env`, `*.db`, and dev artifacts out of the build
  context.
- CI builds the image on every PR via `docker/build-push-action` with GHA
  cache.
- README "Deployment" section with a `docker run` example, cross-platform
  build guidance for macOS arm64 → linux/amd64, a reverse-proxy caveat for
  the webhook's raw-body requirement, and a Kubernetes pod-spec example
  wiring `livenessProbe` / `readinessProbe`.

### Tests

- 504 tests across 26 files, organized by architectural layer.
- Shared storage suite runs against both in-memory and SQLite backends.
- Fixture-driven engine tests: `.event.json` → `.expected.json` round-trips.
- QBO / Xero exporter golden tests covering 22 scenarios across charges,
  refunds, invoices, disputes, payouts, and non-USD currencies (EUR, JPY).

### Known limitations (deferred to a future release)

- FX disputes (dispute currency ≠ balance-transaction currency) are rejected
  by `disputeFundsWithdrawn` with a clear error — split-fee detection for the
  cross-currency case is not yet implemented.
- Direct `dispute.closed` paths under FX (when no preceding
  `funds_withdrawn` shielded the dispute) post in `dispute.currency`, which
  may not match the original charge's settlement currency.
- Proper FX gain/loss accounting via `7000 FX Gain/Loss` is not yet wired —
  rounding differences from FX-mismatched entries don't flow there.
- Schedule output is exercised by per-entry assertions; full `.schedule.*.json`
  goldens are a future addition.

[0.4.0]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.4.0
[0.3.0]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.3.0
[0.2.1]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.2.1
[0.2.0]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.2.0
[0.1.16]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.16
[0.1.15]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.15
[0.1.14]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.14
[0.1.13]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.13
[0.1.12]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.12
[0.1.11]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.11
[0.1.10]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.10
[0.1.9]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.9
[0.1.8]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.8
[0.1.7]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.7
[0.1.6]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.6
[0.1.5]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.5
[0.1.4]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.4
[0.1.3]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.3
[0.1.2]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.2
[0.1.1]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.1
[0.1.0]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.0
