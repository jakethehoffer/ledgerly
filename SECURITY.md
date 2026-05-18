# Security policy

## Supported versions

The latest tagged release on the `master` branch is the only supported
version. Pre-1.0 means breaking changes can happen in any minor release;
security fixes go to the next minor, not as patch releases against older
minors.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability —
that lets exploitable details leak before a fix is available.

Email **14jakehoffman@gmail.com** with:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a minimal proof-of-concept.
- The affected version (tag or commit SHA).
- Whether you'd like credit in the release notes when the fix lands.

I'll acknowledge receipt within 7 days and aim to ship a fix (or publish a
coordinated-disclosure timeline) within 30 days for high-severity issues.

## In scope

- Signature-verification bypass on `POST /webhook`.
- Authentication bypass on `/admin/*` (the bearer-token gate, or routes
  becoming reachable when `LEDGERLY_ADMIN_TOKEN` is unset).
- OAuth state CSRF bypass on `/oauth/{qbo,xero}/callback`.
- SQL injection anywhere `better-sqlite3` is used with user-controlled
  input.
- Privilege escalation — e.g. a crafted webhook event causing the engine to
  emit journal entries the operator did not authorize.
- Token / secret leakage from the storage layer or log output.
- Dependency-supply-chain compromises that ship through `pnpm install`.

## Out of scope

- Self-DoS from misconfiguration (e.g. setting `LEDGERLY_SCHEDULER_INTERVAL_MS`
  too low).
- Issues that require already having operator secrets (Stripe API key,
  OAuth client secret, admin token, OAuth state secret).
- Vulnerabilities in upstream Stripe / QBO / Xero APIs themselves.
- Best-practice "you should also harden X" suggestions that aren't tied to
  an exploitable issue (open an issue for those — they're welcome, just not
  via the security channel).

## Disclosure

After a fix lands, I'll add a note to `CHANGELOG.md` describing the
vulnerability at a high level and the affected versions. Detailed technical
write-ups happen after enough operators have had time to update — typically
30–90 days post-fix.
