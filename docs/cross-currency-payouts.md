# Cross-currency payouts — design notes

_Status: design note. Last updated 2026-05-20._

## What ships today

`v0.1.11` added **detect-and-reject** for cross-currency payouts
([`src/events/payouts/crossCurrency.ts`](../src/events/payouts/crossCurrency.ts)).
When a `payout.paid` / `payout.failed` event has an expanded
`destination` whose `currency` differs from `payout.currency`, the
handler throws instead of producing a journal entry. The receiver's
`expand.ts` requests `expand: ['destination']` so the comparison is
possible.

The engine does **not** produce accounting entries for these payouts.
This document captures what's needed to change that — both the design
decision and the Stripe-payload facts — so that when a real
cross-currency payout payload arrives, implementation is unblocked.

## The scenario

A Stripe account whose balance settles in one currency pays out to a
bank account in a different currency. Example: a Canadian account
holds a CAD balance and pays out to a USD bank account; Stripe
converts CAD → USD at payout time and charges an FX conversion fee.

## The accounting problem — and why it's smaller than it first looks

A `JournalEntry` is **mono-currency** (`JournalEntry.currency` is a
single string). A cross-currency payout moves money *out of*
`1010 Stripe Clearing` and *into* `1000 Operating Bank`. If those two
accounts are denominated in different currencies, a single balanced
mono-currency entry seemingly can't bridge them.

But ledgerly's books already have a de-facto **functional currency**:
every handler posts in `bt.currency` (the settlement currency). The
charge / refund / dispute entries all credit and debit `1010` in the
settlement currency. So the books' functional currency *is* the
settlement currency.

Under standard foreign-currency accounting, a foreign-currency bank
account is **carried in the books' functional currency** and revalued
periodically. That means `1000 Operating Bank` should be debited the
*functional-currency value* of the funds that arrived — not the raw
destination-currency number. With that framing, a cross-currency
payout **is** a balanced mono-currency entry.

### Worked example (Resolution A)

CAD-settling account pays out **CAD 1,000.00**; Stripe charges a
**CAD 5.00** FX fee and converts the remaining CAD 995.00 to roughly
**USD 726.35**.

Entry, posted in CAD (the functional/settlement currency):

| Account | Side | Amount (CAD) | Memo |
| --- | --- | --- | --- |
| `1010` Stripe Clearing | credit | 1000.00 | Funds left Stripe balance |
| `1000` Operating Bank | debit | 995.00 | Funds arrived in bank |
| `6000` Stripe Processing Fees | debit | 5.00 | Payout FX conversion fee |

Balanced: 995.00 + 5.00 = 1000.00. The USD amount the bank actually
received (USD 726.35) is **not** a journal line — it's provenance
metadata, carried in an `fxContext`-style field for downstream tools
and bank reconciliation.

This is the same shape ledgerly already uses for FX charges: post in
settlement currency, expose the other currency in `fxContext`.

## Candidate resolutions

### A. Settlement-currency posting (recommended)

Post the entry in the settlement currency, as above. `1000` holds the
functional-currency value of the foreign bank balance. The destination
amount lives in metadata.

- **Pros:** consistent with every other handler; the entry balances as
  a normal mono-currency entry; no new architecture.
