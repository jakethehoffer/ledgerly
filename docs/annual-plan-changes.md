# What happens to a yearly Stripe plan when a customer upgrades or cancels?

A customer pays $1,200 for a year. Six months later, they change their plan. What happens to the money you already counted as earned, and to the months still ahead?

Here is a checked Ledgerly example. It assumes one service spread evenly across a year, US dollars, and no tax or currency change. It describes what the software does. Your agreement with the customer and your accounting rules still decide what should count as earned.

The original payment is $1,200. This sample includes a $36 payment fee, leaving $1,164 in Stripe. Ledgerly records the full $1,200 as money received for work still to be done. It then makes twelve monthly entries of $100. The fee is recorded separately. It does not turn the year's sales into $1,164.

The plan runs from January 15 to the next January 15. In this example, six monthly entries have been recorded by July 15. That means $600 has been counted as earned and $600 remains for the rest of the year.

**If the customer pays for an upgrade**

Suppose the upgrade bill takes off $600 for the unused old plan and charges $1,200 for the remaining time on the new plan. The customer pays the $600 difference. Those are supplied sample amounts, not a quote from Stripe. The upgrade fee is set to zero here so the schedule is easier to follow.

Stripe calls adjustments for part of a billing period “prorations.” The actual amounts depend on the dates and settings. A credit for unused time does not automatically mean money was sent back to the customer. [Stripe explains these adjustments here](https://docs.stripe.com/billing/subscriptions/prorations).

Ledgerly keeps the six monthly entries already recorded. It replaces the old future entries with a schedule that includes both the remaining $600 and the new $600 payment. Each of the six remaining dates now has two $100 entries, or $200 in total. They stay separate so a later credit can be tied to the right bill.

The total earned across the whole example is $1,800: the original $1,200 plus the new $600. The new schedule finishes on the original end date. A repeat notice about the same payment does not record that payment or add its schedule twice.

**If the customer wants to stop renewing**

Ending at the next renewal date lets the customer use the time they already paid for. The request to stop renewing is different from the date the service actually ends. [Stripe describes both choices here](https://docs.stripe.com/billing/subscriptions/cancel).

Ledgerly leaves the remaining monthly entries in place when a cancellation is only planned. In this example, the full year's $1,200 can still pass through the schedule while service continues. Ending at the paid term's end does not hold any of those entries.

**If service ends after six months**

Now suppose service actually ends on July 15, after the sixth $100 entry has been recorded.

Ledgerly keeps that $600 of recorded income. It holds the six later entries, worth $600 in total, for review. It does not invent a refund, create customer credit, or count the held amount as earned just because the plan ended. The end notice creates no new money entry. The remaining balance needs the right treatment for the customer's agreement and any actual credit or refund.

This is a monthly schedule. Ledgerly does not calculate a fresh daily split when service ends between its monthly dates. Entries dated on the end date are kept. A partial-month case needs separate review.

**Try the first step**

The [ready-to-run sample](../README.md#try-it) uses example data and does not need a payment account. It shows the original $1,200 annual schedule. You can also inspect the initial payment's sample QuickBooks or Xero output without sending anything. Those two export options leave out the later monthly entries.

The upgrade and cancellation examples above were checked against the released Ledgerly download. They use its saved schedule handling. Running a single event by itself does not reconstruct earlier payments. A live setup needs the bundled receiver, saved history, and account setup. This check did not connect to live Stripe, Xero, or QuickBooks accounts. The upgrade example covers an extra payment in the same currency. It does not prove support for changes to a cheaper plan, unpaid changes, or changes involving different currencies.

If you already move Stripe records into Xero or QuickBooks, [tell us what happened when you tried the sample](https://github.com/jakethehoffer/ledgerly/issues/new). Did it run? Which repeated job would it help with? What would stop you using it? Please leave out customer details and private payment records.

*AI helped write this guide. Its example amounts and schedule changes were checked against Ledgerly's published download on October 7, 2026.*
