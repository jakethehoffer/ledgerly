# Customer Credit Balance — Design Spec

Status: ready to implement. Author: Claude (2026-07-08). Resolves the oldest
entry in [accounting.md#known-limitations](../../accounting.md) — "Customer
credit balances / out-of-band payments".

## 1. Problem

Stripe lets a customer carry a **credit balance**: an amount the business owes
them as future account credit rather than cash. Two events touch it, and
ledgerly models neither today:

- **Credit issued** — a *post-payment* credit note on an already-paid invoice can
  return money as customer credit (`credit_note.customer_balance_transaction`)
  instead of a cash refund. `credit_note.created` currently no-ops this case
  ([creditNoteCreated.ts](../../../src/events/creditNotes/creditNoteCreated.ts))
  because there is no account to hold the liability.
- **Credit consumed** — a later invoice paid from that balance arrives as
  `invoice.payment_succeeded` with `charge === null`, which
  [invoicePaymentSucceeded.ts:197](../../../src/events/invoices/invoicePaymentSucceeded.ts)
  no-ops (its comment literally cites the missing liability account).

The result: credit issued as balance silently drops revenue, and credit consumed
silently skips revenue recognition. This spec adds the account and both legs.

## 2. Decisions (accounting treatment)

**New account `2200 Customer Credit Balance`** — a **Liability** (normal balance
credit), sitting next to `2000 Sales Tax Payable` and `2100 Deferred Revenue`.
It holds credit the business owes customers but has not yet delivered against.
This mirrors how `6200 Bad Debt Expense` was added in v0.4.0 — a new code plus a
required entry in every exporter account map (compile-time break for TypeScript
consumers; document it in CHANGELOG "Changed" like 6200 was).

**Issue leg — post-payment credit note credited to balance.** The invoice was
paid (revenue recognized, cash in). Returning it as credit reverses the revenue
and books the liability; the cash already received stays put:

```
Dr 4000 Subscription Revenue     subtotal
Dr 2000 Sales Tax Payable        tax
Cr 2200 Customer Credit Balance  total
```

**Consume leg — invoice paid from the credit balance.** The customer spends the
credit; revenue is earned and the liability drains. No cash moves:

```
Dr 2200 Customer Credit Balance  amount applied from balance
Cr 4000 Subscription Revenue      pretax
Cr 2000 Sales Tax Payable         tax
```

Both legs balance (subtotal + tax = total). Over a credit's life the two legs
net 2200 to zero, and revenue is recognized exactly once — at consume time,
which is when the service is actually delivered.

## 3. The one genuinely open question — consume-side detection

`invoice.payment_succeeded` with `charge === null` covers **two** cases today:
paid-from-credit-balance (model it) and paid-out-of-band / marked-paid manually
(still a no-op — no ledger-visible mechanics). The handler must tell them apart
**before** booking, or it will fabricate revenue for out-of-band invoices.

Resolve during implementation against a **real Stripe payload** (do not guess):
candidate discriminators are the invoice's `starting_balance` / `ending_balance`
delta, `amount_paid` vs `paid_out_of_band`, or the applied-balance amount Stripe
exposes on the invoice. Pick the field that is populated exactly when Stripe
applied customer balance, and gate the consume leg on it. If it can't be
determined reliably, the consume leg **stays a no-op** and only the issue leg
ships (see slicing) — a growing-but-correct liability beats mis-recognized
revenue.

## 4. Scope

**In (Slice 1 — issue leg):** post-payment credit note whose credit goes
**entirely** to customer balance (`customer_balance_transaction` present,
`refund` null, `out_of_band_amount` 0), against a **non-deferred** invoice →
book Dr 4000 / Dr 2000 / Cr 2200. This is shippable alone: 2200 correctly
accrues outstanding credits even before the consume leg lands.

**In (Slice 2 — consume leg):** once §3 is resolved, `invoice.payment_succeeded`
paid-from-balance (non-deferred) → Dr 2200 / Cr 4000 / Cr 2000.

**Out (deferred, documented):**
- A credit note split across refund **and** balance (partial each) — needs
  proportioning; keep the whole-to-balance case only.
- Deferred-schedule invoices on either leg — the credited/consumed revenue would
  span 2100 and a recognition schedule (the same stateful problem as the deferred
  void/credit reconciliation). No-op until that reconciler is generalized.

## 5. Files to touch

- `src/accounts.ts` — add `2200` to `AccountCode` and `ACCOUNTS` (Liability,
  credit).
- `src/events/creditNotes/creditNoteCreated.ts` — branch the currently-no-op
  `post_payment` case: if credited entirely to balance and non-deferred, book the
  issue leg. Keep refund-backed post-payment credits a no-op (booked by
  `charge.refunded`).
- `src/events/invoices/invoicePaymentSucceeded.ts` — the `charge === null` branch
  (line ~197): book the consume leg when §3's discriminator says paid-from-balance
  (Slice 2).
- Exporter account maps — every `QboAccountMap` / `XeroAccountMap` must add `2200`
  (the ~5 test maps + any example maps; grep `'6200'` to find them all).
- Fixtures: `credit_note_created_post_payment_to_balance.{event,expected}.json`
  (issue leg); `invoice_payment_succeeded_from_credit_balance.{event,expected}.json`
  (consume leg). Both need a **real** payload shape for §3.
- `test/integration/` — a lifecycle spec: issue credit → 2200 up; consume →
  2200 back to zero, revenue recognized once.
- `docs/accounting.md`, `README.md` event table, `CHANGELOG.md`.

## 6. Build order (TDD)

1. Add `2200` + exporter-map entries; watch the account-map exporter tests fail
   for the missing code, then pass. (Compile-time-first — the maps won't type
   until 2200 is added everywhere.)
2. Issue leg: fixture (RED) → branch `creditNoteCreated` (GREEN) → lifecycle
   assertion that 2200 holds the credit.
3. Resolve §3 against a real `charge === null` credit-balance payload.
4. Consume leg: fixture (RED) → `invoicePaymentSucceeded` branch (GREEN) →
   lifecycle assertion that 2200 nets to zero and revenue books once.
5. Docs + CHANGELOG "Added" (both legs) and "Changed" (2200 map requirement).
   Release as a minor (next is v0.8.0) once both legs land, or ship Slice 1 alone
   if §3 stalls.

## 7. Invariants (must hold, test-enforced)

- Every emitted entry balances (existing global invariant).
- Issue then consume of the same credit nets 2200 to zero.
- Revenue for credit-funded service is recognized exactly once (at consume), not
  double-counted against the original paid invoice.
- Out-of-band / marked-paid invoices (`charge === null`, not balance-funded)
  remain a no-op — no fabricated revenue.

## 8. Alternative next feature (if this is deprioritized)

The other open piece is the **deferred pre-payment credit draw-down**: a partial
credit against an annual/deferred invoice must reduce the recognition schedule
proportionally (reuse the `invoice.voided` reconciler infrastructure —
`findScheduledBySubscription` / `cancelScheduled` / a new partial-reduce). Its
accounting (how to split a partial credit between recognized and deferred, and
which months to reduce) is genuinely ambiguous and deserves its own decisions
log. Lower user value than customer credit balances; sequence it after.
