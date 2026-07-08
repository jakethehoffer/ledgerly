# Split Credit Note (refund + balance) — Design Spec

Status: ready to implement. Author: Claude (2026-07-08). Closes the "credit note
**split** across a cash refund and the balance (needs proportioning)" gap in
[accounting.md#known-limitations](../../accounting.md), the last open credit-note
case after the deferred-credit reconciliation (v0.9.x).

## 1. Problem

A post-payment credit note can return money to the customer **partly as a cash
refund and partly as account credit** in one credit note — e.g. a $100 credit
where $60 is refunded to the card and $40 is kept as customer balance. Stripe
represents this with **both** `refund` and `customer_balance_transaction` set on
the credit note (and, for externally-settled slices, a non-zero
`out_of_band_amount`).

ledgerly books neither cleanly today. `balanceCreditAmounts`
([shared.ts](../../../src/events/creditNotes/shared.ts)) bails the moment
`refund` is set (`if (creditNote.refund) return null`) — because it only handles a
credit whose total goes **entirely** to balance. So on a split:

- the **cash slice** is booked correctly by `charge.refunded` (Dr 4900 / Dr 2000 /
  Cr 1010 — see [chargeRefunded.ts](../../../src/events/charges/chargeRefunded.ts));
- the **balance slice** is **dropped**: no revenue reversal, no 2200 liability.

The result is overstated revenue and a missing customer-credit liability whenever a
credit is split. This spec books the balance slice, and only the balance slice, in
the credit-note handler.

## 2. The key insight — the two slices are already separated by event

The refund slice and the balance slice arrive as **different events** and must be
booked by **different handlers**, or they double-count:

| Slice | Event | Entry |
|-------|-------|-------|
| Cash refund | `charge.refunded` | Dr 4900 / Dr 2000 / Cr 1010 (already shipped, FX-aware) |
| Customer balance | `credit_note.created` | Dr 4000 / Dr 2000 / Cr 2200 (this spec) |

So the credit-note handler must book **exactly the balance portion** — never the
refunded portion (that's `charge.refunded`'s job) and never the out-of-band portion
(no ledger-visible mechanics). This is the whole-to-balance leg the
customer-credit-balance spec already shipped, generalized from "total goes to
balance" to "the balance portion goes to balance."

```
Dr 4000 Subscription Revenue      balance-portion pre-tax
Dr 2000 Sales Tax Payable         balance-portion tax
Cr 2200 Customer Credit Balance   balance-portion total
```

Balances (pre-tax + tax = total). Over the credit's life, 4900 + 4000 reverse the
full revenue once (split across the two events), and 2000 drains the full tax once
— no double-count, because each event books only its own slice.

## 3. The one genuinely open question — the balance-portion amount source

The handler needs the **balance portion total** `B` (the amount that went to
customer balance, with tax). The pinned Stripe type (`node_modules/stripe/types/CreditNotes.d.ts`)
settles the field question: the `CreditNote` object has **no scalar** for the
balance-credited amount, so it must come from the linked transaction —

1. **Expand `customer_balance_transaction` and read `|amount|`** *(recommended)* —
   the authoritative figure for what hit the balance. `customer_balance_transaction`
   is `string | CustomerBalanceTransaction | null`; today `expand.ts` does **not**
   expand it, so add it to the `credit_note.created` / `.voided` expansion. Stripe
   issues customer credit as a **negative** balance transaction (the same
   sign convention the shipped consume leg relies on — `starting_balance` was
   negative there), so `B = |customer_balance_transaction.amount|`.
2. Fallback — `total − refund.amount − out_of_band_amount` (needs `refund` expanded
   for `.amount`; `out_of_band_amount` is already a scalar).

**The one thing to confirm against a real split payload** (do not guess the sign):
that `customer_balance_transaction.amount` on a *credit note* is negative-for-credit
and equals the balance slice — verified by building the Slice 1 fixture from a real
`credit_note.created` split event, exactly as the customer-credit spec resolved its
consume discriminator. If it can't be confirmed, the split **stays a no-op** and
only the whole-to-balance case ships — a missing liability beats a fabricated one.
The pre-tax/tax split of `B` is then by the credit note's own ratio (Decision 2).

## 4. Decisions log

### Decision 1 — book only the balance slice; never the refund or out-of-band slice

**Resolution.** The credit-note handler books `Dr 4000 / Dr 2000 / Cr 2200` for the
balance portion `B` only. The refund portion is left to `charge.refunded`; the
out-of-band portion is never booked (no ledger-visible movement, consistent with
how out-of-band invoice payments are treated).

**Rationale.** The slices arrive as separate events; booking the refund slice here
too would double-count it against `charge.refunded`. This also preserves the
established asymmetry — a **cash** refund reverses revenue via **4900** (contra-
revenue, keeping gross revenue reportable), while a **balance** credit reverses via
**4000** directly then parks the liability in 2200 until consumed. Both are already
ledgerly conventions; the split just routes each slice to its existing treatment.

### Decision 2 — proportion the balance slice's pre-tax vs tax by the credit note's ratio

**Resolution.** `B_subtotal = round(subtotal × B / total)`, `B_tax = B − B_subtotal`.

**Rationale.** A credit note carries a single blended tax ratio (`subtotal`/`total`),
so proportioning the balance slice by that ratio is exact and consistent with how
`charge.refunded` proportions a partial refund's tax. Computing `B_tax` as the
remainder (rather than rounding it independently) guarantees `B_subtotal + B_tax = B`
to the cent, so the entry always balances.

### Decision 3 — a split against a *deferred* invoice is out of scope (compose later)

**Resolution.** If the split credit note targets a **deferred-schedule** invoice,
it stays refused/no-op (as today), documented. Only the non-deferred split ships
here.

**Rationale.** That case is the intersection of two hard problems — proportioning
(this spec) and the stateful schedule draw-down (v0.9.x). The draw-down reconciler
would need to draw down only the balance slice's pre-tax while `charge.refunded`
handles the refund slice — composable, but a rare double-intersection not worth the
combined complexity until a real payload demands it. `creditNoteHasDeferredSchedule`
already routes deferred credits to the reconciler; the split reconciler path is the
follow-up.

### Decision 4 — `credit_note.voided` symmetry

**Resolution.** Voiding a split credit note un-books the balance slice exactly
(Dr 2200 / Cr 4000 / Cr 2000 for `B`), gated on the same shape test as creation, so
a void reverses precisely what creation booked. The refund slice's reversal (if the
refund is itself reversed) is `charge.refunded`'s concern, not this handler's.

