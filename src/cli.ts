#!/usr/bin/env node
// `ledgerly` — map a single Stripe event (from stdin or a file) to its
// double-entry journal entry and print it. A zero-install way to see the engine
// work on your own event: `cat event.json | npx ledgerly`.
//
// This is the mapping CLI; the webhook receiver is the separate
// `ledgerly-server` bin. The engine never calls Stripe, so piped events must
// have nested objects (balance_transaction, invoice.charge, credit_note.invoice)
// expanded first. `--stripe` instead reads recent events with a read-only key,
// expands them the way the receiver does, and prints the entries.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type Stripe from 'stripe';
import { mapEvent } from './engine.js';
import { HANDLERS } from './events/index.js';
import {
  PREVIEW_MAX_DAYS,
  formatPreview,
  previewRecentEvents,
  type PreviewItem,
} from './preview.js';
import type { MapResult } from './journal.js';
import { formatMapResult } from './format.js';
import { ACCOUNTS } from './accounts.js';
import { MissingExpansionError, UnhandledEventError } from './errors.js';
import { toQbo } from './exporters/qbo.js';
import { toXero } from './exporters/xero.js';
import type { QboAccountMap, XeroAccountMap } from './exporters/types.js';

export { formatMapResult };

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

/**
 * Extract the event list from parsed CLI input, accepting the three shapes a
 * user is likely to pipe in: a single event object, a bare JSON array of events,
 * or a Stripe list response (`{ object: 'list', data: [...] }`, what
 * `stripe events list` prints).
 */
function extractEvents(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { data?: unknown }).data)
  ) {
    return (parsed as { data: unknown[] }).data;
  }
  return [parsed];
}

/**
 * Parse raw input and map every event it contains. Accepts a single event, a
 * JSON array of events, or a Stripe list response — see {@link extractEvents}.
 * Returns one {@link MapResult} per event, so a batch (e.g. a Stripe history
 * export) maps in a single call.
 */
export function mapEventsJson(input: string): MapResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new Error(
      `Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return extractEvents(parsed).map((event) => mapEvent(event as Stripe.Event));
}

/**
 * Map a batch the way a raw Stripe export needs: event types Ledgerly does not
 * map are skipped and counted instead of stopping the run. A lone event of an
 * unmapped type still throws, so a single mistaken input is reported clearly.
 */
export function mapEventsBatch(input: string): { results: MapResult[]; skipped: Record<string, number> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    throw new Error(
      `Input is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const events = extractEvents(parsed);
  if (events.length === 1) return { results: [mapEvent(events[0] as Stripe.Event)], skipped: {} };

  const results: MapResult[] = [];
  const skipped: Record<string, number> = {};
  for (const raw of events) {
    const event = raw as Stripe.Event;
    if (!HANDLERS[event.type]) {
      skipped[event.type] = (skipped[event.type] ?? 0) + 1;
      continue;
    }
    results.push(mapEvent(event));
  }
  return { results, skipped };
}

export interface CliArgs {
  help: boolean;
  json: boolean;
  qbo: boolean;
  xero: boolean;
  stripe: boolean;
  days: number;
  file: string | undefined;
  error?: string;
}

/** Parse the CLI flags. Problems come back in `error` rather than throwing. */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    help: argv.includes('-h') || argv.includes('--help'),
    json: argv.includes('--json'),
    qbo: argv.includes('--qbo'),
    xero: argv.includes('--xero'),
    stripe: argv.includes('--stripe'),
    days: PREVIEW_MAX_DAYS,
    file: undefined,
  };
  let daysText: string | undefined;
  let daysGiven = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--days') {
      daysGiven = true;
      const next = argv[i + 1];
      daysText = next !== undefined && !next.startsWith('-') ? next : '';
      if (daysText !== '') i++;
    } else if (arg.startsWith('--days=')) {
      daysGiven = true;
      daysText = arg.slice('--days='.length);
    } else if (!arg.startsWith('-') && args.file === undefined) {
      args.file = arg;
    }
  }
  if (daysGiven) {
    if (!args.stripe) return { ...args, error: '--days only works with --stripe' };
    const days = /^\d+$/.test(daysText ?? '') ? Number(daysText) : NaN;
    if (!Number.isInteger(days) || days < 1 || days > PREVIEW_MAX_DAYS) {
      return { ...args, error: `--days must be a whole number between 1 and ${String(PREVIEW_MAX_DAYS)}` };
    }
    args.days = days;
  }
  if (args.stripe && args.file !== undefined) {
    return { ...args, error: '--stripe reads from Stripe, so leave out the file argument' };
  }
  return args;
}

/**
 * Build a Stripe client for `--stripe` from STRIPE_SECRET_KEY. The `stripe`
 * package is an optional peer dependency, so it is loaded only here.
 */
export async function createPreviewClient(
  env: Readonly<Record<string, string | undefined>>,
  importStripe: () => Promise<{ default: unknown }> = () => import('stripe'),
): Promise<{ stripe?: Stripe; error?: string }> {
  const key = env['STRIPE_SECRET_KEY'];
  if (!key) {
    return {
      error:
        '--stripe needs a Stripe key in STRIPE_SECRET_KEY. Use a restricted key with Read access ' +
        'so the preview cannot change anything in your account.',
    };
  }
  let StripeClass: new (key: string) => Stripe;
  try {
    StripeClass = (await importStripe()).default as new (key: string) => Stripe;
  } catch {
    return {
      error:
        '--stripe needs the stripe package next to ledgerly. Run it as:\n' +
        '  npx -p ledgerly -p stripe@16 ledgerly --stripe',
    };
  }
  return { stripe: new StripeClass(key) };
}

