import type { OAuthClientConfig, TokenSet } from './types.js';
import { OAuthError } from './types.js';

/**
 * Xero OAuth 2.0 authorization-code flow helpers.
 *
 * - Authorize: redirect the user to {@link XERO_AUTHORIZE_URL} with the URL
 *   produced by {@link buildXeroAuthUrl}.
 * - Callback: Xero redirects back with `code` and `state` query parameters.
 *   Unlike Intuit, Xero does NOT include the tenant ID in the callback — the
 *   receiver must call {@link getXeroConnections} after the token exchange
 *   to discover it.
 * - Exchange: call {@link exchangeXeroCode} to swap the code for a {@link TokenSet}.
 * - Refresh: call {@link refreshXeroTokens}. Xero refresh tokens ROTATE on
 *   use — the previous refresh token is invalidated immediately. Callers
 *   must persist the returned refresh token.
 */

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_SCOPE = 'accounting.transactions accounting.settings offline_access';
const EXPIRY_SAFETY_MARGIN_SECONDS = 30;
const MAX_BODY_PREVIEW_CHARS = 500;

/**
 * Query parameters supplied by Xero on the callback redirect. Tenant identity
 * is NOT included — fetch it separately via {@link getXeroConnections}.
 */
export interface XeroCallbackParams {
  readonly code: string;
  readonly state: string;
}

/**
 * A single Xero connection (one user authorization can yield connections to
 * multiple tenants, e.g., an accountant with access to several client orgs).
 * The managed dispatcher MVP uses the first connection; multi-tenant
 * deployments need to iterate.
 */
export interface XeroConnection {
  /** Connection ID (unique per authorization-tenant pair). */
  readonly id: string;
  /** Xero tenant ID — the value used as `Xero-Tenant-Id` on API calls. */
  readonly tenantId: string;
  /** Tenant type, e.g., `'ORGANISATION'`, `'PRACTICEMANAGER'`. */
  readonly tenantType: string;
  /** Human-readable name of the tenant. */
  readonly tenantName: string;
}

interface XeroTokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
  readonly token_type?: unknown;
  readonly scope?: unknown;
}

interface XeroConnectionRow {
  readonly id?: unknown;
  readonly tenantId?: unknown;
  readonly tenantType?: unknown;
  readonly tenantName?: unknown;
}

/**
 * Build the URL the operator's browser must visit to start the Xero OAuth
 * consent flow. The `state` parameter is opaque to Xero and round-tripped
 * back to the callback.
 */
export function buildXeroAuthUrl(config: OAuthClientConfig, state: string): string {
  const url = new URL(XERO_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('scope', XERO_SCOPE);
  url.searchParams.set('state', state);
  return url.toString();
}

function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unavailable>';
  }
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

function parseTokenResponse(
  data: XeroTokenResponse,
  stage: 'token-exchange' | 'token-refresh',
): TokenSet {
  const accessToken = data.access_token;
  const refreshToken = data.refresh_token;
  const expiresIn = data.expires_in;
  const scope = data.scope;

  if (
    typeof accessToken !== 'string' ||
    typeof refreshToken !== 'string' ||
    typeof expiresIn !== 'number'
  ) {
    throw new OAuthError('xero', stage, 'Malformed token response');
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn - EXPIRY_SAFETY_MARGIN_SECONDS,
    scope: typeof scope === 'string' ? scope : XERO_SCOPE,
  };
}

/**
 * Exchange an authorization code for a {@link TokenSet}. Throws
 * {@link OAuthError} (stage `'token-exchange'`) on any non-2xx response.
 */
export async function exchangeXeroCode(
  config: OAuthClientConfig,
  code: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetchImpl(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await readBodyText(response);
    throw new OAuthError(
      'xero',
      'token-exchange',
      `Token exchange failed: HTTP ${String(response.status)}: ${truncate(text, MAX_BODY_PREVIEW_CHARS)}`,
    );
  }

  const data = (await response.json()) as XeroTokenResponse;
  return parseTokenResponse(data, 'token-exchange');
}

/**
 * Refresh a Xero access token using its refresh token. Xero refresh tokens
 * are single-use: the previous token is invalidated as soon as a new pair is
 * returned. Callers MUST persist the returned refresh token before issuing
 * any further API calls.
 */
export async function refreshXeroTokens(
  config: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetchImpl(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(config.clientId, config.clientSecret),
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await readBodyText(response);
    throw new OAuthError(
      'xero',
      'token-refresh',
      `Token refresh failed: HTTP ${String(response.status)}: ${truncate(text, MAX_BODY_PREVIEW_CHARS)}`,
    );
  }

  const data = (await response.json()) as XeroTokenResponse;
  return parseTokenResponse(data, 'token-refresh');
}

/**
 * Fetch the list of tenants this access token grants access to. Called once
 * after the initial code exchange to discover the tenant ID(s) to store
 * alongside the token set.
 *
 * For single-tenant MVP deployments, the receiver uses the first returned
 * connection and logs a warning if there are more than one.
 */
export async function getXeroConnections(
  accessToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<XeroConnection[]> {
  const response = await fetchImpl(XERO_CONNECTIONS_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    const text = await readBodyText(response);
    throw new OAuthError(
      'xero',
      'connections',
      `Connections lookup failed: HTTP ${String(response.status)}: ${truncate(text, MAX_BODY_PREVIEW_CHARS)}`,
    );
  }

  const data: unknown = await response.json();
  if (!Array.isArray(data)) {
    throw new OAuthError('xero', 'connections', 'Connections response was not an array');
  }

  return data.map((row): XeroConnection => {
    const r = row as XeroConnectionRow;
    if (
      typeof r.id !== 'string' ||
      typeof r.tenantId !== 'string' ||
      typeof r.tenantType !== 'string' ||
      typeof r.tenantName !== 'string'
    ) {
      throw new OAuthError('xero', 'connections', 'Malformed connection row');
    }
    return {
      id: r.id,
      tenantId: r.tenantId,
      tenantType: r.tenantType,
      tenantName: r.tenantName,
    };
  });
}
