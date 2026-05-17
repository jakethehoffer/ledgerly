import type { QboAccountMap } from '../../exporters/types.js';
import { toQbo } from '../../exporters/qbo.js';
import type { Dispatcher } from '../scheduler.js';
import type { SavedScheduledEntry } from '../storage/types.js';

export interface QboDispatcherConfig {
  /** QBO OAuth2 access token (caller is responsible for refresh). */
  readonly accessToken: string;
  /** QBO realm/company ID (their tenant identifier). */
  readonly realmId: string;
  /** Maps ledgerly account codes to QBO account IDs + display names. */
  readonly accountMap: QboAccountMap;
  /** API base URL. Default 'https://quickbooks.api.intuit.com'. Use sandbox for testing. */
  readonly apiBase?: string;
  /** Override fetch for testing. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Optional logger for successful posts. */
  readonly log?: { info: (msg: string, meta?: unknown) => void };
}

const DEFAULT_API_BASE = 'https://quickbooks.api.intuit.com';
const QBO_MINOR_VERSION = '70';
const MAX_BODY_PREVIEW_CHARS = 500;

/**
 * Dispatcher that posts scheduled entries to QuickBooks Online's JournalEntry endpoint.
 *
 * Idempotency: callers should provide a stable DocNumber via the existing toQbo
 * truncation (last 21 chars of event ID). QBO does NOT enforce DocNumber uniqueness
 * by default, so a redelivery would create a duplicate entry. For strict idempotency,
 * either use QBO's Idempotency-Key header (this dispatcher could add it as the entry's
 * sourceEventId) or implement deduplication via a query before POST. Future iteration.
 *
 * OAuth is out of scope: the caller supplies a live `accessToken` and is responsible
 * for refreshing it before expiry (QBO access tokens expire hourly).
 */
export function qboDispatcher(config: QboDispatcherConfig): Dispatcher {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const log = config.log;

  return async (entry: SavedScheduledEntry): Promise<void> => {
    const qboEntry = toQbo(entry.entry, config.accountMap);
    const url = `${apiBase}/v3/company/${encodeURIComponent(config.realmId)}/journalentry?minorversion=${QBO_MINOR_VERSION}`;

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(qboEntry),
    });

    if (!response.ok) {
      let bodyText: string;
      try {
        bodyText = await response.text();
      } catch {
        bodyText = '<unavailable>';
      }
      const truncated =
        bodyText.length > MAX_BODY_PREVIEW_CHARS
          ? bodyText.slice(0, MAX_BODY_PREVIEW_CHARS) + '...'
          : bodyText;
      const retryAfter = response.headers.get('Retry-After');
      const retryNote = retryAfter !== null ? ` (Retry-After: ${retryAfter})` : '';
      throw new Error(
        `QBO API returned ${String(response.status)} for entry id=${String(entry.id)}: ${truncated}${retryNote}`,
      );
    }

    log?.info(
      `[qbo-dispatcher] posted entry id=${String(entry.id)} memo=${entry.entry.memo}`,
      { qboEntry },
    );
  };
}
