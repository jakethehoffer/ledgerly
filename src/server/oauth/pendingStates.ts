import type { StatePayload } from './state.js';

/**
 * Registry of OAuth `state` nonces this receiver actually issued.
 *
 * The state signer is stateless: it proves a token was minted with our secret,
 * but not that *this* process minted it for *this* connect attempt. That is
 * enough to stop forgery and enough to expire a token, but not enough on its
 * own for two cases that matter:
 *
 *   - **Replay.** An authorize URL carries its state in the query string, so it
 *     lands in browser history and in the provider's own logs. Without a
 *     single-use rule, anyone who obtains that URL inside the TTL can complete
 *     consent again with a *different* company and add a second token row.
 *   - **Provenance.** Only an authenticated `/oauth/<provider>/start` should be
 *     able to begin a connect. Requiring the callback's nonce to be one we
 *     issued binds the callback to that authenticated start.
 *
 * `consume` therefore returns `true` at most once per nonce. State is in-memory
 * and per-process: a restart invalidates connect attempts that are still in
 * flight, which costs an operator one retry and is the safe direction to fail.
 * Entries are dropped once their own expiry passes, so the map stays bounded by
 * the number of connect attempts inside one TTL window.
 */
export interface PendingStateStore {
  /** Record a state token this receiver just minted. */
  issue(payload: StatePayload): void;
  /**
   * Claim a nonce. Returns `true` only for a nonce that was issued, has not
   * been claimed before, and has not expired.
   */
  consume(nonce: string): boolean;
  /** Number of unclaimed, unexpired nonces. Exposed for tests and diagnostics. */
  size(): number;
}

/** Epoch seconds, matching {@link StatePayload.expiresAt}. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function createPendingStateStore(): PendingStateStore {
  const issued = new Map<string, number>();

  function gc(now: number): void {
    for (const [nonce, expiresAt] of issued) {
      if (expiresAt <= now) issued.delete(nonce);
    }
  }

  return {
    issue(payload: StatePayload): void {
      const now = nowSeconds();
      gc(now);
      issued.set(payload.nonce, payload.expiresAt);
    },

    consume(nonce: string): boolean {
      const now = nowSeconds();
      gc(now);
      const expiresAt = issued.get(nonce);
      if (expiresAt === undefined) return false;
      issued.delete(nonce);
      return expiresAt > now;
    },

    size(): number {
      gc(nowSeconds());
      return issued.size;
    },
  };
}
