<!--
Thanks for the PR. Filling in the sections below makes review faster
and catches a few common gotchas before they cost a round-trip.

For docs-only or trivial fixes, you can shorten this — just leave a
clear summary and check the relevant boxes.
-->

## Summary

<!-- One paragraph: what does this change do, and why? Focus on the "why"
- the diff explains the "what". Link any related issue with `Closes #123`. -->

## Type of change

- [ ] Bug fix (regression test included)
- [ ] New feature (engine handler, exporter shape, server endpoint, ...)
- [ ] Refactor (no behavior change)
- [ ] Docs only
- [ ] CI / build / dependency

## Surfaces touched

- [ ] Engine (`src/events/**`, `src/engine.ts`)
- [ ] Exporter (`src/exporters/**`)
- [ ] Receiver (`src/server/index.ts`, `src/server/expand.ts`)
- [ ] Storage (`src/server/storage/**`)
- [ ] Scheduler / dispatchers (`src/server/scheduler.ts`, `src/server/dispatchers/**`)
- [ ] OAuth (`src/server/oauth/**`)
- [ ] Admin endpoints (`src/server/admin.ts`)
- [ ] Observability (`src/server/{logger,metrics}.ts`)
- [ ] Deployment (`Dockerfile`, `.github/workflows/**`)
- [ ] Docs (README, CONTRIBUTING, SECURITY, CHANGELOG)

## Behavior change for operators

<!-- If this changes anything an operator running ledgerly would notice
- new env var, different journal entry shape, new endpoint, breaking
config rename - call it out here. If "none", say so explicitly. -->

## Test coverage

- [ ] Added or updated unit tests
- [ ] Added or updated a fixture (`.event.json` + `.expected.json`)
- [ ] Added or updated exporter golden(s) (`.qbo.json` / `.xero.json` / `.schedule.*.json`)
- [ ] N/A — see explanation below

## Checks I ran locally

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test` (or `pnpm test:coverage`)
- [ ] `pnpm build`

## Docs

- [ ] README updated (if behavior change)
- [ ] CHANGELOG entry added under `## [Unreleased]` (or marked for the next patch release)
- [ ] N/A
