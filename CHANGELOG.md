# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 means breaking changes can happen in any minor release.

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
