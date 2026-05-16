import { cents, type Cents } from './money.js';
import type { AccountCode, PostingSide } from './accounts.js';

export interface JournalLine {
  readonly accountCode: AccountCode;
  readonly side: PostingSide;
  readonly amount: Cents;
  readonly memo?: string;
}

export interface JournalEntry {
  readonly date: string;            // ISO YYYY-MM-DD
  readonly currency: string;        // 'USD'
  readonly memo: string;
  readonly sourceEventId: string;
  readonly sourceEventType: string;
  readonly sourceObjectId?: string;
  readonly lines: ReadonlyArray<JournalLine>;
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
      `Unbalanced journal entry (event ${entry.sourceEventId}): ` +
        `debits=${String(report.debitTotal)} credits=${String(report.creditTotal)} ` +
        `difference=${String(report.difference)}`,
    );
  }
}