const HELP = `ledgerly — map Stripe events to double-entry journal entries

Usage:
  cat event.json | ledgerly [--json|--qbo|--xero]
  ledgerly events.json
  STRIPE_SECRET_KEY=rk_... npx ledgerly --stripe [--days N]

Reads a Stripe event — or a JSON array of events, or a Stripe list response
(\`{ "data": [...] }\`, what \`stripe events list\` prints) — from stdin or a file
argument, and prints the balanced journal entries. Event types Ledgerly does not
map are skipped when a batch is piped in. Piped events must already have their
nested objects expanded (balance_transaction, invoice.charge, credit_note.invoice).

--stripe instead reads your account's recent events from Stripe, fetches the
nested objects each one needs, and prints the entries. It only reads. Nothing is
stored, and nothing is sent to QuickBooks or Xero. Use a restricted key with Read
access. Stripe keeps events for 30 days.

Options:
  --stripe    Preview your recent Stripe events (needs STRIPE_SECRET_KEY).
  --days N    With --stripe, how many days back to read (1 to 30, default 30).
  --json      Print the raw MapResult JSON instead of the readable table.
  --qbo       Print QuickBooks Online JournalEntry JSON (placeholder account IDs).
  --xero      Print Xero ManualJournal JSON (placeholder account codes).
  -h, --help  Show this help.
`;

function renderResults(results: MapResult[], args: CliArgs): string {
  if (args.qbo || args.xero) {
    // Placeholder note goes to stderr so stdout stays pipeable JSON.
    process.stderr.write(
      `ledgerly: account ${args.qbo ? 'IDs' : 'codes'} below are placeholders — ` +
        `map ledgerly's codes to your real ${args.qbo ? 'QuickBooks' : 'Xero'} accounts ` +
        `(see the README).\n`,
    );
    const scheduleEntries = results.reduce((n, r) => n + (r.schedule?.entries.length ?? 0), 0);
    if (scheduleEntries > 0) {
      process.stderr.write(
        `ledgerly: ${String(scheduleEntries)} recognition-schedule entries are not shown — ` +
          `render them with the library's ${args.qbo ? 'toQboSchedule' : 'toXeroSchedule'}.\n`,
      );
    }
    const allEntries = results.flatMap((r) => r.entries);
    return JSON.stringify(
      allEntries.map((entry) =>
        args.qbo ? toQbo(entry, PLACEHOLDER_QBO) : toXero(entry, PLACEHOLDER_XERO),
      ),
      null,
      2,
    );
  }
  if (args.json) {
    // A single event keeps its object shape; a batch becomes an array of results.
    return JSON.stringify(results.length === 1 ? results[0] : results, null, 2);
  }
  return results.map(formatMapResult).join(`\n\n${'='.repeat(60)}\n\n`);
}

async function runStripePreview(args: CliArgs): Promise<number> {
  const client = await createPreviewClient(process.env);
  if (!client.stripe) {
    process.stderr.write(`ledgerly: ${client.error ?? 'could not create a Stripe client'}\n`);
    return 1;
  }
  let items: PreviewItem[];
  try {
    items = await previewRecentEvents(client.stripe, { days: args.days });
  } catch (err) {
    process.stderr.write(
      `ledgerly: could not read events from Stripe: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
  const failed = items.filter((i) => !i.result);
  if (args.qbo || args.xero || args.json) {
    for (const item of failed) {
      process.stderr.write(`ledgerly: could not map ${item.event.id} (${item.event.type}): ${item.error ?? ''}\n`);
    }
    const results = items.flatMap((i) => (i.result ? [i.result] : []));
    process.stdout.write(renderResults(results, args) + '\n');
  } else {
    process.stdout.write(formatPreview(items, args.days) + '\n');
  }
  return failed.length > 0 ? 1 : 0;
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.error) {
    process.stderr.write(`ledgerly: ${args.error}\nRun ledgerly --help for usage.\n`);
    return 1;
  }
  if (args.stripe) return runStripePreview(args);

  let input: string;
  try {
    // fd 0 is stdin; readFileSync reads it to EOF for piped/redirected input.
    input = args.file ? readFileSync(args.file, 'utf8') : readFileSync(0, 'utf8');
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

  // Accepts a single event, a JSON array, or a Stripe list ({ data: [...] }), so
  // a whole export maps in one call.
  let results: MapResult[];
  try {
    const batch = mapEventsBatch(input);
    results = batch.results;
    const skipped = Object.entries(batch.skipped);
    if (skipped.length > 0) {
      const list = skipped.map(([type, n]) => `${type} (${String(n)})`).join(', ');
      process.stderr.write(`ledgerly: skipped event types Ledgerly does not map: ${list}\n`);
    }
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
          `credit_note.invoice) before piping the event, or use --stripe to read and ` +
          `expand your recent events straight from Stripe.\n`,
      );
      return 1;
    }
    process.stderr.write(`ledgerly: ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }

  process.stdout.write(renderResults(results, args) + '\n');
  return 0;
}

// Run main() only when this module is the process entry point (the bin), not
// when it is imported (e.g. by tests importing the pure functions above).
// exitCode rather than exit() lets piped output finish writing first.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
