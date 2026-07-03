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
- **The caller maps account codes.** ledgerly emits 12 stable account *codes*;
  you map each to your real QuickBooks/Xero account once. Codes and names are in
  the README's [Chart of accounts](../README.md#chart-of-accounts).

Account codes referenced below:

| Code | Name | Type |
|------|------|------|
| 1000 | Operating Bank | Asset |
| 1010 | Stripe Clearing | Asset |
| 1200 | Disputes Receivable | Asset |
| 2000 | Sales Tax Payable | Liability |
| 2100 | Deferred Revenue | Liability |
| 4000 | Subscription Revenue | Revenue |
| 4100 | Application Fee Revenue | Revenue |
| 4900 | Refunds Issued | Contra-revenue |
| 6000 | Stripe Processing Fees | Expense |
| 6100 | Payment Disputes | Expense |
| 7000 | FX Gain/Loss | Other income |

(1100 Accounts Receivable is reserved for a future B2B invoice-then-pay flow and
is not posted to today.)

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

- **B2B accounts-receivable** (invoice issued now, paid later) — account 1100 is
  reserved but the flow isn't implemented; today's handlers assume
  charge-at-invoice.
- **Multi-period FX revaluation** — exposed via `fxContext`, not auto-posted (see
  above).
- **Cross-currency payouts** — rejected with a clear error (see above).

Found something that looks wrong? That's exactly the kind of issue worth filing.
