import { describe, it, expect } from 'vitest';
import { createStateSigner } from '../../../src/server/oauth/state.js';
import { OAuthError } from '../../../src/server/oauth/types.js';

const SECRET = 'a'.repeat(32);

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
});
