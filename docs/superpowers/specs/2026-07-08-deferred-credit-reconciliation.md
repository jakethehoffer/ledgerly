# Deferred-Schedule Credit Reconciliation — Design Spec

Status: ready to implement. Author: Claude (2026-07-08). Resolves §8 of
[2026-07-08-customer-credit-balance.md](2026-07-08-customer-credit-balance.md)
and the "Credit notes against a deferred invoice" + "Customer credit balances —
deferred cases" entries in [accounting.md#known-limitations](../../accounting.md).

## 1. Problem

A credit against a **deferred-revenue** invoice is a documented no-op in three
places today. All three bail on the same line — `partitionLineAmounts(invoice).deferredCustomer > 0`:

- **Pre-payment credit note on a deferred `send_invoice` invoice**
  ([shared.ts](../../../src/events/creditNotes/shared.ts) `prepaymentCreditAmounts`,
  line 29). The invoice booked Dr 1100 / Cr 2100 / Cr 2000 at finalization and
  built a recognition schedule; the credit must reverse a slice of that.
- **Post-payment credit note credited to the customer's balance, against a
  deferred invoice** (`balanceCreditAmounts`, line 72). The paid invoice deferred
  revenue to 2100 + a schedule; returning it as 2200 credit must reverse a slice.
- **Consuming credit balance to pay a deferred invoice**
  ([invoicePaymentSucceeded.ts](../../../src/events/invoices/invoicePaymentSucceeded.ts)
  `creditBalanceApplied`, line 52). An invoice paid entirely from 2200 whose
  lines defer revenue.

The task framed all three as "one hard problem: a credit must proportionally draw
down the recognition schedule." **That framing is right for two of them and wrong
for the third.** The two *credit-note* sites are stateful draw-downs (reverse
revenue that partly recognized). The *consume* site is not a draw-down at all — it
is a fresh schedule *build*, funded from 2200 instead of cash, and the stateless
engine already knows how to build a schedule. Separating them is the core design
move: the easy one ships stateless and alone; the hard one reuses the
`invoice.voided` server reconciler.

## 2. The two mechanics

### 2a. BUILD — consume credit balance for a deferred invoice (stateless)

An `invoice.payment_succeeded` with `charge === null`, `applied === total`, whose
lines defer revenue. There is no prior schedule to reduce — this invoice is being
paid *now* and its revenue must be deferred going forward, exactly as a
cash-paid annual invoice is. It differs from the existing cash annual/mixed path
only in the debit: one Dr 2200 for the whole `applied` amount instead of the
1010/6000 net-and-fee split (no charge, no fee, no FX — a balance payment never
crosses currencies). It then emits the *same* recognition schedule
`buildRecognitionSchedule` already produces.

```
Dr 2200 Customer Credit Balance   applied (= invoice total)
Cr 4000 Subscription Revenue       immediate pre-tax (mixed invoices; 0 for pure annual)
Cr 2100 Deferred Revenue           deferred pre-tax
Cr 2000 Sales Tax Payable          tax
+ recognition schedule: Dr 2100 / Cr 4000 monthly over the deferred pre-tax
```

No double-count: a credit-balance-funded invoice has `amount_due === 0` at
finalization, so `invoice.finalized` no-ops and payment is the sole recognizer
(the same reasoning the customer-credit-balance spec used for the non-deferred
consume leg). This is a stateless generalization of an existing handler branch;
it needs **no** server reconciler and ships independently.

### 2b. DRAW-DOWN — credit note against a deferred invoice (stateful)

A `credit_note.created` reversing revenue that spans **4000** (already recognized:
the immediate portion booked at finalization/payment, plus whatever months the
schedule has posted) and **2100** (still deferred). The split between those two
buckets, and how the future schedule shrinks, are stateful facts only the ledger
holds — precisely the problem `invoice.voided` already solves in the server. The
two credit-note sites are the *same* draw-down; they differ only in the account
the credit lands against:

- pre-payment credit note → **Cr 1100** (reduces the receivable; invoice unpaid);
- post-payment-to-balance credit note → **Cr 2200** (books customer credit;
  invoice already paid).

Everything else — reading recognized-so-far from the ledger, splitting the credit
between recognized and deferred, and reducing the schedule — is identical.

## 3. Reconciler design (reuse the `invoice.voided` infrastructure)

