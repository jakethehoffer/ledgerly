/**
 * Public types for the OAuth 2.0 authorization-code flows used by the QBO and
 * Xero managed dispatchers. The shapes here are deliberately small and
 * provider-agnostic — provider-specific functions (`buildQboAuthUrl`,
 * `exchangeXeroCode`, etc.) live in `./qbo.ts` and `./xero.ts` and only ever
 * exchange these types with the storage layer and the dispatchers.
 */

/** Identifier for the OAuth provider this token set or callback belongs to. */
export type OAuthProvider = 'qbo' | 'xero';

/**
 * A bearer access token plus its refresh token and expiry. Used internally by
 * the OAuth helpers and the managed dispatchers; tenant identity lives in
 * {@link ConnectedTokens}.
 */
export interface TokenSet {
  /** Bearer access token. */
  readonly accessToken: string;
  /**
   * Refresh token. Xero rotates this on every refresh (the previous value is
   * immediately invalidated); QBO returns a stable value that occasionally
   * rotates (~24h cadence). Either way, always persist the value returned by
   * the most recent refresh.
   */
  readonly refreshToken: string;
  /** Epoch seconds when `accessToken` expires. */
  readonly expiresAt: number;
  /** Granted scope string from the token response. */
  readonly scope: string;
}

/**
 * A {@link TokenSet} paired with the provider it was minted by and the tenant
 * it grants access to. This is the shape persisted by the {@link OAuthTokenStore}.
 *
 * `tenantId`:
 * - QBO: the `realmId` returned as a query parameter on the `/oauth/qbo/callback` redirect.
 * - Xero: the `tenantId` returned from `GET https://api.xero.com/connections` after
 *   the code exchange (a single Xero authorization can yield multiple tenants —
 *   MVP picks the first; multi-tenant deployments need to iterate the list).
 */
export interface ConnectedTokens extends TokenSet {
  readonly provider: OAuthProvider;
  readonly tenantId: string;
}

/**
 * Application-side OAuth client credentials. Populated from environment
 * variables in the CLI; passed by reference to the helpers and managed
 * dispatchers.
 */
export interface OAuthClientConfig {
  /** Application's OAuth client_id from the provider's developer console. */
  readonly clientId: string;
  /** Application's OAuth client_secret. */
  readonly clientSecret: string;
  /**
   * Where the provider should redirect after consent. Must match the URI
   * registered in the provider's developer console exactly (down to scheme,
   * host, port, and path).
   */
  readonly redirectUri: string;
}

/**
 * Error type raised by the OAuth helpers. Carries the provider and stage of
 * the flow so the receiver can produce useful error messages and metrics
 * without parsing the message string.
 */
export class OAuthError extends Error {
  readonly provider: OAuthProvider;
  readonly stage: 'state' | 'token-exchange' | 'token-refresh' | 'connections';
  constructor(
    provider: OAuthProvider,
    stage: 'state' | 'token-exchange' | 'token-refresh' | 'connections',
    message: string,
  ) {
    super(`[${provider}:${stage}] ${message}`);
    this.name = 'OAuthError';
    this.provider = provider;
    this.stage = stage;
  }
}