**Rationale.** Same create/void symmetry the other credit-note legs maintain — the
two handlers share one shape/amount helper so they can't drift.

## 5. Scope and slicing

- **Slice 1 — book the balance slice of a non-deferred split** (`credit_note.created`).
  Generalize `balanceCreditAmounts` to accept a credit with `refund` set, returning
  the **balance-portion** amounts (per §3) instead of bailing. Requires the §3
  payload resolution first.
- **Slice 2 — `credit_note.voided` symmetry** for the split (falls out of the shared
  helper automatically once Slice 1 changes it — verify, don't duplicate).

**Out of scope (documented):** split against a deferred invoice (Decision 3); the
out-of-band-only portion (never booked).

## 6. Files to touch

- `src/server/expand.ts` — if §3 picks option (1), add
  `customer_balance_transaction` to the `credit_note.created` / `.voided` expansion.
- `src/events/creditNotes/shared.ts` — generalize `balanceCreditAmounts` /
  `isPostPaymentToBalance`: accept `refund` set when a balance portion exists;
  return the balance-portion `{ total: B, subtotal: B_subtotal, tax: B_tax }`. Keep
  the whole-to-balance case (refund null) byte-identical.
- `src/events/creditNotes/creditNoteCreated.ts` / `creditNoteVoided.ts` — no logic
  change beyond consuming the generalized amounts (the entry shape is unchanged).
- Fixtures: `credit_note_created_split_refund_and_balance.{event,expected}.json`
  and its `.voided` counterpart — built from a **real** split payload (§3).
- `test/integration/customer-credit-balance.spec.ts` — a split lifecycle assertion:
  the balance slice books to 2200/4000/2000, the refund slice is left to
  `charge.refunded`, and the two together reverse revenue/tax exactly once.
- `docs/accounting.md` (the split limitation → modeled), `README.md` event table,
  `CHANGELOG.md`.

## 7. Build order (TDD)

1. Resolve §3 against a real split payload; add the fixture (RED).
2. Generalize `balanceCreditAmounts` to return the balance portion (GREEN); confirm
   the whole-to-balance fixtures stay byte-identical.
3. Void symmetry: fixture (RED) → verify the shared helper already covers it (GREEN).
4. Integration lifecycle assertion (split + refund reverse once, no double-count).
5. Docs + CHANGELOG (minor, next is v0.10.0).

## 8. Invariants (test-enforced)

- Every emitted entry balances (`B_subtotal + B_tax = B`).
- A split books **only** the balance slice; the refund slice is booked solely by
  `charge.refunded` — revenue and tax are each reversed exactly once across the two
  events (no double-count, nothing dropped).
- The whole-to-balance case (no refund) is unchanged (byte-identical fixtures).
- Create-then-void of a split nets 2200, 4000, and 2000 to zero for the balance
  slice.
- A split against a deferred invoice remains refused/no-op (Decision 3).
