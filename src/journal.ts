import { cents, type Cents } from './money.js';
import type { AccountCode, PostingSide } from './accounts.js';

export interface JournalLine {
  readonly accountCode: AccountCode;
  readonly side: PostingSide;
  readonly amount: Cents;
  readonly memo?: string;
}

/**
 * Optional FX provenance attached to a {@link JournalEntry} when Stripe
 * converted between currencies on the source event (customer-facing ≠
 * settlement). The engine doesn't itself do anything with this metadata —
 * entries always balance in `JournalEntry.currency` (the settlement
 * currency) — but downstream tools that need home-currency books or
 * month-by-month FX revaluation can use it to compute their own
 * conversions against an external rate source.
 *
 * For multi-period recognition schedule entries (annual subscriptions
 * recognized monthly), `customerAmount` and `settlementAmount` are
 * pro-rated to that month's portion. The last month absorbs any rounding
 * remainder so the schedule's `customerAmount` sum equals the invoice's
 * customer-facing amount exactly.
 *
 * Currencies are uppercase ISO 4217 codes — matching
 * {@link JournalEntry.currency} so callers can compare or format both
 * with the same casing rules.
 */
export interface FxContext {
  readonly customerCurrency: string;
  readonly customerAmount: Cents;
  readonly settlementCurrency: string;
  readonly settlementAmount: Cents;
}

export interface JournalEntry {
  readonly date: string;            // ISO YYYY-MM-DD
  readonly currency: string;        // 'USD'
  readonly memo: string;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
  readonly sourceObjectId?: string;
  readonly lines: ReadonlyArray<JournalLine>;
  /**
   * Present only when the source event involved an FX conversion. See
   * {@link FxContext}. Same-currency events omit this field so
   * downstream JSON serialization stays minimal.
   */
  readonly fxContext?: FxContext;
}

export interface RecognitionSchedule {
  readonly subscriptionId: string;
  readonly sourceEventId: string;
  readonly entries: ReadonlyArray<JournalEntry>;
}

export interface MapResult {
  readonly entries: ReadonlyArray<JournalEntry>;
  readonly schedule: RecognitionSchedule | null;
}

export interface BalanceReport {
  readonly debitTotal: Cents;
  readonly creditTotal: Cents;
  readonly difference: number; // signed: + = excess debits
  readonly balanced: boolean;
}

export function checkBalance(entry: JournalEntry): BalanceReport {
  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of entry.lines) {
    if (line.side === 'debit') debitTotal += line.amount;
    else creditTotal += line.amount;
  }
  const difference = debitTotal - creditTotal;
  return {
    debitTotal: cents(debitTotal),
    creditTotal: cents(creditTotal),
    difference,
    balanced: difference === 0,
  };
}

export function assertBalanced(entry: JournalEntry): void {
  const report = checkBalance(entry);
  if (!report.balanced) {
    throw new Error(
      `Unbalanced journal entry (event ${entry.sourceEventId}, ` +
        `date=${entry.date}, currency=${entry.currency}): ` +
        `debits=${String(report.debitTotal)} credits=${String(report.creditTotal)} ` +
        `difference=${String(report.difference)}`,
    );
  }
}
