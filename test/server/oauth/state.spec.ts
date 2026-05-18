import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { createStateSigner } from '../../../src/server/oauth/state.js';
import { OAuthError } from '../../../src/server/oauth/types.js';

const SECRET = 'a'.repeat(32);

/**
 * Mint a state token whose signature is VALID under `secret` but whose body
 * decodes to whatever raw content the caller wants. Used by the
 * payload-validation tests below to bypass the HMAC check and exercise the
 * downstream JSON / type / key validators — the attack model is "operator's
 * state secret leaked, attacker can sign tokens, what happens if they ship a
 * malformed payload?"
 */
function signWithValidHmac(bodyContent: string, secret: string): string {
  const base64url = (buf: Buffer): string =>
    buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = base64url(Buffer.from(bodyContent, 'utf8'));
  const sig = base64url(crypto.createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

describe('createStateSigner', () => {
  it('rejects secrets shorter than 32 chars', () => {
    expect(() => createStateSigner('short')).toThrow(/at least 32 characters/);
    expect(() => createStateSigner('a'.repeat(31))).toThrow(/at least 32 characters/);
  });

  it('accepts a secret of exactly 32 chars', () => {
    expect(() => createStateSigner('a'.repeat(32))).not.toThrow();
  });

  it('sign + verify round-trip', () => {
    const signer = createStateSigner(SECRET);
    const token = signer.sign({ provider: 'qbo' });
    const payload = signer.verify(token);
    expect(payload.provider).toBe('qbo');
    expect(typeof payload.nonce).toBe('string');
    expect(payload.nonce.length).toBeGreaterThan(0);
    expect(payload.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('sign() produces a different nonce on each call (random)', () => {
    const signer = createStateSigner(SECRET);
    const a = signer.sign({ provider: 'qbo' });
    const b = signer.sign({ provider: 'qbo' });
    expect(a).not.toBe(b);
  });

  it('verify() rejects a token whose body has been tampered with', () => {
    const signer = createStateSigner(SECRET);
    const token = signer.sign({ provider: 'qbo' });
    const [body, sig] = token.split('.');
    // Flip one character in the body — signature should no longer match.
    const tamperedBody = (body ?? '').slice(0, -1) + (body?.endsWith('A') ? 'B' : 'A');
    expect(() => signer.verify(`${tamperedBody}.${String(sig)}`)).toThrow(OAuthError);
    expect(() => signer.verify(`${tamperedBody}.${String(sig)}`)).toThrow(/signature/i);
  });

  it('verify() rejects a token signed with a different secret', () => {
    const a = createStateSigner('a'.repeat(32));
    const b = createStateSigner('b'.repeat(32));
    const token = a.sign({ provider: 'qbo' });
    expect(() => b.verify(token)).toThrow(OAuthError);
  });

  it('verify() rejects a malformed token (no dot)', () => {
    const signer = createStateSigner(SECRET);
    expect(() => signer.verify('no-dot-here')).toThrow(/[Mm]alformed/);
  });

  it('verify() rejects a malformed token (empty body or sig)', () => {
    const signer = createStateSigner(SECRET);
    expect(() => signer.verify('.sig')).toThrow(/[Mm]alformed/);
    expect(() => signer.verify('body.')).toThrow(/[Mm]alformed/);
  });

  it('verify() rejects an expired token', () => {
    const signer = createStateSigner(SECRET);
    // ttl = 1 second; mint, wait, verify. Use a tiny TTL to avoid sleeping
    // in tests — sign with -1s effective TTL by passing a negative number,
    // since the implementation just computes expiresAt = now + ttl.
    const token = signer.sign({ provider: 'qbo' }, -10);
    expect(() => signer.verify(token)).toThrow(/expired/i);
  });

  it('different secrets produce different signatures for the same payload', () => {
    const a = createStateSigner('a'.repeat(40));
    const b = createStateSigner('b'.repeat(40));
    // We can't compare a.sign() and b.sign() directly because nonce + time
    // vary. But we can confirm cross-verify fails (= different signatures).
    const tokenA = a.sign({ provider: 'qbo' });
    expect(() => b.verify(tokenA)).toThrow();
  });

  it('verify() decodes a Xero state', () => {
    const signer = createStateSigner(SECRET);
    const token = signer.sign({ provider: 'xero' });
    expect(signer.verify(token).provider).toBe('xero');
  });

  // Payload-validation paths: these tests assume the attacker has somehow
  // obtained the state secret (operator backup leak, env-var exposure, etc.)
  // and can mint signatures. With a valid HMAC the token survives the
  // signature check; we want to make sure malformed PAYLOADS still get
  // rejected loudly rather than silently produce a usable session.
  describe('payload validation (valid signature, bad payload)', () => {
    it('rejects a body that is not valid JSON', () => {
      const signer = createStateSigner(SECRET);
      const token = signWithValidHmac('not-json-here', SECRET);
      expect(() => signer.verify(token)).toThrow(OAuthError);
      expect(() => signer.verify(token)).toThrow(/[Mm]alformed state body/);
    });

    it('rejects a payload that decodes to null', () => {
      // `typeof null === 'object'` short-circuits the first check; the
      // `parsed === null` clause must catch this.
      const signer = createStateSigner(SECRET);
      const token = signWithValidHmac('null', SECRET);
      expect(() => signer.verify(token)).toThrow(/[Mm]alformed state payload/);
    });

    it('rejects a payload that decodes to a primitive (boolean)', () => {
      const signer = createStateSigner(SECRET);
      const token = signWithValidHmac('true', SECRET);
      expect(() => signer.verify(token)).toThrow(/[Mm]alformed state payload/);
    });

    it('rejects a payload missing the required keys', () => {
      const signer = createStateSigner(SECRET);
      const token = signWithValidHmac(JSON.stringify({ provider: 'qbo' }), SECRET);
      expect(() => signer.verify(token)).toThrow(/[Mm]alformed state payload/);
    });

    it('rejects an unrecognized provider value', () => {
      // Defends against cross-flow confusion: even with a valid signature,
      // a state minted for "evil" can't impersonate qbo or xero.
      const signer = createStateSigner(SECRET);
      const payload = { provider: 'evil', nonce: 'abc', expiresAt: 9_999_999_999 };
      const token = signWithValidHmac(JSON.stringify(payload), SECRET);
      expect(() => signer.verify(token)).toThrow(/[Mm]alformed state payload/);
    });

    it('rejects a non-string nonce', () => {
      const signer = createStateSigner(SECRET);
      const payload = { provider: 'qbo', nonce: 123, expiresAt: 9_999_999_999 };
      const token = signWithValidHmac(JSON.stringify(payload), SECRET);
      expect(() => signer.verify(token)).toThrow(/[Mm]alformed state payload/);
    });

    it('rejects a non-numeric expiresAt (the TTL bypass attempt)', () => {
      // The most attack-relevant of the bunch: if expiresAt isn't a number,
      // the `expiresAt <= nowSeconds()` comparison below would coerce
      // unpredictably. Reject at the type check instead.
      const signer = createStateSigner(SECRET);
      const payload = { provider: 'qbo', nonce: 'abc', expiresAt: 'tomorrow' };
      const token = signWithValidHmac(JSON.stringify(payload), SECRET);
      expect(() => signer.verify(token)).toThrow(/[Mm]alformed state payload/);
    });

    it('rejects a signature of wrong length before reaching timingSafeEqual', () => {
      // `crypto.timingSafeEqual` throws synchronously on length mismatch,
      // which would leak as an unhandled exception rather than a clean
      // OAuthError. The explicit length guard exists to short-circuit
      // before that point. Hit it directly with a sig that decodes to
      // fewer than 32 bytes (HMAC-SHA256 always emits 32).
      const signer = createStateSigner(SECRET);
      const base64url = (buf: Buffer): string =>
        buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const shortSig = base64url(crypto.randomBytes(16)); // 16 bytes vs expected 32
      expect(() => signer.verify(`anybody.${shortSig}`)).toThrow(OAuthError);
      expect(() => signer.verify(`anybody.${shortSig}`)).toThrow(/signature mismatch/);
    });
  });
});
