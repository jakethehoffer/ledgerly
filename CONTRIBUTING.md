# Contributing to ledgerly

Thanks for your interest. Ledgerly is a small project run by a single
maintainer; the bar for contributions is "the test suite stays green and the
change fits the spirit of the existing codebase."

## Quick orientation

- **Stack:** Node 20+, TypeScript strict (`verbatimModuleSyntax`,
  `noUncheckedIndexedAccess`), pnpm 9, vitest. No frontend.
- **Architecture:** nine layers — engine → exporters → receiver → storage →
  scheduler → dispatchers → OAuth → observability → CLI. See the README's
  "Architecture" section for a diagram-friendly walk-through.
- **Style:** Prettier + ESLint. Run `pnpm format && pnpm lint` before opening
  a PR. The lint config catches several common footguns
  (`no-confusing-void-expression`, `no-floating-promises`, etc.) that the
  TypeScript compiler doesn't.
- **Tests:** add a fixture or unit test for any behavior change. Run
  `pnpm test` locally before pushing; CI runs the same suite plus a Docker
  image build.

## Dev setup

```bash
git clone https://github.com/jakethehoffer/ledgerly.git
cd ledgerly
pnpm install
pnpm test           # ~500 tests, ~2s on a recent laptop
pnpm test:coverage  # same tests + per-file v8 coverage report
pnpm typecheck
pnpm lint
pnpm build
```

Optional, for end-to-end smoke testing against real Stripe:

```bash
cp .env.example .env
# fill in STRIPE_SECRET_KEY + STRIPE_WEBHOOK_SECRET (run `stripe listen` first)
pnpm start
```

## Commit & PR conventions

- One logical change per PR. If two changes are independent, send two PRs.
- Commit subject is imperative ("add", "fix", "remove" — not "added"/"adds")
  and prefixed by area: `feat(<scope>): ...`, `fix(<scope>): ...`,
  `chore: ...`, `docs: ...`, `ci: ...`. The body is for the "why" — what
  problem is this solving, what alternatives did you consider, what's
  deferred.
- New features come with tests. Bug fixes come with a regression test.
- README updates accompany behavior changes that an operator would see.

## Adding a new event handler

1. Capture a real (sanitized) Stripe event payload and save it as
   `test/fixtures/<event>.event.json`. Also write a matching
   `.expected.json` describing what `mapEvent` should return.
2. Add the handler in `src/events/<area>/<name>.ts`. Keep it pure — no I/O,
   no globals. Throw `UnhandledEventError` for unsupported subtypes rather
   than returning empty results.
3. Wire it into `src/engine.ts` (the dispatch table) and
   `src/server/expand.ts` if it needs `balance_transaction` or other
   expansion before mapping.
4. Add `.qbo.json` and `.xero.json` golden fixtures if the event produces a
   cash entry that the exporters will see. Reference them from the
   `FIXTURES` arrays in `test/exporters/{qbo,xero}.spec.ts`.
5. Update README's "Supported events" table.

## Reporting bugs

Open an issue with a minimal repro: ideally a Stripe event JSON plus the
unexpected output. For accounting questions ("is this entry right?"),
include your chart-of-accounts assumption — the project's defaults are in
the README's "Chart of accounts" section, and the reasoning behind each
entry shape is documented in [`docs/accounting.md`](./docs/accounting.md).

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability reporting.

## License

By contributing you agree that your contributions will be licensed under
the project's Apache-2.0 license.
