/**
 * Simple in-memory event deduplicator. Production deployments should replace
 * this with a Redis or DB-backed store. The TTL prevents unbounded memory
 * growth — Stripe redelivers for up to 3 days, so a 7-day TTL is safe.
 */
export interface Deduplicator {
  /** Returns true if the event has been seen; otherwise records and returns false. */
  checkAndRecord(eventId: string, now?: number): boolean;
  size(): number;
}

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function inMemoryDedup(ttlMs: number = DEFAULT_TTL_MS): Deduplicator {
  const seen = new Map<string, number>();

  function gc(now: number): void {
    for (const [id, ts] of seen) {
      if (now - ts > ttlMs) seen.delete(id);
    }
  }

  return {
    checkAndRecord(eventId: string, now: number = Date.now()): boolean {
      gc(now);
      if (seen.has(eventId)) return true;
      seen.set(eventId, now);
      return false;
    },
    size(): number {
      return seen.size;
    },
  };
}
