import type { Dispatcher } from '../scheduler.js';
import type { SavedScheduledEntry } from '../storage/types.js';

export interface ConsoleDispatcherLogger {
  info: (msg: string, meta?: unknown) => void;
}

/**
 * Default dispatcher: writes a single info-level log line per scheduled entry.
 *
 * Useful for local development, smoke testing, and any deployment where the
 * scheduled entry is being post-processed by a downstream log-shipping pipeline
 * rather than a direct API call.
 *
 * Production deployments will typically replace this with a QBO/Xero API
 * pusher — see the `Dispatcher` type in `../scheduler.ts` for the contract.
 */
export function consoleDispatcher(
  log: ConsoleDispatcherLogger = {
    info: (msg, meta): void => {
      // eslint-disable-next-line no-console
      console.log(msg, meta ?? '');
    },
  },
): Dispatcher {
  return (entry: SavedScheduledEntry): void => {
    log.info(
      `[scheduled-entry] id=${String(entry.id)} subscription=${entry.subscriptionId} date=${entry.entry.date} memo=${entry.entry.memo}`,
      { entry: entry.entry },
    );
  };
}
