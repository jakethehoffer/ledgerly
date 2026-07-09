#!/usr/bin/env node
// `ledgerly` — map a single Stripe event (from stdin or a file) to its
// double-entry journal entry and print it. A zero-install way to see the engine
// work on your own event: `cat event.json | npx ledgerly`.
//
// This is the pure mapping CLI; the webhook receiver is the separate
// `ledgerly-server` bin. The engine never calls Stripe, so pre-expand nested
// objects (balance_transaction, invoice.charge, credit_note.invoice) first.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from './engine.js';
import { checkBalance } from './journal.js';
import type { JournalEntry, MapResult } from './journal.js';
import { ACCOUNTS } from './accounts.js';
import { MissingExpansionError, UnhandledEventError } from './errors.js';
import { toQbo } from './exporters/qbo.js';
import { toXero } from './exporters/xero.js';
import type { QboAccountMap, XeroAccountMap } from './exporters/types.js';

const usd = (c: number): string => `$${(c / 100).toFixed(2)}`;
const rule = (n = 60): string => '-'.repeat(n);

function formatEntry(entry: JournalEntry): string {
  const out: string[] = [];
  out.push(`${entry.date}  ${entry.memo}`);
  out.push(rule());
  out.push('Account'.padEnd(34) + 'Debit'.padStart(13) + 'Credit'.padStart(13));
  out.push(rule());
  let debitTotal = 0;
  let creditTotal = 0;
  for (const line of entry.lines) {
    const label = `${line.accountCode} ${ACCOUNTS[line.accountCode].name}`;
    const debit = line.side === 'debit' ? usd(line.amount) : '';
    const credit = line.side === 'credit' ? usd(line.amount) : '';
    if (line.side === 'debit') debitTotal += line.amount;
    else creditTotal += line.amount;
    out.push(label.padEnd(34) + debit.padStart(13) + credit.padStart(13));
  }
  out.push(rule());
  out.push('Totals'.padEnd(34) + usd(debitTotal).padStart(13) + usd(creditTotal).padStart(13));
  const report = checkBalance(entry);
  out.push(
    report.balanced
      ? `balanced: debits ${usd(report.debitTotal)} == credits ${usd(report.creditTotal)}`
      : `NOT BALANCED: difference ${usd(report.difference)}`,
  );
  return out.join('\n');
}

