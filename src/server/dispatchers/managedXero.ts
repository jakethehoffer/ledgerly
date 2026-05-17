import type { XeroAccountMap } from '../../exporters/types.js';
import { consoleLogger } from '../logger.js';
import type { Logger } from '../logger.js';
import type { OAuthClientConfig, ConnectedTokens } from '../oauth/types.js';
import { refreshXeroTokens } from '../oauth/xero.js';
import type { Dispatcher } from '../scheduler.js';
import type { SavedScheduledEntry, Storage } from '../storage/types.js';
import { xeroDispatcher } from './xero.js';

/**
 * Configuration for {@link managedXeroDispatcher}. Mirrors
 * `ManagedQboDispatcherConfig` — see that file for the design rationale.
 */
export interface ManagedXeroDispatcherConfig {
  readonly oauthClient: OAuthClientConfig;
  readonly storage: Storage;
  readonly accountMap: XeroAccountMap;
  readonly apiBase?: string;
  readonly status?: 'DRAFT' | 'POSTED';
  readonly fetch?: typeof globalThis.fetch;
  readonly log?: Logger;
  /**
   * Seconds before access_token expiry to proactively refresh. Defaults to
   * 60.
   */
  readonly refreshSafetyMarginSeconds?: number;
}

const DEFAULT_SAFETY_MARGIN_SECONDS = 60;

/**
 * Xero dispatcher that manages its own access token lifecycle. See
 * {@link managedQboDispatcher} for the contract. The key difference for Xero
 * is that the refresh token is single-use — every successful refresh
 * invalidates the previous refresh token, so the wrapper MUST persist the
 * new pair before issuing any further API calls.
 */
export function managedXeroDispatcher(config: ManagedXeroDispatcherConfig): Dispatcher {
  const log: Logger = config.log ?? consoleLogger();
  const safetyMargin = config.refreshSafetyMarginSeconds ?? DEFAULT_SAFETY_MARGIN_SECONDS;
  const fetchImpl = config.fetch ?? globalThis.fetch;

  function loadTokens(): ConnectedTokens {
    const tokens = config.storage.oauth.get('xero');
    if (!tokens) {
      throw new Error(
        'managedXeroDispatcher: no Xero tokens in storage — complete the /oauth/xero/start flow first',
      );
    }
    return tokens;
  }

  async function ensureFresh(tokens: ConnectedTokens): Promise<ConnectedTokens> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (tokens.expiresAt > nowSeconds + safetyMargin) {
      return tokens;
    }
    log.info('[managed-xero] refreshing access token', {
      tenantId: tokens.tenantId,
      expiresAt: tokens.expiresAt,
    });
    const fresh = await refreshXeroTokens(config.oauthClient, tokens.refreshToken, fetchImpl);
    const next: ConnectedTokens = {
      provider: 'xero',
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
    const inner = xeroDispatcher({
      accessToken: tokens.accessToken,
      tenantId: tokens.tenantId,
      accountMap: config.accountMap,
      log,
      ...(config.apiBase !== undefined ? { apiBase: config.apiBase } : {}),
      ...(config.status !== undefined ? { status: config.status } : {}),
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
      if (!msg.includes('401')) {
        throw err;
      }
      log.warn('[managed-xero] received 401; refreshing and retrying once', { err: msg });
      const fresh = await refreshXeroTokens(
        config.oauthClient,
        tokens.refreshToken,
        fetchImpl,
      );
      const next: ConnectedTokens = {
        provider: 'xero',
        tenantId: tokens.tenantId,
        ...fresh,
      };
      config.storage.oauth.save(next);
      await dispatchOnce(entry, next);
    }
  };
}
