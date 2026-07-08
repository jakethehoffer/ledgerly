# The accounting model

This document explains **why** ledgerly maps each Stripe event to the journal
entry it produces — in plain bookkeeping terms, so you can check the reasoning
without reading TypeScript. If you're an accountant or have done SaaS books, this
is the page to scrutinize. If an entry below looks wrong for your jurisdiction or
chart of accounts, please [open an issue](https://github.com/jakethehoffer/ledgerly/issues) —
that feedback is the whole point.

Every claim here is enforced by a fixture test under
[`test/fixtures/`](../test/fixtures); the file names are noted alongside each case.

## Conventions

- **Double-entry, always balanced.** Every entry's debits equal its credits to
  the cent. The engine asserts this on every entry it emits and throws if it
  ever fails, so an unbalanced entry can't reach your books.
- **Integer minor units.** All amounts are integer cents (or the currency's
  smallest unit). No floating-point money.
- **Posted in the settlement currency.** Amounts come from the Stripe
  `balance_transaction` (`bt.amount` / `bt.fee` / `bt.net`) — the currency your
  Stripe balance actually moved in — not the customer-facing charge currency.
  For same-currency businesses these are identical. See [Foreign exchange](#foreign-exchange).
- **The caller maps account codes.** ledgerly emits 14 stable account *codes*;
  you map each to your real QuickBooks/Xero account once. Codes and names are in
  the README's [Chart of accounts](../README.md#chart-of-accounts).

Account codes referenced below:

| Code | Name | Type |
|------|------|------|
| 1000 | Operating Bank | Asset |
| 1010 | Stripe Clearing | Asset |
| 1100 | Accounts Receivable | Asset |
| 1200 | Disputes Receivable | Asset |
| 2000 | Sales Tax Payable | Liability |
| 2100 | Deferred Revenue | Liability |
| 2200 | Customer Credit Balance | Liability |
| 4000 | Subscription Revenue | Revenue |
| 4100 | Application Fee Revenue | Revenue |
| 4900 | Refunds Issued | Contra-revenue |
| 6000 | Stripe Processing Fees | Expense |
| 6100 | Payment Disputes | Expense |
| 6200 | Bad Debt Expense | Expense |
| 7000 | FX Gain/Loss | Other income |

(1100 Accounts Receivable and 6200 Bad Debt Expense are posted by the B2B
net-terms flow — see
[Net-terms invoices](#net-terms-invoices-b2b-invoice-now-pay-later) below.)

## A payment: `charge.succeeded`

A customer pays $100. Stripe keeps a $3.20 fee and adds $96.80 to your balance.

```
Dr  1010 Stripe Clearing            $96.80
Dr  6000 Stripe Processing Fees      $3.20
Cr  4000 Subscription Revenue              $100.00
```

**Why:** you earned the full $100 of revenue (credit), so the gross is recognized
in full. The Stripe fee is a business expense (debit 6000), not a reduction of
revenue — keeping it separate means your top line reflects what the customer
actually paid. The cash that lands in your Stripe balance is net of the fee, so
1010 is debited for the net. Revenue ($100) = net to balance ($96.80) + fee
($3.20). *(`charge_succeeded_standard`)*

**Connect platform charges.** If the charge carries an `application_fee_amount`
(you're the platform on a destination charge), your revenue is the *application
fee*, not the customer's gross — the gross belongs to the connected account. The
credit goes to **4100 Application Fee Revenue** instead of 4000.
*(`charge_succeeded_with_app_fee`)*

A `charge.succeeded` for $0 produces no entry.

## A subscription invoice: `invoice.payment_succeeded`

This is where revenue recognition lives. The handler looks at the invoice's
line-item billing period to decide whether the revenue is earned now or over time.

### Monthly (period ≤ ~1 month) — recognize immediately

Same shape as a charge: the service period is the current month, so the revenue
is earned now.

```
Dr  1010 Stripe Clearing            $96.80
Dr  6000 Stripe Processing Fees      $3.20
Cr  4000 Subscription Revenue              $100.00
```
*(`invoice_payment_succeeded_monthly`)*

A **one-off invoice** with no subscription — every line a one-time item with an
instant period — is earned now too, and books the same immediate shape.
*(`invoice_payment_succeeded_one_time_only`)*

### Annual (period > ~1 month) — defer, then recognize monthly

A customer pays $1,200 up front for a year. You have the cash, but you have *not*
yet earned the revenue — you owe 12 months of service. Booking all $1,200 as
revenue today would overstate this month and understate the next eleven. So the
cash entry credits a **liability**, Deferred Revenue:

```
Dr  1010 Stripe Clearing         $1,164.00
Dr  6000 Stripe Processing Fees     $36.00
Cr  2100 Deferred Revenue                $1,200.00
```

Then the engine emits a **recognition schedule** — 12 future-dated entries, one
per month, each moving $100 from the liability to revenue as it's earned:

```
(each month, for 12 months)
Dr  2100 Deferred Revenue          $100.00
Cr  4000 Subscription Revenue              $100.00
```

The twelve monthly amounts sum back to exactly the $1,200 deferred (the last
month absorbs any rounding remainder). Your server persists these and posts each
on its scheduled date. This is standard ASC 606 / IFRS 15 ratable recognition.
*(`invoice_payment_succeeded_annual`)*

### Mixed invoices — recognize each line by its own term

Recognition is decided **per line item**, not once for the whole invoice. When an
annual subscription is billed on the same invoice as a one-time charge — a setup
or onboarding fee, say — the one-time line is earned now and only the
subscription line is deferred. A $1,200 annual plan plus a $300 onboarding fee:

```
Dr  1010 Stripe Clearing         (net of fee)
Dr  6000 Stripe Processing Fees  (fee)
Cr  4000 Subscription Revenue          $300.00    (one-time fee, earned now)
Cr  2100 Deferred Revenue            $1,200.00    (subscription, deferred)
```

Then the usual 12-month schedule draws down only the $1,200. The pre-tax revenue
is split between now and deferred in proportion to each portion's share of the
line total; any sales tax stays wholly in 2000 at collection, since it's owed now
regardless of when the revenue is earned.
*(`invoice_payment_succeeded_annual_plus_onetime`)*

### Sales tax

When the invoice carries Stripe Tax, the tax portion is *not* revenue — it's
money you're holding for the tax authority. It's split out to a liability:

```
Dr  1010 Stripe Clearing             (net of fee)
Dr  6000 Stripe Processing Fees      (fee)
Cr  4000 Subscription Revenue        (pre-tax revenue)
Cr  2000 Sales Tax Payable           (tax collected)
```
*(`invoice_payment_succeeded_monthly_with_tax`, `..._annual_with_tax`)*

An invoice with `amount_paid` of $0 (e.g. a fully-discounted or $0 trial invoice)
produces no entry.

### Customer credit balances

A customer can carry a **credit balance** with Stripe — money the business owes
them as future account credit rather than cash. Two events touch it, and they net
to zero over the credit's life:

**Consuming the credit** happens here, on `invoice.payment_succeeded`. An invoice
paid **from the customer's credit balance** arrives with `charge` `null` — no cash
moved through the Stripe balance. But it still has accounting impact: the customer
is spending credit ledgerly booked as a **2200 Customer Credit Balance** liability
(the issue leg is on `credit_note.created` — see
[Crediting a paid invoice to balance](#net-terms-invoices-b2b-invoice-now-pay-later)),
so the service is now delivered. Revenue is recognized and the liability drains:

```
Dr  2200 Customer Credit Balance    $55.00   (amount applied from balance)
Cr  4000 Subscription Revenue                $50.00   (pre-tax)
Cr  2000 Sales Tax Payable                    $5.00   (tax)
```

The amount applied is read from the invoice's `ending_balance - starting_balance`
delta — Stripe draws the customer's (negative) credit balance up toward zero to
cover the invoice, so that delta is populated exactly when balance funded the
payment. Only a credit that covers the **whole** invoice is booked; a partial
credit balance (the rest paid another way) stays a no-op until proportioning is
modeled (see [Known limitations](#known-limitations)).
*(`invoice_payment_succeeded_paid_from_credit_balance`)*

When the balance funds a **deferred** (annual or mixed-term) invoice, the revenue
is deferred over the service term rather than recognized all at once — the same
2100 Deferred Revenue + monthly recognition schedule a cash-paid annual invoice
builds, with the whole balance applied as the single debit (no cash, no fee):

```
Dr  2200 Customer Credit Balance   $1,320.00   (whole balance applied)
Cr  2100 Deferred Revenue                 $1,200.00   (then recognized monthly)
Cr  2000 Sales Tax Payable                  $120.00
```

A wholly-immediate invoice books Cr 4000 instead of 2100 (no schedule); a mixed
invoice splits between them per line, exactly as the cash path does.
*(`invoice_payment_succeeded_from_credit_balance_annual`)*

An invoice **marked paid out of band** (`charge` is `null`, but the balance is
untouched) produces no entry: nothing ledger-visible moved, so booking one would
fabricate revenue the engine can't balance. The balance delta tells the two apart.
*(`invoice_payment_succeeded_out_of_band`)*

### Net-terms invoices (B2B: invoice now, pay later)

Everything above assumes the card is charged when the invoice is issued
(`collection_method = charge_automatically`). B2B customers are often billed on
terms instead — an invoice is issued now (net-30, say) and paid later
(`collection_method = send_invoice`). Here revenue is earned when you issue the
invoice, and you hold a **receivable** until the customer pays.

**When the invoice is issued** (`invoice.finalized`), recognize the revenue
against Accounts Receivable — there's no cash and no Stripe fee yet:

```
Dr  1100 Accounts Receivable       $540.00
Cr  4000 Subscription Revenue              $500.00
Cr  2000 Sales Tax Payable                  $40.00
```
*(`invoice_finalized_send_invoice_monthly`)*

Recognition still works per line item, so an **annual** net-terms invoice defers
to 2100 and draws down monthly, all sitting against the receivable:

```
Dr  1100 Accounts Receivable     $1,200.00
Cr  2100 Deferred Revenue                $1,200.00      (then recognized monthly)
```
*(`invoice_finalized_send_invoice_annual`)*

**When the customer pays** (`invoice.payment_succeeded`), the cash arrives net of
the Stripe fee and clears the receivable — no revenue is booked again (it was
recognized at finalization):

```
Dr  1010 Stripe Clearing           $524.00
Dr  6000 Stripe Processing Fees     $16.00
Cr  1100 Accounts Receivable               $540.00
```
*(`invoice_payment_succeeded_send_invoice`)*

Across the two events, 1100 nets to zero and the revenue is recognized exactly
once. A `charge_automatically` invoice does no accounting at `invoice.finalized`
(its revenue is booked at payment, as above), so finalization produces no entry
for it. Net-terms invoices billed in one currency but settled in another are
**not modeled yet** — the payment handler rejects them rather than mixing
currencies in 1100 (see [Known limitations](#known-limitations)).

**If the customer never pays** (`invoice.marked_uncollectible`), the receivable
is written off to bad debt:

```
Dr  6200 Bad Debt Expense          $540.00
Cr  1100 Accounts Receivable               $540.00
```

The revenue stays recognized — under accrual accounting you earned it when you
delivered the service; the customer simply didn't pay, and that shortfall is an
expense, not a revenue reversal. Because 1100 carries the full gross from
finalization until the invoice is paid or written off (recognition moves 2100 →
4000 and never touches 1100), the write-off clears the receivable exactly no
matter how much has been recognized. *(`invoice_marked_uncollectible_send_invoice`)*

**If the invoice was issued in error** (`invoice.voided`), the finalization is
*reversed* — the invoice is treated as if never issued, the opposite of a
write-off:

```
Dr  4000 Subscription Revenue      $500.00
Dr  2000 Sales Tax Payable          $40.00
Cr  1100 Accounts Receivable               $540.00
```

Because a void only applies to an open, unpaid invoice, 1100 still carries the
full gross from finalization, so reversing it against the same gross zeroes
every account the invoice touched — no revenue, no receivable, no tax left
behind. *(`invoice_voided_send_invoice_monthly`)*

When the invoice **deferred part of its revenue** to 2100 (an annual or mixed
term, so finalization built a recognition schedule), the reversal is stateful:
it depends on how much the schedule has already recognized, and the unposted
months must be cancelled so they never recognize against a voided invoice. The
pure engine can't see that state, so `handleInvoiceVoided` reverses only the
no-deferred case and *refuses* a deferred one. The bundled receiver
([server](../src/server)) closes the gap: it reconciles the void against the
ledger — reversing recognized revenue (Dr 4000), clearing the remaining deferred
balance (Dr 2100), reversing the receivable (Cr 1100), and cancelling the
still-pending schedule rows — so every account the invoice touched returns to
zero no matter when the void arrives.

**If you credit part of an open invoice** (`credit_note.created`, a *pre-payment*
credit note), the customer owes less. Unlike a void, a credit note is usually
*partial* — the credit note carries its own `subtotal` and `total`, so ledgerly
reverses exactly that slice against the receivable:

```
Dr  4000 Subscription Revenue      $100.00     (credit note subtotal)
Dr  2000 Sales Tax Payable           $8.00     (credit note tax)
Cr  1100 Accounts Receivable               $108.00      (credit note total)
```

The receivable drops by the credited total and the rest of the invoice stands.
*(`credit_note_created_send_invoice_prepayment`)* This is the **no-deferred** case,
booked by the pure engine. When the invoice deferred part of its revenue to a
recognition schedule, the credit is stateful and the bundled receiver reconciles
it — see [Crediting a deferred-schedule invoice](#crediting-a-deferred-schedule-invoice)
below.

**If you credit an already-paid invoice back to the customer's balance**
(`credit_note.created`, a *post-payment* credit note whose credit goes entirely to
`customer_balance_transaction` rather than a cash refund), the customer keeps the
money as account credit. The invoice's revenue was recognized when it was paid, so
returning it reverses that revenue and books the credit owed as a **2200 Customer
Credit Balance** liability; the cash already collected stays put:

```
Dr  4000 Subscription Revenue      $50.00     (credit note subtotal)
Dr  2000 Sales Tax Payable          $5.00     (credit note tax)
Cr  2200 Customer Credit Balance           $55.00      (credit note total)
```

That liability drains later, when the customer spends the credit on another
invoice (see [Customer credit balances](#customer-credit-balances)); the two legs
net 2200 to zero and recognize the revenue exactly once, at consumption. A
*refund-backed* post-payment credit note stays a no-op here — the cash returned is
booked by `charge.refunded`. This is the **no-deferred** case; a post-payment credit
against a deferred invoice is reconciled statefully, below.
*(`credit_note_created_post_payment_to_balance`)*

**Crediting a deferred-schedule invoice** (`credit_note.created`) is stateful,
exactly like a deferred void. Finalization (pre-payment) or the card payment
(post-payment) deferred part of the revenue to 2100 and built a recognition
schedule; by the time the credit arrives, some of that schedule may already have
recognized. The pure engine refuses this case (it can't see how much has
recognized); the bundled receiver reconciles it against the ledger. Reading the
schedule rows, it reduces the **still-deferred** balance first (Dr 2100) and only
claws back recognized revenue (Dr 4000) when the credit exceeds all remaining
deferred, reverses the tax (Dr 2000), and credits the receivable (Cr 1100,
pre-payment) or the customer balance (Cr 2200, post-payment). It then re-spreads
what remains deferred over the unposted months, cancelling the old schedule rows.
So revenue already earned for delivered months stays put, and the invoice's
lifetime revenue equals the original contract minus the credit. A three-months-in
$300 credit on a $1,200 annual plan:

```
Dr  2100 Deferred Revenue          $300.00     (still-deferred reduced first)
Cr  1100 Accounts Receivable               $300.00      (or Cr 2200 if to balance)
```

Cross-currency (FX) deferred credits are refused rather than approximated (see
[Known limitations](#known-limitations)).

**If a credit note was a mistake** (`credit_note.voided`), the entry it booked is
undone with the sides flipped, restoring exactly what was there before: a
pre-payment note restores the receivable (Dr 1100, Cr 4000, Cr 2000); a
post-payment-to-balance note claws the credit back (Dr 2200, Cr 4000, Cr 2000).
Both events gate on the same conditions, so a void un-books exactly what creation
booked, and voiding a credit note ledgerly never booked (refund-backed
post-payment, a `charge_automatically` pre-payment) is itself a no-op.
*(`credit_note_voided_send_invoice_prepayment`, `credit_note_voided_post_payment_to_balance`)*

Voiding a credit note that was a **deferred draw-down** is likewise stateful and
handled by the bundled receiver: it inverts the draw-down's own journal entry
(restoring 1100/2200, 4000, 2100 and the tax) and re-inflates the recognition
schedule over the remaining months, so the invoice returns to its pre-credit
trajectory. Months that recognized at the reduced rate between the credit and its
void leave a small bounded timing residual (see
[Known limitations](#known-limitations)).

## A refund: `charge.refunded`

You refund a $100 sale. The money leaves your Stripe balance, and the sale is
reversed:

```
Dr  4900 Refunds Issued            $100.00
Cr  1010 Stripe Clearing                   $100.00
```

**Why 4900 and not a debit to 4000?** Refunds post to a dedicated
**contra-revenue** account rather than reversing Subscription Revenue directly.
This preserves gross revenue as a reportable number and shows refunds as their
own line — so you can see both "revenue" and "refunds" instead of a single netted
figure. The Stripe processing fee on the original charge is **not** returned by
Stripe on a refund, so there's no fee reversal here. *(`charge_refunded_full`)*

**Partial refunds** post the partial amount; multiple refunds on one charge each
get their own entry. *(`charge_refunded_partial`, `charge_refunded_multi_first`)*

**Refunding a taxed sale.** If the original sale collected sales tax, the refund
drains the tax liability proportionally — otherwise you'd be left owing tax on a
sale that no longer exists:

```
Dr  4900 Refunds Issued            (pre-tax portion)
Dr  2000 Sales Tax Payable         (tax portion)
Cr  1010 Stripe Clearing                   (total refunded)
```

The tax portion is computed from the original invoice's tax ratio. When a taxed
sale is refunded across several partial refunds, the tax is drawn back
cumulatively, so the pieces sum to exactly the tax originally collected and 2000
returns to zero once the sale is fully refunded — no penny stranded by rounding.
This requires the charge's `invoice` to be expanded; if it isn't, the refund falls
back to the flat two-line shape above. *(`charge_refunded_with_tax`)*

## Disputes (chargebacks)

A dispute moves through a lifecycle, and ledgerly books each step as the money
actually moves — it does **not** guess the outcome up front.

### 1. Funds withdrawn: `charge.dispute.funds_withdrawn`

When a customer disputes a charge, Stripe immediately pulls the disputed amount
plus a non-refundable dispute fee out of your balance. The disputed amount isn't
an expense *yet* (you might win), so it's parked in an asset, **Disputes
Receivable**. The dispute fee, however, is gone for good — it's an expense now:

```
Dr  1200 Disputes Receivable       $100.00   (disputed amount, pending outcome)
Dr  6100 Payment Disputes           $15.00   (non-refundable dispute fee)
Cr  1010 Stripe Clearing                   $115.00   (total pulled from balance)
```
*(`dispute_funds_withdrawn_standard`)*

The disputed amount and the fee are told apart by Stripe's fee metadata, not by
which is larger — so a **small-value dispute** where the fee exceeds the disputed
amount (e.g. a $9.99 charge with a $15 fee) still parks the $9.99 in 1200 and
expenses the $15 to 6100, rather than inverting them. *(`dispute_funds_withdrawn_small_amount`)*

### 2a. You lose: `charge.dispute.closed` (status `lost`)

The disputed funds are gone. The receivable becomes an expense (a write-off):

```
Dr  6100 Payment Disputes          $100.00
Cr  1200 Disputes Receivable               $100.00
```

Net result across withdrawal + loss: the $100 and the $15 fee are both in 6100,
and 1200 is back to zero. *(`dispute_closed_lost`)*

### 2b. You win: `charge.dispute.funds_reinstated`

Stripe returns the disputed amount to your balance. The receivable is released
back to cash:

```
Dr  1010 Stripe Clearing           $100.00
Cr  1200 Disputes Receivable               $100.00
```

Net result across withdrawal + win: 1200 is back to zero, your cash is whole
again, and you're out only the $15 dispute fee (still in 6100). *(`dispute_funds_reinstated_won`)*

A `charge.dispute.closed` with status `won` or `warning_closed` produces no entry
on its own — the money movement (if any) arrives on the `funds_reinstated` event.

## Payouts: `payout.paid` and `payout.failed`

A payout moves earned funds from your Stripe balance to your real bank account.
No revenue or expense is involved — it's a transfer between two asset accounts:

```
payout.paid
Dr  1000 Operating Bank            $5,000.00
Cr  1010 Stripe Clearing                  $5,000.00
```
*(`payout_paid_standard`)*

If a payout fails, the reversal is booked (funds return to the Stripe balance),
dated when Stripe detected the failure:

```
payout.failed
Dr  1010 Stripe Clearing           $5,000.00
Cr  1000 Operating Bank                   $5,000.00
```
*(`payout_failed_standard`)*

**Cross-currency payouts** (where Stripe converts between your settlement currency
and a foreign bank account) are **rejected with an error**, not approximated —
modeling Stripe's FX conversion fee on these needs real payload data we don't yet
have. See [`docs/cross-currency-payouts.md`](./cross-currency-payouts.md).

## Foreign exchange

When your Stripe account settles in a different currency than the customer was
charged (e.g. a Canadian-based account billing a US customer in USD), every entry
posts in your **settlement** currency, taken from the balance transaction. That
keeps each entry internally balanced and consistent with the currency your books
are actually in.

**Realized FX gain/loss (account 7000).** When the exchange rate moves between an
original charge and a later refund or dispute, ledgerly books the revenue-offset
and receivable legs at the *original* charge's rate (so they cleanly mirror what
was booked) and the cash leg at the *current* rate (what Stripe actually moved),
and routes the difference to **7000 FX Gain/Loss** as a realized gain or loss.

This runs through the whole dispute lifecycle, not just the withdrawal. The 1200
Disputes Receivable is *parked* at the original charge's rate when funds are
withdrawn and *released* at that same rate when the dispute resolves, so it clears
back to exactly zero no matter how the rate moved in between. A win
(`funds_reinstated`) returns the cash at the current rate and sends the rate delta
to 7000; a loss (`closed`) writes the receivable off to 6100 at its carried
settlement value. *(`charge_refunded_fx`, `dispute_funds_withdrawn_fx_rate_drift`,
`dispute_funds_reinstated_fx_rate_drift`, `dispute_closed_lost_fx`)*

**Multi-period FX is not auto-computed.** For an annual subscription billed in a
foreign currency, ledgerly doesn't revalue each month's recognition against that
month's rate (it has no rate source). Instead every affected entry carries an
optional `fxContext` field exposing both the customer-currency and
settlement-currency amounts (pro-rated per month), so a downstream tool with a
rate source can compute the monthly revaluation itself.
*(`invoice_payment_succeeded_annual_fx`)*

## Events with no accounting impact

These are acknowledged but produce no entry, because nothing has moved that the
ledger needs to record:

- `charge.failed` — no money moved.
- `charge.dispute.created` — notification; funds move on `funds_withdrawn`.
- `invoice.payment_failed` — dunning; no money moved.
- `customer.subscription.updated` / `customer.subscription.deleted` — metadata.

Any event type outside the supported list throws `UnhandledEventError` rather
than silently doing nothing, so you'll notice if an accounting-relevant event
isn't handled yet.

## Invariants the engine guarantees

- Every emitted entry balances exactly (debits = credits, integer cents).
- Same input always produces the same output (the mapping is a pure function).
- Every amount is an integer in the currency's smallest unit.
- Every entry carries the source Stripe event ID and object ID for audit trails.

## Known limitations

These are deliberate gaps, documented rather than approximated:

- **Voiding a net-terms invoice — pure engine vs. bundled server**
  (`invoice.voided`). A void with no deferred portion is fully modeled in the
  pure engine (it reverses the finalization entry). A void of an invoice that
  deferred to 2100 needs stateful reversal (how much has recognized) plus
  schedule cancellation, which a per-event engine can't do — so the pure engine
  *refuses* that case with a clear error. The bundled receiver reconciles it
  against the ledger instead, so a full deployment handles both; only a
  consumer calling the engine directly (no ledger) sees the refusal. See
  [Net-terms invoices](#net-terms-invoices-b2b-invoice-now-pay-later).
- **Cross-currency B2B (net-terms) settlement** — a `send_invoice` invoice billed
  in one currency but paid in another. The 1100 receivable is booked in the
  invoice currency at finalization, so clearing it in a different settlement
  currency would mix currencies in one account and needs a realized FX delta;
  the payment handler rejects this case with a clear error rather than
  mis-posting. Same-currency net-terms invoicing is fully modeled (see
  [Net-terms invoices](#net-terms-invoices-b2b-invoice-now-pay-later)).
- **Customer credit balances — split case** — a post-payment credit note credited
  **entirely** to the customer's balance, and an invoice paid **entirely** from that
  balance, are modeled (2200 Customer Credit Balance — see
  [Customer credit balances](#customer-credit-balances)), including when the
  consumed invoice **defers** its revenue (the balance funds a fresh recognition
  schedule). Still a gap: a credit note **split** across a cash refund and the
  balance (needs proportioning) stays a no-op.
- **Out-of-band payments** — an invoice marked paid out of band (`charge` `null`,
  the customer's balance untouched) is acknowledged with no entry: no cash moved
  through Stripe and no credit was drawn, so there is nothing ledger-visible to
  book.
- **Crediting a deferred-schedule invoice — pure engine vs. bundled server**
  (`credit_note.created`). A credit note against an invoice with **no** deferred
  schedule is booked by the pure engine (pre-payment reduces 1100; post-payment to
  balance books 2200). When the invoice **deferred** to a schedule, a correct
  reversal must draw that schedule down (reduce the still-deferred balance first,
  claw back recognized revenue only if the credit exceeds it, and re-spread the
  remaining months) — stateful, so the pure engine *refuses* it and the bundled
  receiver reconciles it against the ledger, exactly like a deferred void — and
  `credit_note.voided` undoes it symmetrically (invert the draw-down entry,
  re-inflate the schedule). See
  [Crediting a deferred-schedule invoice](#crediting-a-deferred-schedule-invoice).
  Remaining gaps: an **FX-bearing** deferred draw-down (the schedule's settlement
  currency differs from the credit's currency) is refused rather than approximated;
  voiding a deferred credit whose schedule has **no remaining pending rows** (the
  draw-down cancelled the whole tail, or every remaining month posted before a
  late-arriving void) is **refused** — there are no future months to re-spread the
  restored deferred amount onto, so rather than strand it in 2100 the receiver
  errors and an operator posts the correction; and when a deferred credit is voided
  while pending rows remain, any months that recognized at the reduced rate
  **between** the credit and its void are not retroactively re-recognized — the
  re-inflated remaining months restore the lifetime total, but that specific timing
  is not (a bounded residual).
- **Multi-period FX revaluation** — exposed via `fxContext`, not auto-posted (see
  above).
- **Cross-currency payouts** — rejected with a clear error (see above).

Found something that looks wrong? That's exactly the kind of issue worth filing.