function formatSchedule(schedule: NonNullable<MapResult['schedule']>): string {
  const total = schedule.entries.reduce(
    (sum, e) => sum + (e.lines.find((l) => l.side === 'credit')?.amount ?? 0),
    0,
  );
  const out: string[] = [];
  out.push(`RECOGNITION SCHEDULE — ${String(schedule.entries.length)} future entries releasing ${usd(total)} deferred`);
  out.push('each entry: Dr 2100 Deferred Revenue  /  Cr 4000 Subscription Revenue');
  out.push(rule(40));
  for (const e of schedule.entries) {
    const amount = e.lines.find((l) => l.side === 'credit')?.amount ?? 0;
    out.push(e.date.padEnd(28) + usd(amount).padStart(12));
  }
  out.push(rule(40));
  out.push('total recognized'.padEnd(28) + usd(total).padStart(12));
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

// Placeholder account maps so `--qbo` / `--xero` can render the export shape
// without configuration. The IDs/codes are stand-ins — a real deployment maps
// ledgerly's account codes to its own QBO account IDs / Xero account codes once
// (see the README). Built off the canonical chart so every code is covered.
const PLACEHOLDER_QBO: QboAccountMap = Object.fromEntries(
  Object.values(ACCOUNTS).map((a, i) => [a.code, { qboId: String(80 + i), name: a.name }]),
) as QboAccountMap;
const PLACEHOLDER_XERO: XeroAccountMap = Object.fromEntries(
  Object.values(ACCOUNTS).map((a, i) => [a.code, { accountCode: String(600 + i) }]),
) as XeroAccountMap;

/**
 * Render a {@link MapResult}'s immediate entries as QuickBooks Online
 * `JournalEntry` JSON (an array), using placeholder account IDs. Returns `"[]"`
 * for an event with no entries.
 */
export function formatQbo(result: MapResult): string {
  return JSON.stringify(
    result.entries.map((entry) => toQbo(entry, PLACEHOLDER_QBO)),
    null,
    2,
  );
}

/**
 * Render a {@link MapResult}'s immediate entries as Xero `ManualJournal` JSON (an
 * array), using placeholder account codes. Returns `"[]"` for an event with no
 * entries.
 */
export function formatXero(result: MapResult): string {
  return JSON.stringify(
    result.entries.map((entry) => toXero(entry, PLACEHOLDER_XERO)),
    null,
    2,
  );
}

/**
 * Parse a raw Stripe event JSON string and run it through {@link mapEvent}.
 * Throws a clear error when the input is not valid JSON; propagates the engine's
 * own errors (UnhandledEventError, MissingExpansionError) otherwise.
 */
export function mapEventJson(input: string): MapResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new Error(
      `Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return mapEvent(parsed as Stripe.Event);
}

const HELP = `ledgerly — map a Stripe event to double-entry journal entries

Usage:
  cat event.json | ledgerly
  ledgerly event.json [--json]

Reads a Stripe event JSON (from stdin or a file argument) and prints the balanced
journal entry it maps to. Pre-expand nested objects (balance_transaction,
invoice.charge, credit_note.invoice) before piping — the engine never calls Stripe.

Options:
  --json      Print the raw MapResult JSON instead of the readable table.
  --qbo       Print QuickBooks Online JournalEntry JSON (placeholder account IDs).
  --xero      Print Xero ManualJournal JSON (placeholder account codes).
  -h, --help  Show this help.
`;

function main(argv: string[]): number {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const jsonOut = argv.includes('--json');
  const fileArg = argv.find((a) => !a.startsWith('-'));

  let input: string;
  try {
    // fd 0 is stdin; readFileSync reads it to EOF for piped/redirected input.
    input = fileArg ? readFileSync(fileArg, 'utf8') : readFileSync(0, 'utf8');
  } catch (err) {
    process.stderr.write(
      `ledgerly: could not read input: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  if (input.trim() === '') {
    process.stderr.write(
      "ledgerly: no input. Pipe a Stripe event JSON on stdin, or pass a file path.\n" +
        "Example: cat event.json | ledgerly\n",
    );
    return 1;
  }

  let result: MapResult;
  try {
    result = mapEventJson(input);
  } catch (err) {
    if (err instanceof UnhandledEventError) {
      process.stderr.write(
        `ledgerly: ${err.message}\n` +
          `That event type is not mapped — see the README's event table for the supported list.\n`,
      );
      return 1;
    }
    if (err instanceof MissingExpansionError) {
      process.stderr.write(
        `ledgerly: ${err.message}\n` +
          `Expand the nested Stripe objects (balance_transaction, invoice.charge, ` +
          `credit_note.invoice) before piping the event — the engine does not call Stripe.\n`,
      );
      return 1;
    }
    process.stderr.write(`ledgerly: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  const qboOut = argv.includes('--qbo');
  const xeroOut = argv.includes('--xero');
  let output: string;
  if (qboOut || xeroOut) {
    // Placeholder note goes to stderr so stdout stays pipeable JSON.
    process.stderr.write(
      `ledgerly: account ${qboOut ? 'IDs' : 'codes'} below are placeholders — ` +
        `map ledgerly's codes to your real ${qboOut ? 'QuickBooks' : 'Xero'} accounts ` +
        `(see the README).\n`,
    );
    if (result.schedule && result.schedule.entries.length > 0) {
      process.stderr.write(
        `ledgerly: ${String(result.schedule.entries.length)} recognition-schedule ` +
          `entries are not shown — render them with the library's ` +
          `${qboOut ? 'toQboSchedule' : 'toXeroSchedule'}.\n`,
      );
    }
    output = qboOut ? formatQbo(result) : formatXero(result);
  } else if (jsonOut) {
    output = JSON.stringify(result, null, 2);
  } else {
    output = formatMapResult(result);
  }
  process.stdout.write(output + '\n');
  return 0;
}

// Run main() only when this module is the process entry point (the bin), not
// when it is imported (e.g. by tests importing the pure functions above).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
