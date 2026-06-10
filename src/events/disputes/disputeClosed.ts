import type Stripe from 'stripe';
import { cents } from '../../money.js';
import type { JournalEntry, JournalLine, MapResult } from '../../journal.js';
import { epochToUtcDate } from '../../util/dates.js';
import { buildFxContext, withFx } from '../../util/fxContext.js';
import { sortLines } from '../../util/lines.js';
import { disputeMemo } from '../../util/memo.js';
import { originalChargeSettlement } from './disputeRate.js';

export function handleDisputeClosed(event: Stripe.Event): MapResult {
  if (event.type !== 'charge.dispute.closed') {
    throw new Error(
      `handleDisputeClosed received wrong event type: ${event.type}`,
    );
  }
  const dispute = event.data.object;
  // FX-aware writeoff: a lost dispute releases the 1200 receivable that
  // funds_withdrawn parked at the ORIGINAL charge rate, in the account's
  // settlement currency. The receiver's expand.ts requests
  // `charge.balance_transaction` on closed events, so originalChargeSettlement
  // recovers that rate and currency; the lost branch below uses them so the
  // writeoff clears 1200 exactly with no account-level currency mixing.

  switch (dispute.status) {
    case 'won':
    case 'warning_closed':
      // 'won' returns money on a separate funds_reinstated event; warning_closed
      // disputes have no financial movement at all.
      return { entries: [], schedule: null };
    case 'lost': {
      if (dispute.amount === 0) {
        return { entries: [], schedule: null };
      }
      // Write the receivable off at its CARRIED value — the same
      // original-charge-rate amount funds_withdrawn parked in 1200 — and post
      // in the settlement currency so it clears 1200 exactly. The FX gain/loss
      // was already realized at withdrawal (its 7000 line); a lost close just
      // reclassifies the parked receivable to expense, so no new 7000 line.
      //
      // Fallback when the charge BT isn't expanded (string id): the dispute's
      // own customer-facing amount and currency — byte-identical to v0.1.6 and
      // to same-currency disputes (original rate 1.0).
      const settlement = originalChargeSettlement(dispute);
      const writeoff =
        settlement !== null && dispute.amount > 0
          ? Math.round(dispute.amount * settlement.rate)
          : dispute.amount;
      const settlementCurrencyRaw =
        settlement !== null ? settlement.currency : dispute.currency;
      const amount = cents(writeoff);
      const rawLines: JournalLine[] = [
        {
          accountCode: '6100',
          side: 'debit',
          amount,
          memo: 'Dispute lost — writeoff of receivable',
        },
        {
          accountCode: '1200',
          side: 'credit',
          amount,
          memo: 'Release receivable to expense',
        },
      ];
      const lines: ReadonlyArray<JournalLine> = sortLines(rawLines);
      const fxContext = buildFxContext(
        dispute.currency,
        dispute.amount,
        settlementCurrencyRaw,
        writeoff,
      );
      const entry: JournalEntry = withFx(
        {
          date: epochToUtcDate(event.created),
          currency: settlementCurrencyRaw.toUpperCase(),
          memo: disputeMemo(dispute, 'closed lost'),
          sourceEventId: event.id,
          sourceEventType: event.type,
          sourceObjectId: dispute.id,
          lines,
        },
        fxContext,
      );
      return { entries: [entry], schedule: null };
    }
    default:
      throw new Error(
        `Unrecognized dispute.status on closed event for ${dispute.id}: ${String(dispute.status)}`,
      );
  }
}
