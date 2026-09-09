import { describe, it, expect } from 'vitest';
import { createPendingStateStore } from '../../../src/server/oauth/pendingStates.js';
import type { StatePayload } from '../../../src/server/oauth/state.js';

function payload(nonce: string, secondsFromNow = 600): StatePayload {
  return {
    provider: 'qbo',
    nonce,
    expiresAt: Math.floor(Date.now() / 1000) + secondsFromNow,
  };
}

describe('createPendingStateStore', () => {
  it('accepts a nonce it issued', () => {
    const store = createPendingStateStore();
    store.issue(payload('n1'));
    expect(store.consume('n1')).toBe(true);
  });

  it('rejects a nonce it never issued', () => {
    const store = createPendingStateStore();
    expect(store.consume('never-seen')).toBe(false);
  });

  it('accepts a nonce only once', () => {
    const store = createPendingStateStore();
    store.issue(payload('n1'));
    expect(store.consume('n1')).toBe(true);
    expect(store.consume('n1')).toBe(false);
  });

  it('rejects an expired nonce and stops tracking it', () => {
    const store = createPendingStateStore();
    store.issue(payload('stale', -1));
    expect(store.consume('stale')).toBe(false);
    expect(store.size()).toBe(0);
  });

  it('keeps other nonces usable after one is claimed', () => {
    const store = createPendingStateStore();
    store.issue(payload('a'));
    store.issue(payload('b'));
    expect(store.consume('a')).toBe(true);
    expect(store.consume('b')).toBe(true);
  });

  it('drops expired nonces as new ones arrive, so the map stays bounded', () => {
    const store = createPendingStateStore();
    for (let i = 0; i < 50; i++) store.issue(payload(`old-${String(i)}`, -1));
    store.issue(payload('fresh'));
    expect(store.size()).toBe(1);
    expect(store.consume('fresh')).toBe(true);
  });
});
