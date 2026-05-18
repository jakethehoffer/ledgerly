# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Pre-1.0 means breaking changes can happen in any minor release.

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

[0.1.3]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.3
[0.1.2]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.2
[0.1.1]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.1
[0.1.0]: https://github.com/jakethehoffer/ledgerly/releases/tag/v0.1.0
