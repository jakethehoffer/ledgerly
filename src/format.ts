// Readable text rendering of mapped entries, shared by the CLI and the
// read-only Stripe preview.
import { checkBalance } from './journal.js';
import type { JournalEntry, MapResult } from './journal.js';
import { ACCOUNTS } from './accounts.js';
import { currencyMinorUnits, minorToMajor } from './currency.js';

/**
 * Format a smallest-unit amount for reading. US dollars keep the familiar `$`
 * sign. Any other currency shows its code, so books kept in another
 * settlement currency are never mistaken for dollars.
 */
export function money(amount: number, currency = 'USD'): string {
  const code = currency.toUpperCase();
  const major = minorToMajor(amount, code).toFixed(currencyMinorUnits(code));
  return code === 'USD' ? `$${major}` : `${major} ${code}`;
}

const rule = (n = 60): string => '-'.repeat(n);

function formatEntry(entry: JournalEntry): string {
  const fmt = (amount: number): string => money(amount, entry.currency);
  const out: string[] = [];
  out.push(`${entry.date}  ${entry.memo}`);
  out.push(rule());
  out.push('Account'.padEnd(34) + 'Debit'.padStart(13) + 'Credit'.padStart(13));
  out.push(rule());
  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of entry.lines) {
    const label = `${line.accountCode} ${ACCOUNTS[line.accountCode].name}`;
    const debit = line.side === 'debit' ? fmt(line.amount) : '';
    const credit = line.side === 'credit' ? fmt(line.amount) : '';
    if (line.side === 'debit') debitTotal += line.amount;
    else creditTotal += line.amount;
    out.push(label.padEnd(34) + debit.padStart(13) + credit.padStart(13));
  }
  out.push(rule());
  out.push('Totals'.padEnd(34) + fmt(debitTotal).padStart(13) + fmt(creditTotal).padStart(13));
  const report = checkBalance(entry);
  out.push(
    report.balanced
      ? `balanced: debits ${fmt(report.debitTotal)} == credits ${fmt(report.creditTotal)}`
      : `NOT BALANCED: difference ${fmt(report.difference)}`,
  );
  return out.join('\n');
}

function formatSchedule(schedule: NonNullable<MapResult['schedule']>): string {
  const currency = schedule.entries[0]?.currency ?? 'USD';
  const fmt = (amount: number): string => money(amount, currency);
  const total = schedule.entries.reduce(
    (sum, e) => sum + (e.lines.find((l) => l.side === 'credit')?.amount ?? 0),
    0,
  );
  const out: string[] = [];
  out.push(`RECOGNITION SCHEDULE — ${String(schedule.entries.length)} future entries releasing ${fmt(total)} deferred`);
  out.push('each entry: Dr 2100 Deferred Revenue  /  Cr 4000 Subscription Revenue');
  out.push(rule(40));
  for (const e of schedule.entries) {
    const amount = e.lines.find((l) => l.side === 'credit')?.amount ?? 0;
    out.push(e.date.padEnd(28) + fmt(amount).padStart(12));
  }
  out.push(rule(40));
  out.push('total recognized'.padEnd(28) + fmt(total).padStart(12));
  return out.join('\n');
}

/**
 * Render a {@link MapResult} as human-readable text: one balanced table per
 * immediate entry, plus a summary of the recognition schedule when present. An
 * event with no accounting impact (informational, or a documented no-op) is
 * stated plainly rather than printing an empty table.
 */
export function formatMapResult(result: MapResult): string {
  if (result.entries.length === 0 && (result.schedule === null || result.schedule.entries.length === 0)) {
    return 'No journal entry — this event is acknowledged with no accounting impact (informational, or a documented no-op).';
  }
  const blocks: string[] = result.entries.map(formatEntry);
  if (result.schedule && result.schedule.entries.length > 0) {
    blocks.push(formatSchedule(result.schedule));
  }
  return blocks.join('\n\n');
}
