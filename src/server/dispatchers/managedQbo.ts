import type { QboAccountMap } from '../../exporters/types.js';
import { consoleLogger } from '../logger.js';
import type { Logger } from '../logger.js';
import { refreshQboTokens } from '../oauth/qbo.js';
import type { ConnectedTokens, OAuthClientConfig } from '../oauth/types.js';
import type { Dispatcher } from '../scheduler.js';
import type { SavedScheduledEntry, Storage } from '../storage/types.js';
import { qboDispatcher } from './qbo.js';

/**
 * Configuration for {@link managedQboDispatcher}. The OAuth client + storage
 * give the wrapper everything it needs to fetch and persist tokens; the
 * account map and the optional API base / fetch are forwarded verbatim to
 * the underlying {@link qboDispatcher}.
 */
export interface ManagedQboDispatcherConfig {
  readonly oauthClient: OAuthClientConfig;
  readonly storage: Storage;
  readonly accountMap: QboAccountMap;
  readonly apiBase?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: Logger;
  /**
   * Seconds before access_token expiry to proactively refresh. Defaults to
   * 60 — refreshing one minute early gives a comfortable buffer for slow
   * dispatch + clock skew between the receiver and Intuit.
   */
  readonly refreshSafetyMarginSeconds?: number;
}

const DEFAULT_SAFETY_MARGIN_SECONDS = 60;

/**
 * QBO dispatcher that manages its own access token lifecycle. On every
 * dispatch it:
 *
 *   1. Loads the latest stored token set for QBO (throws if none — operator
 *      must complete the consent flow first).
 *   2. If the token expires within the safety margin, refreshes it via
 *      {@link refreshQboTokens} and persists the new pair.
 *   3. Delegates the actual POST to {@link qboDispatcher}.
 *   4. If the delegated call throws with `401` in the error message,
 *      refreshes once and retries. Non-401 errors propagate so the scheduler
 *      can apply its backoff.
 *
 * The wrapper is intentionally narrow: it knows about OAuth bookkeeping
 * but nothing about journal entry shape. The underlying static-token
 * dispatcher stays unchanged.
 */
export function managedQboDispatcher(config: ManagedQboDispatcherConfig): Dispatcher {
  const log: Logger = config.log ?? consoleLogger();
  const safetyMargin = config.refreshSafetyMarginSeconds ?? DEFAULT_SAFETY_MARGIN_SECONDS;
  const fetchImpl = config.fetch ?? globalThis.fetch;

  function loadTokens(): ConnectedTokens {
    const tokens = config.storage.oauth.get('qbo');
    if (!tokens) {
      throw new Error(
        'managedQboDispatcher: no QBO tokens in storage — complete the /oauth/qbo/start flow first',
      );
    }
    return tokens;
  }

  async function ensureFresh(tokens: ConnectedTokens): Promise<ConnectedTokens> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (tokens.expiresAt > nowSeconds + safetyMargin) {
      return tokens;
    }
    log.info('[managed-qbo] refreshing access token', {
      tenantId: tokens.tenantId,
      expiresAt: tokens.expiresAt,
    });
    const fresh = await refreshQboTokens(config.oauthClient, tokens.refreshToken, fetchImpl);
    const next: ConnectedTokens = {
      provider: 'qbo',
      tenantId: tokens.tenantId,
      ...fresh,
    };
    config.storage.oauth.save(next);
    return next;
  }

  async function dispatchOnce(
    entry: SavedScheduledEntry,
    tokens: ConnectedTokens,
  ): Promise<void> {
    const inner = qboDispatcher({
      accessToken: tokens.accessToken,
      realmId: tokens.tenantId,
      accountMap: config.accountMap,
      log,
      ...(config.apiBase !== undefined ? { apiBase: config.apiBase } : {}),
      ...(config.fetch !== undefined ? { fetch: config.fetch } : {}),
    });
    await inner(entry);
  }

  return async (entry: SavedScheduledEntry): Promise<void> => {
    let tokens = loadTokens();
    tokens = await ensureFresh(tokens);

    try {
      await dispatchOnce(entry, tokens);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Defensive 401 retry: if QBO rejected the access token (despite
      // expires_at still being valid — possible if Intuit revoked it
      // server-side, or our clock skew was large), refresh once and try
      // again. Anything else propagates to the scheduler's backoff logic.
      if (!msg.includes('401')) {
        throw err;
      }
      log.warn('[managed-qbo] received 401; refreshing and retrying once', { err: msg });
      const fresh = await refreshQboTokens(
        config.oauthClient,
        tokens.refreshToken,
        fetchImpl,
      );
      const next: ConnectedTokens = {
        provider: 'qbo',
        tenantId: tokens.tenantId,
        ...fresh,
      };
      config.storage.oauth.save(next);
      await dispatchOnce(entry, next);
    }
  };
}