- **Cons:** `1000 Operating Bank` drifts from the literal USD bank
  balance as the CAD/USD rate moves — the operator must run a
  period-end revaluation of `1000` (a standard accounting task, but
  ledgerly doesn't generate the revaluation entry).
- **Open sub-decision:** which account takes the FX fee — `6000`
  (treat it as a Stripe fee, consistent with processing fees) or
  `7000 FX Gain/Loss` (treat it as an FX cost)? Leaning `6000`: it's
  an explicit fee Stripe charges, not rate-movement gain/loss. Note
  there is **no realized FX gain/loss on the payout itself** — the
  conversion happens *at* payout, so there's no rate-drift window the
  way there is for an FX refund (charge rate vs refund rate).

### B. Home-currency reporting model (deferred — YAGNI for now)

Introduce an explicit "books are in currency X" config and have every
handler convert. Only needed if the operator's books are in a *third*
currency, or if they want `1000` tracked in the bank's native
currency. Much larger change; not justified until an operator needs
it.

### C. Entry pair bridged by a clearing account (rejected)

Emit two entries — one per currency leg — joined by an in-transit
clearing account. Doubles the entries and adds an account; unnecessary
if Resolution A holds. Recorded only to show it was considered.

## Open data questions — the real blocker

Resolution A reduces the problem to **payload facts we must confirm
from a real cross-currency payout** before writing code:

1. **What is `payout.currency`?** The current detector assumes it's the
   *source* (settlement) currency and compares it to
   `destination.currency`. If Stripe sets `payout.currency` to the
   *destination* currency instead, the detector has a **false
   negative** — `payout.currency` would equal `destination.currency`,
   the guard wouldn't fire, and the normal handler would produce a
   wrong entry. This must be confirmed.
2. **Where is the FX conversion fee?** Inline on the payout's
   `balance_transaction.fee`, or a separate adjustment
   `balance_transaction`? Is it expressed in source or destination
   currency?
3. **Is there a destination-amount field?** Does the payout object (or
   a related BT) carry the converted amount the bank received, or only
   the source amount? Resolution A needs the functional-currency value
   of `1000`'s debit (`payout.amount − fee`); the destination amount
   is for `fxContext`.
4. **`payout.failed` semantics.** A failed cross-currency payout
   reverses the conversion. Does the reversal happen at the original
   rate or the current rate? If the latter, the failure realizes an FX
   gain/loss that should hit `7000`.
5. **`fxContext` shape.** Today `FxContext` is
   `{ customerCurrency, customerAmount, settlementCurrency,
   settlementAmount }` — named for the customer-facing-vs-settlement
   axis. A payout's destination-vs-settlement is a different axis.
   Either generalize `FxContext` (rename `customer*` to something
   neutral) or give payouts their own provenance field.

## Reporting a real cross-currency payout

If you hit the `Cross-currency payouts not yet supported` error,
please open an issue including (sanitize customer-identifying data
first):

- The full `payout.paid` (or `payout.failed`) **event JSON**, with the
  `destination` expanded.
- The payout's **`balance_transaction`** — retrieve it and paste it in
  full (`amount`, `fee`, `net`, `currency`, `exchange_rate`,
  `reporting_category`, `type`).
- Any **related adjustment balance_transactions** (the Stripe
  dashboard's payout detail page lists them; or query
  `balance_transactions` filtered by the payout).
- What your **bank actually received** (amount + currency) and what
  Stripe's dashboard shows as the FX rate, so the math can be checked
  end-to-end.

This is exactly the data gap above. One real payload makes the
implementation a fill-in-the-blank exercise.

## Implementation checklist (once data + design decision land)

- [ ] Confirm `payout.currency` semantics; fix the
      `detectCrossCurrencyPayout` false-negative if it's the
      destination currency.
- [ ] Expand the payout's `balance_transaction` (and adjustment BTs)
      in `expand.ts` — currently only `destination` is expanded.
- [ ] Implement the Resolution-A entry in `payoutPaid`: `1010` credit
      source amount, `1000` debit functional-currency value, fee line.
- [ ] Decide `payoutFailed` behavior for the reversal — including
      `7000` if the reverse conversion realizes a gain/loss.
- [ ] Settle the `fxContext` shape for payouts (generalize vs new
      field).
- [ ] Add fixtures: a real (sanitized) cross-currency payout event +
      `.expected.json` + QBO/Xero goldens.
- [ ] Remove the `rejectCrossCurrencyPayout` call once the handler
      produces correct entries; keep `detectCrossCurrencyPayout` if
      still useful for branching.
- [ ] Update the README currency caveat and `CHANGELOG`.
