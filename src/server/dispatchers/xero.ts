import type { XeroAccountMap } from '../../exporters/types.js';
import { toXero } from '../../exporters/xero.js';
import { consoleLogger } from '../logger.js';
import type { Logger } from '../logger.js';
import type { Dispatcher } from '../scheduler.js';
import type { SavedScheduledEntry } from '../storage/types.js';
import { dispatchIdentity } from './identity.js';

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
  /** Optional logger for successful posts. Defaults to {@link consoleLogger}. */
  readonly log?: Logger;
}

const DEFAULT_API_BASE = 'https://api.xero.com';
const MAX_BODY_PREVIEW_CHARS = 500;

/**
 * Dispatcher that posts scheduled entries to Xero's ManualJournals endpoint.
 *
 * Idempotency: source-based keys protect short retries. Xero expires those keys
 * after six minutes, so also look for a durable narration marker before sending.
 * The scheduler must retain its documented single-writer deployment model.
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
  const log: Logger = config.log ?? consoleLogger();

  return async (entry: SavedScheduledEntry): Promise<void> => {
    const xeroJournal = toXero(entry.entry, config.accountMap, status);
    const url = `${apiBase}/api.xro/2.0/ManualJournals`;
    const identity = dispatchIdentity(entry);
    const marker = `[Ledgerly:${identity}]`;
    const narration = `${xeroJournal.Narration} ${marker}`;
    const lookup = await fetchImpl(`${url}?where=${encodeURIComponent(`Narration==${JSON.stringify(narration)}`)}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Xero-Tenant-Id': config.tenantId,
        Accept: 'application/json',
      },
    });
    if (!lookup.ok) throw new Error(`Xero API returned ${String(lookup.status)} during duplicate check`);
    const existing = await lookup.json() as { ManualJournals?: { Narration?: string; ManualJournalID?: string }[] };
    if (!Array.isArray(existing.ManualJournals)) throw new Error('Xero duplicate check returned an invalid response');
    if (existing.ManualJournals.some((journal) => journal.Narration === narration && journal.ManualJournalID)) return;

    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        'Xero-Tenant-Id': config.tenantId,
        'Idempotency-Key': identity,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ ManualJournals: [{ ...xeroJournal, Narration: narration }] }),
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

    const posted = await response.json() as {
      ManualJournals?: { ManualJournalID?: string; HasErrors?: boolean }[];
    };
    const journal = posted.ManualJournals?.[0];
    if (!journal?.ManualJournalID || journal.HasErrors) {
      throw new Error('Xero did not confirm a saved manual journal');
    }

    log.info(
      `[xero-dispatcher] posted entry id=${String(entry.id)} memo=${entry.entry.memo}`,
      { xeroJournal },
    );
  };
}
