import crypto from 'node:crypto';
import type { OAuthProvider } from './types.js';
import { OAuthError } from './types.js';

/**
 * Decoded `state` payload exchanged with the OAuth provider. The `provider`
 * field lets the callback handler reject states minted for the wrong provider
 * (cross-flow confusion); `nonce` is opaque entropy; `expiresAt` enforces a
 * TTL so a leaked state token can't be reused indefinitely.
 *
 * Times are epoch *seconds* — consistent with `TokenSet.expiresAt` and OAuth
 * provider conventions. The signer accepts a `ttlSeconds` parameter; the
 * verifier compares `expiresAt > nowSeconds()`.
 */
export interface StatePayload {
  readonly provider: OAuthProvider;
  readonly nonce: string;
  readonly expiresAt: number;
}

/**
 * Signer / verifier for the OAuth `state` parameter. The format is a dotted
 * pair `<body>.<signature>` where both halves are base64url-encoded; the
 * signature is HMAC-SHA256 over `<body>` with the configured secret.
 */
export interface StateSigner {
  /**
   * Sign a state payload. Only the `provider` is supplied by the caller — the
   * signer generates a fresh nonce and computes `expiresAt`.
   *
   * @param payload `{ provider }`
   * @param ttlSeconds time-to-live in seconds. Defaults to 600 (10 minutes).
   *                    The state parameter only needs to survive the round-trip
   *                    to the provider and back, so a tight TTL is fine.
   */
  sign(payload: { readonly provider: OAuthProvider }, ttlSeconds?: number): string;

  /**
   * Verify and decode a state token. Throws an {@link OAuthError} (stage =
   * `'state'`) if the format is malformed, the signature does not match, or
   * the token has expired. Otherwise returns the decoded payload.
   */
  verify(stateToken: string): StatePayload;
}

const DEFAULT_TTL_SECONDS = 600;

/** Encode a Buffer as base64url (URL-safe, no padding). */
function base64urlEncode(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64url-encoded string back to a Buffer. */
function base64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + padding, 'base64');
}

/** Epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a {@link StateSigner} that uses HMAC-SHA256 with the configured secret.
 *
 * The secret must be at least 32 characters — short secrets weaken the signature
 * against offline cracking even with HMAC's per-message strength. Production
 * deployments should generate it with `openssl rand -base64 48`.
 *
 * The state parameter is treated as the OAuth CSRF mitigation: an attacker
 * who intercepts a user's authorization redirect cannot forge a callback
 * (they don't know the secret), and a leaked state can't be reused past its
 * TTL. The `provider` field also defends against cross-flow confusion (e.g.,
 * trying to use a QBO state on the Xero callback endpoint).
 */
export function createStateSigner(secret: string): StateSigner {
  if (secret.length < 32) {
    throw new Error('OAuth state secret must be at least 32 characters');
  }

  function computeSig(body: string): Buffer {
    return crypto.createHmac('sha256', secret).update(body).digest();
  }

  return {
    sign(payload, ttlSeconds = DEFAULT_TTL_SECONDS): string {
      const expiresAt = nowSeconds() + ttlSeconds;
      const nonce = crypto.randomBytes(16).toString('hex');
      const full: StatePayload = {
        provider: payload.provider,
        nonce,
        expiresAt,
      };
      const body = base64urlEncode(Buffer.from(JSON.stringify(full), 'utf8'));
      const sig = base64urlEncode(computeSig(body));
      return `${body}.${sig}`;
    },

    verify(stateToken: string): StatePayload {
      const dotIdx = stateToken.indexOf('.');
      if (dotIdx === -1 || dotIdx === 0 || dotIdx === stateToken.length - 1) {
        throw new OAuthError('qbo', 'state', 'Malformed state token');
      }
      const body = stateToken.slice(0, dotIdx);
      const sig = stateToken.slice(dotIdx + 1);

      const expected = computeSig(body);
      let provided: Buffer;
      try {
        provided = base64urlDecode(sig);
      } catch {
        throw new OAuthError('qbo', 'state', 'Invalid state signature encoding');
      }
      // timingSafeEqual throws if the buffers differ in length; guard up front
      // so the error message stays specific and we still get constant-time
      // comparison for the same-length common case (signatures from this
      // module are always 32 bytes).
      if (provided.length !== expected.length) {
        throw new OAuthError('qbo', 'state', 'State signature mismatch');
      }
      if (!crypto.timingSafeEqual(provided, expected)) {
        throw new OAuthError('qbo', 'state', 'State signature mismatch');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(base64urlDecode(body).toString('utf8'));
      } catch {
        throw new OAuthError('qbo', 'state', 'Malformed state body');
      }
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('provider' in parsed) ||
        !('nonce' in parsed) ||
        !('expiresAt' in parsed)
      ) {
        throw new OAuthError('qbo', 'state', 'Malformed state payload');
      }
      const record = parsed as Record<string, unknown>;
      const provider = record['provider'];
      const nonce = record['nonce'];
      const expiresAt = record['expiresAt'];
      if (
        (provider !== 'qbo' && provider !== 'xero') ||
        typeof nonce !== 'string' ||
        typeof expiresAt !== 'number'
      ) {
        throw new OAuthError('qbo', 'state', 'Malformed state payload');
      }
      if (expiresAt <= nowSeconds()) {
        throw new OAuthError(provider, 'state', 'State token expired');
      }
      return { provider, nonce, expiresAt };
    },
  };
}
