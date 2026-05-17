import type { XeroAccountMap } from '../../exporters/types.js';
import { toXero } from '../../exporters/xero.js';
import type { Dispatcher } from '../scheduler.js';
import type { SavedScheduledEntry } from '../storage/types.js';

export interface XeroDispatcherConfig {
  /** Xero OAuth2 access token (caller is responsible for refresh). */
  readonly accessToken: string;
  /** Xero tenant ID (the connected organization). */
  readonly tenantId: string;
  /** Maps ledgerly account codes to Xero account codes. */
  readonly accountMap: XeroAccountMap;
  /** API base URL. Default 'https://api.xero.com'. */
  readonly apiBase?: string;
  /** Status to post entries as. Default 'DRAFT' (safer — user reviews before posting). */
  readonly status?: 'DRAFT' | 'POSTED';
  /** Override fetch for testing. Defaults to globalThis.fetch. */
  readonly fetch?: typeof globalThis.fetch;
  /** Optional logger for successful posts. */
  readonly log?: { info: (msg: string, meta?: unknown) => void };
}

const DEFAULT_API_BASE = 'https://api.xero.com';
const MAX_BODY_PREVIEW_CHARS = 500;

/**
 * Dispatcher that posts scheduled entries to Xero's ManualJournals endpoint.
 *
 * Idempotency: every POST includes the `Idempotency-Key` header set to
 * `String(entry.id)`. Xero natively deduplicates on this header, so scheduler
 * retries after a partial failure are safe.
 *
 * OAuth is out of scope: the caller supplies a live `accessToken` and is
 * responsible for refreshing it before expiry (Xero access tokens expire in
 * 30 minutes).
 *
 * Xero has no separate sandbox base URL — the production base
 * (`https://api.xero.com`) is used for both real and demo company access (the
 * demo company is just a flag on the user's tenant). `apiBase` is configurable
 * anyway in case of future changes or a corporate proxy.
 */
export function xeroDispatcher(config: XeroDispatcherConfig): Dispatcher {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const status = config.status ?? 'DRAFT';
  const log = config.log;

  return async (entry: SavedScheduledEntry): Promise<void> => {
    const xeroJournal = toXero(entry.entry, config.accountMap, status);
    const url = `${apiBase}/api.xro/2.0/ManualJournals`;

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Xero-Tenant-Id': config.tenantId,
        'Idempotency-Key': String(entry.id),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ ManualJournals: [xeroJournal] }),
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
        `Xero API returned ${String(response.status)} for entry id=${String(entry.id)}: ${truncated}${retryNote}`,
      );
    }

    log?.info(
      `[xero-dispatcher] posted entry id=${String(entry.id)} memo=${entry.entry.memo}`,
      { xeroJournal },
    );
  };
}
