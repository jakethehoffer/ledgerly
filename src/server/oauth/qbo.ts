import type { OAuthClientConfig, TokenSet } from './types.js';
import { OAuthError } from './types.js';

/**
 * QuickBooks Online (Intuit) OAuth 2.0 authorization-code flow helpers.
 *
 * - Authorize: redirect the user to {@link QBO_AUTHORIZE_URL} with the URL
 *   produced by {@link buildQboAuthUrl}.
 * - Callback: Intuit redirects back to the registered redirect URI with
 *   `code`, `state`, and `realmId` query parameters.
 * - Exchange: call {@link exchangeQboCode} to swap the code for a
 *   {@link TokenSet}.
 * - Refresh: call {@link refreshQboTokens} before each dispatch when the
 *   access token is within the safety margin of expiry.
 *
 * Pure functions — no I/O coupling beyond the `fetch` call, which is
 * injectable for testing.
 */

const QBO_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const QBO_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
const EXPIRY_SAFETY_MARGIN_SECONDS = 30;
const MAX_BODY_PREVIEW_CHARS = 500;

/**
 * Query parameters supplied by Intuit on the callback redirect. `realmId` is
 * the QBO tenant identifier (Intuit calls it the "Company ID") and is the
 * key the managed dispatcher uses when retrieving tokens.
 */
export interface QboCallbackParams {
  readonly code: string;
  readonly state: string;
  readonly realmId: string;
}

/**
 * Shape of the JSON response from Intuit's token endpoint. Documented at:
 * https://developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 */
interface QboTokenResponse {
  readonly access_token?: unknown;
  readonly refresh_token?: unknown;
  readonly expires_in?: unknown;
  readonly x_refresh_token_expires_in?: unknown;
  readonly token_type?: unknown;
  readonly scope?: unknown;
}

/**
 * Build the URL the operator's browser must visit to start the QBO OAuth
 * consent flow. The `state` parameter is opaque to Intuit and round-tripped
 * back to the callback; the receiver verifies it via {@link StateSigner}.
 */
export function buildQboAuthUrl(config: OAuthClientConfig, state: string): string {
  const url = new URL(QBO_AUTHORIZE_URL);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', QBO_SCOPE);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

/** Truncate a string for inclusion in an error message. */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

/** Read the body of a fetch Response as text, returning a placeholder on error. */
async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unavailable>';
  }
}

/** Build the Authorization header value for an OAuth client_id / client_secret pair. */
function basicAuthHeader(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

/**
 * Parse a successful token response into a {@link TokenSet}. The provider's
 * `expires_in` is converted to an absolute `expiresAt` epoch-seconds value;
 * we subtract a small safety margin so consumers see expiry slightly early
 * (catches clock skew + in-flight requests that arrive at the API right as
 * the token rolls over).
 */
function parseTokenResponse(
  data: QboTokenResponse,
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
    throw new OAuthError('qbo', stage, 'Malformed token response');
  }

  return {
    accessToken,
    refreshToken,
    // Math.floor(Date.now()/1000) is the standard epoch-seconds idiom.
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn - EXPIRY_SAFETY_MARGIN_SECONDS,
    scope: typeof scope === 'string' ? scope : QBO_SCOPE,
  };
}

/**
 * Exchange an authorization code for a {@link TokenSet}. Throws
 * {@link OAuthError} (stage `'token-exchange'`) on any non-2xx response.
 */
export async function exchangeQboCode(
  config: OAuthClientConfig,
  code: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
  });

  const response = await fetchImpl(QBO_TOKEN_URL, {
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
      'qbo',
      'token-exchange',
      `Token exchange failed: HTTP ${String(response.status)}: ${truncate(text, MAX_BODY_PREVIEW_CHARS)}`,
    );
  }

  const data = (await response.json()) as QboTokenResponse;
  return parseTokenResponse(data, 'token-exchange');
}

/**
 * Refresh a QBO access token using its refresh token. The QBO refresh token
 * is stable but rotates every ~24 hours — callers must persist the returned
 * `refreshToken`, not reuse the original.
 */
export async function refreshQboTokens(
  config: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  const response = await fetchImpl(QBO_TOKEN_URL, {
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
      'qbo',
      'token-refresh',
      `Token refresh failed: HTTP ${String(response.status)}: ${truncate(text, MAX_BODY_PREVIEW_CHARS)}`,
    );
  }

  const data = (await response.json()) as QboTokenResponse;
  return parseTokenResponse(data, 'token-refresh');
}