Mirror the void path exactly. Today the receiver checks
`voidHasDeferredSchedule(invoice)` **before** `mapEvent`; when true it calls
`storage.persistVoidReversal(eventId, buildVoidReconcileInput(event))`, which — in
one transaction — reads the invoice's schedule rows, cancels the unposted ones,
and posts a reversal built from the posted ones. The draw-down adds a parallel
lane:

- **Detection** — `creditNoteHasDeferredSchedule(creditNote, invoice)` in
  [shared.ts](../../../src/events/creditNotes/shared.ts), true iff the credit note
  is a shape ledgerly books (bookable pre-payment on `send_invoice`, or
  post-payment credited wholly to balance) **and**
  `partitionLineAmounts(invoice).deferredCustomer > 0`. Use the **line-based**
  partition, not `computeFinalizationSplit` — see [Decision 7](#decision-7).
- **Routing** — the receiver's `handleWebhook`, before `mapEvent`: if the event is
  `credit_note.created` and the predicate holds, call
  `storage.persistCreditReversal(eventId, buildCreditReconcileInput(event))`.
- **Reconciler** — `buildCreditReconcileInput(event)` in a new
  `src/server/creditReconciler.ts` (parallel to `voidReconciler.ts`), returning a
  `CreditReconcileInput { subscriptionId, invoiceId, fundingAccount, build(posted, pending) }`.
- **Storage** — a new `persistCreditReversal(eventId, input, now?)` method,
  transaction-wrapped like `persistVoidReversal`: claim the event; read
  `(subscriptionId, invoiceId)` schedule rows; **cancel** the pending ones;
  call `input.build(posted, pending)` → `{ reversal, reducedSchedule }`; save the
  reversal as an immediate posting **and** enqueue the `reducedSchedule` rows;
  record the event. Atomic, so the scheduler cannot post a month mid-reconcile.

### The draw-down is ledger-driven

The reconciler needs almost nothing from the invoice — it reads the amounts from
the schedule rows the ledger already holds (the same trick `recognizedFromPosted`
uses for voids). Given the credit note's pre-tax `C = creditNote.subtotal` and tax
`T = creditNote.total − C`:

```
remainingDeferred   = Σ (pending rows' recognition amount)      // still in 2100
deferredReduction   = min(C, remainingDeferred)                 // Dr 2100
clawback4000        = C − deferredReduction                     // Dr 4000 (only if C exceeds remaining deferred)
newRemainingDeferred = remainingDeferred − deferredReduction

Immediate reversal:
  Dr 4000 Subscription Revenue   clawback4000        (omitted when 0)
  Dr 2100 Deferred Revenue       deferredReduction   (omitted when 0)
  Dr 2000 Sales Tax Payable      T                   (omitted when 0)
  Cr {1100 | 2200}               C + T (credit note total)

Schedule: cancel all pending rows; reissue newRemainingDeferred spread evenly
over those same month-dates (floor + remainder, last month absorbs remainder —
buildRecognitionSchedule's own pattern). Reissue nothing when newRemainingDeferred is 0.
```

The immediate entry **always balances**: debits `clawback4000 + deferredReduction + T
= C + T`, credit `C + T`. And `clawback4000 ≤` total recognized is *provable* given
Stripe caps the credit at the invoice subtotal (see [Decision 1](#decision-1)), so
no clamp is required — though `build` receives `posted` too, for parity with the
void reconciler and a defensive clamp if wanted.

**`sourceObjectId` convention (load-bearing for Slice 4).** The immediate reversal
entry carries `sourceObjectId = creditNote.id` (matching the existing credit-note
entries and letting [Decision 8](#decision-8)'s void look it up by credit-note id).
The **reissued schedule rows** carry `sourceObjectId = invoice.id` (like the
original schedule) so a *later* credit or void against the same invoice still finds
them via the `(subscriptionId, invoiceId)` filter. Mixing these up would orphan the
reissued rows from future reconciliations.

### Worked example (pre-payment / 1100)

Annual B2B invoice: $1,200 pre-tax + $120 tax. Finalized → Dr 1100 $1,320 / Cr
2100 $1,200 / Cr 2000 $120, 12-month schedule at $100/mo. Three months recognize
(4000 = $300; 2100 = $900 across 9 pending rows). A pre-payment credit note for
$300 pre-tax + $30 tax arrives:

```
C = 300, T = 30, remainingDeferred = 900
deferredReduction = min(300, 900) = 300;  clawback4000 = 0;  newRemainingDeferred = 600

Immediate:  Dr 2100 $300 / Dr 2000 $30 / Cr 1100 $330
Schedule:   cancel 9 pending rows; reissue $600 over the same 9 dates (8×$66 + 1×$72)
```

After: 1100 = $990 (reduced contract owed), 2100 = $600 (= reissued pending),
4000 = $300 (three delivered months kept). Lifetime revenue = $300 posted + $600
reissued = $900 = the new $1,200 − $300 contract value. The post-payment case is
byte-identical except the credit lands **Cr 2200** instead of Cr 1100.

## 4. Decisions log

The accounting here is genuinely ambiguous. Each decision below states the
options, the resolution, and why. These are the calls that need review.

### <a id="decision-1"></a>Decision 1 — split a partial credit between recognized (4000) and deferred (2100)

**Options.** (A) *Deferred-first / prospective*: reduce 2100 first, only clawing
back 4000 when the credit exceeds all remaining deferred. (B) *Proportional*:
split the credit by the current recognized:deferred ratio (a partial void). (C)
*Recognized-first*: claw back 4000 first.

**Resolution: (A) deferred-first.** `deferredReduction = min(C, remainingDeferred)`;
`clawback4000 = C − deferredReduction`.

**Rationale.** A mid-term credit almost always reflects a **go-forward** change —
a downgrade, a partial cancellation, a proration — not a retroactive restatement.
Revenue-recognition principle: you earned revenue for the periods you delivered,
so a credit should first give back the revenue you have **not** yet earned (2100),
and only reverse delivered revenue (4000) when the credit is so large it exceeds
all remaining future service. Deferred-first also keeps closed accounting periods
stable — proportional clawback (B) reverses revenue in months that may already be
closed, forcing a restatement — and it matches Stripe's own proration model, which
credits the unused future portion. Because Stripe caps a credit note at the invoice
subtotal, and `remainingDeferred + recognized = subtotal`, the clawback can never
exceed what was recognized, so the reversal is always a faithful un-recognition.
(C) is never correct and is rejected. The one case (A) handles differently from a
human's intent is a genuine *retroactive discount* ("20% off the whole year,
including delivered months") — but ledgerly cannot detect that intent from the
payload, it is the rarer case, and a true restatement of closed periods belongs in
a manual journal entry, not an automated webhook mapping. This boundary is
documented.

### <a id="decision-2"></a>Decision 2 — which future months to reduce

**Options.** (a) *Even re-spread*: cancel the pending rows and reissue
`newRemainingDeferred` evenly over the same remaining month-dates. (b) *Tail-first
(LIFO)*: keep near-term months whole, drop from the last month back ("service ends
early"). (c) *Head-first (FIFO)*: shrink the next months first.

**Resolution: (a) even re-spread** over the still-pending dates, reusing the
floor-plus-remainder logic `buildRecognitionSchedule` already ships.

**Rationale.** ledgerly has no signal for *which* months a credit removes, so the
neutral choice is to treat the reduction as uniform across the remaining service —
the "the rest of the contract is now worth less" reading, which fits the common
downgrade/proration case. Even re-spread is a direct generalization of the tested
schedule builder (lowest implementation risk), keeps recognition smooth (no lumpy
tail an auditor would question), and degrades correctly at the boundary:
`newRemainingDeferred = 0` reissues nothing, which is exactly the full-cancellation
outcome tail-first would also produce. Tail-first and head-first bake in an
assumption about the credit's intent that the payload does not carry; the per-month
timing they'd change never affects the (identical) lifetime total.

### <a id="decision-3"></a>Decision 3 — mixed invoices: does the credit hit the setup fee or the subscription?

**Context.** A mixed invoice (e.g. annual sub + one-time setup fee) recognized the
fee immediately (4000) and deferred the sub (2100 + schedule).

**Resolution.** Folds into Decision 1: the credit draws down the **deferred
balance first**, then the **aggregate** recognized revenue (4000), without
distinguishing whether a recognized dollar came from the setup fee or a posted
schedule month. Both live in 4000, so the immediate reversal is one `Dr 4000` line
and the split does not affect balancing. The schedule only ever covered the
deferred portion, so a small credit (≤ remaining deferred) never touches the fee;
a large one claws back 4000 in aggregate.

**Rationale.** Preserving a separate "protect the setup fee" rule would need line-
level credit-to-invoice mapping the stateless amounts don't carry, for no
accounting benefit — the trial balance is identical either way. Simplicity wins.

### <a id="decision-4"></a>Decision 4 — pure engine: throw vs. no-op the deferred credit

**Options.** (a) Keep the stateless handlers no-op'ing the deferred case (today's
behavior; non-breaking). (b) Make them **throw**, and route deferred credits to the
reconciler in the server before `mapEvent` — matching exactly how
`handleInvoiceVoided` throws and the server routes voids.

**Resolution: (b) throw + server-route**, mirroring the void precedent.

**Rationale.** The void path already establishes the contract: the pure engine
*refuses* what it cannot do correctly, and the bundled receiver closes the gap with
ledger access. Consistency matters — a deferred void throws while a deferred credit
silently drops would be a surprising asymmetry. A throw is only ever reached by (i)
a direct-engine consumer with no ledger (who was silently under-booking before and
should now get an honest refusal) or (ii) a server routing bug, where a loud
500 → dead-letter is far better than silent revenue loss. The throw and the server
routing must land in the **same** change so a deferred credit is never both
un-routed and throwing in a live receiver. Call it out in CHANGELOG "Changed" and
the known-limitations, exactly as the deferred-void refusal is documented.

### <a id="decision-5"></a>Decision 5 — FX-bearing draw-downs

**Context.** The pre-payment (send_invoice) schedule is **always same-currency**
(finalization has no balance transaction, and the payment path already refuses
cross-currency B2B). Only the post-payment-to-balance case can involve FX: its
schedule was built at payment in the *settlement* currency and its rows carry
`fxContext`, while the credit note's `subtotal` is in the *customer* currency.

**Resolution.** Handle **same-currency draw-downs only** in the first release. If
any schedule row for the invoice carries `fxContext` (equivalently, the invoice's
currency differs from the schedule currency), the reconciler **refuses** with a
clear error, documented as a known limitation.

**Rationale.** The ledger-driven arithmetic (reading `remainingDeferred` from the
rows, subtracting a customer-currency `C`) is only sound when those currencies
match. Re-pro-rating FX across a reduced reissued schedule is a real sub-problem
that mirrors the several FX cases ledgerly already refuses rather than
approximates (cross-currency B2B settlement, cross-currency payouts). Refusing
keeps the tractable slice correct and defers FX to its own change. The refusal
affects **only** the post-payment/2200 draw-down; the pre-payment/1100 draw-down is
never FX and is fully covered.

### <a id="decision-6"></a>Decision 6 — tax

**Resolution.** `T = creditNote.total − creditNote.subtotal` posts as **Dr 2000**;
it is never deferred. Only the pre-tax `C = subtotal` splits between 2100 and 4000.
The credit side (1100 or 2200) takes the full `C + T`.

**Rationale.** Tax is a liability owed at collection regardless of when revenue is
recognized — the same treatment every other handler uses. The credit note carries
`subtotal` and `total` directly, so the split is exact with no proportioning. Not
deeply ambiguous, stated for completeness because it fixes the immediate entry's
shape.

### <a id="decision-7"></a>Decision 7 — read amounts from the ledger, not from `computeFinalizationSplit`

**Context.** The void reconciler derives its amounts from
`computeFinalizationSplit(invoice)`, which is anchored on `invoice.amount_due`.
That is valid for a void (the invoice is open and unpaid). But the
post-payment-to-balance credit targets a **paid** invoice, whose `amount_due` is 0
— `computeFinalizationSplit` would report zero deferred and mis-book.

**Resolution.** The reconciler reads `remainingDeferred` (and the reissue dates)
from the **pending schedule rows** in the ledger, and detects "is this deferred?"
with the **line-based** `partitionLineAmounts(invoice).deferredCustomer > 0`.
Neither depends on `amount_due`, so both work whether the invoice is paid or
unpaid, and both are already in the settlement currency the rows use.

**Rationale.** The schedule rows are the authoritative record of what remains to be
recognized — more reliable than recomputing from the invoice, and currency-correct
by construction. This is the same philosophy as `recognizedFromPosted` reading
recognized revenue straight from posted rows.

### <a id="decision-8"></a>Decision 8 — symmetry: voiding a deferred credit note

**Context.** `credit_note.created` and `credit_note.voided` share shape helpers
today so a void un-books exactly what creation booked. Once creation books a
deferred draw-down, a later `credit_note.voided` must undo it, or the ledger
drifts (a phantom 2200 balance / permanently reversed revenue for a credit Stripe
says was cancelled). But the draw-down mutated the schedule (cancel + reissue), so
the inverse is itself stateful.

**Options.** (a) Ship draw-down creation only; leave `credit_note.voided` of a
deferred credit a no-op — *introduces* drift for the rare void-of-credit path. (b)
Ship a symmetric un-draw-down: on `credit_note.voided`, post the **exact inverse**
of the draw-down's own immediate entry (looked up by credit-note id — both events
carry the same `creditNote.id` as `sourceObjectId`) to restore 4000/2100/2000/
funding, and **re-inflate** the schedule by cancelling the current (reduced) pending
rows and reissuing at `pending-sum + deferredReduction` (the `Dr 2100` amount read
back off the draw-down entry), spread over the still-pending dates.

**Resolution: (b), sequenced as the last slice.** Do not ship creation without its
inverse.

**Rationale.** Shipping (a) would *introduce* an asymmetry the codebase does not
have today (creation and voiding currently both no-op, so they never drift).
Re-inflating from the draw-down entry's own `Dr 2100`/`Dr 4000` lines makes the P&L
restoration exact and the future schedule correct for every not-yet-posted month.
**Residual (documented):** months that posted at the *reduced* rate between the
credit and its void under-recognized by the per-month delta; the lifetime total is
restored by the re-inflated remaining months, but that specific timing is not
retroactively corrected. This residual is bounded (≤ elapsed months × per-month
delta) and is the same class of timing approximation ledgerly already accepts
elsewhere. If Slice 4 proves costly in implementation, the fallback is to **refuse**
(throw) `credit_note.voided` against a deferred invoice rather than no-op it — loud,
not silent — but the recommended target is the symmetric reversal.

## 5. Scope and slicing

Four slices, smallest-value-first. Each is independently shippable and testable.

- **Slice 1 — BUILD (consume a deferred invoice), stateless.** Generalize
  `creditBalanceApplied` + the `charge === null` branch to build a schedule when
  the invoice defers. No reconciler. Closes the consume-leg no-op. *Ships alone.*
- **Slice 2 — DRAW-DOWN, pre-payment / 1100.** The `credit_note.created`
  reconciler for a deferred `send_invoice` invoice. Always same-currency. Closes
  the `prepaymentCreditAmounts` no-op.
- **Slice 3 — DRAW-DOWN, post-payment-to-balance / 2200.** The same reconciler with
  the credit landing on 2200; same-currency only ([Decision 5](#decision-5)).
  Closes the `balanceCreditAmounts` no-op. Slices 2 and 3 share nearly all the
  reconciler and will likely land together.
- **Slice 4 — SYMMETRY (void a deferred credit note).** The inverse of Slices 2–3
  ([Decision 8](#decision-8)). Closes the drift window; must land before the
  feature is "done."

**Out of scope (documented as limitations):** a credit note split across a cash
refund and the balance (needs proportioning — already out per the
customer-credit-balance spec); FX-bearing post-payment draw-downs
([Decision 5](#decision-5)); the bounded schedule-timing residual on void-of-credit
([Decision 8](#decision-8)).

## 6. Files to touch

- `src/events/invoices/invoicePaymentSucceeded.ts` — **Slice 1:** drop the
  `deferredCustomer > 0` bail in `creditBalanceApplied`; in the `charge === null`
  branch, compute the immediate/deferred split and emit `Dr 2200` + `Cr 4000` /
  `Cr 2100` / `Cr 2000` and a `buildRecognitionSchedule` (same helper the cash path
  uses, `fxContext` undefined).
- `src/events/creditNotes/shared.ts` — split each amount helper's shape decision
  from its deferred-gate so a "bookable but deferred" shape is distinguishable from
  a "skip" shape; add `creditNoteHasDeferredSchedule(creditNote, invoice)`.
- `src/events/creditNotes/creditNoteCreated.ts` — **Slice 2/3:** the bookable-but-
  deferred shapes now **throw** (per [Decision 4](#decision-4)) instead of no-op'ing.
- `src/server/creditReconciler.ts` — **new.** `buildCreditReconcileInput(event)`
  (parallel to `voidReconciler.ts`): resolves `subscriptionId`/`invoiceId`, picks
  the funding account from the credit-note shape, refuses FX ([Decision 5](#decision-5)),
  and returns `build(posted, pending)` → `{ reversal, reducedSchedule }` per §3.
- `src/server/storage/types.ts` — add `CreditReconcileInput` and
  `persistCreditReversal` to the `Storage` interface (mirroring
  `VoidReconcileInput` / `persistVoidReversal`).
- `src/server/storage/sqlite.ts` — `persistCreditTxn` (claim → read rows → cancel
  pending → build → save reversal immediate + enqueue reduced schedule → record),
  transaction-wrapped like `persistVoidTxn`.
- `src/server/storage/inMemory.ts` — the same reconciliation sequentially.
- `src/server/index.ts` — route `credit_note.created` (and, Slice 4,
  `credit_note.voided`) through `creditNoteHasDeferredSchedule` →
  `persistCreditReversal` before `mapEvent`; add the same logic to the legacy
  `dedup`-only storage wrapper in `resolveStorage`.
- **Slice 4:** `src/events/creditNotes/creditNoteVoided.ts` +
  `creditReconciler.ts` — the inverse per [Decision 8](#decision-8); a
  `findImmediateBySourceObject(objectId)` query on `JournalEntryStore` to look up
  the draw-down entry by credit-note id.
- Fixtures under `test/fixtures/`: `invoice_payment_succeeded_from_credit_balance_annual`
  (Slice 1); `credit_note_created_send_invoice_annual_prepayment` (Slice 2);
  `credit_note_created_post_payment_to_balance_annual` (Slice 3);
  `credit_note_voided_*_annual` (Slice 4). Draw-down fixtures drive the reconciler
  through a finalize/pay → recognize-a-few-months → credit lifecycle.
- `test/integration/` — a `deferred-credit.spec.ts` lifecycle test in the shape of
  [b2b-void.spec.ts](../../../test/integration/b2b-void.spec.ts): build/recognize,
  credit, then assert the trial balance and the reissued/cancelled schedule rows.
- `docs/accounting.md`, `README.md` event table, `CHANGELOG.md` — the new
  behavior; "Changed" for the pure-engine throw ([Decision 4](#decision-4)).

## 7. Build order (TDD)

1. **Slice 1 (BUILD).** Fixture (RED) → generalize `creditBalanceApplied` +
   branch (GREEN) → lifecycle assertion that 2200 drains to zero as the schedule
   recognizes.
2. **Reconciler scaffolding.** `creditNoteHasDeferredSchedule` + the
   `persistCreditReversal` storage method (both backends) + server routing, with a
   pure-engine throw for the deferred shapes. Watch the direct-engine deferred-credit
   tests flip from no-op to throw.
3. **Slice 2 (DRAW-DOWN / 1100).** Lifecycle fixture (RED) → `buildCreditReconcileInput`
   (GREEN) → assert the trial balance nets, 4000 keeps delivered months, the schedule
   reissues reduced, and the credit-exceeds-remaining clawback case.
4. **Slice 3 (DRAW-DOWN / 2200).** Same reconciler, funding account 2200; add the
   FX-refusal test ([Decision 5](#decision-5)).
5. **Slice 4 (SYMMETRY).** Void-of-credit fixture (RED) → inverse
   ([Decision 8](#decision-8)) (GREEN) → assert P&L restoration + schedule
   re-inflation, and document the timing residual.
6. Docs + CHANGELOG. Release as a minor once Slices 1–4 land, or ship Slice 1
   alone first (it is self-contained and closes one no-op).

## 8. Invariants (test-enforced)

- Every emitted entry balances (global invariant; the draw-down balances by
  construction — debits sum to the credit total).
- **BUILD:** a credit-balance-funded deferred invoice recognizes its revenue
  exactly once, ratably; issue-then-consume nets 2200 to zero.
- **DRAW-DOWN:** after a partial credit, the invoice's lifetime recognized revenue
  equals the original contract value minus the credit subtotal; already-recognized
  revenue (4000) is untouched unless the credit exceeds all remaining deferred; the
  reissued pending schedule sums to `newRemainingDeferred`; the cancelled rows never
  post.
- A credit against a **fully-recognized** deferred invoice (no pending rows) reduces
  to the existing non-deferred credit entry (Dr 4000 / Dr 2000 / Cr 1100|2200) — the
  reconciler handles it with zero pending rows and no reissue.
- Crediting one invoice leaves a sibling invoice's schedule on the same subscription
  untouched (the `sourceObjectId` filter, as in the void test).
- **SYMMETRY:** create-then-void of a deferred credit restores every account to its
  pre-credit balance, up to the documented bounded timing residual.
- A post-payment draw-down whose schedule carries `fxContext` is refused, not
  mis-booked.
