import { describe, it, expect } from 'vitest';
import {
  inMemoryDeduplicator,
  inMemoryStorage,
} from '../../../src/server/storage/inMemory.js';
import { runStorageSuite } from './suite.js';

runStorageSuite('inMemoryStorage', () => inMemoryStorage());

// In-memory-only behavior: TTL-based GC. The SQLite backend has no TTL — it
// retains processed events indefinitely, which is fine for an MVP audit table.
describe('inMemoryDeduplicator TTL', () => {
  it('evicts entries past the TTL window on the next write', () => {
    const ttlMs = 1_000;
    const dedup = inMemoryDeduplicator(ttlMs);
    expect(dedup.checkAndRecord('evt_1', 0)).toBe(false);
    expect(dedup.checkAndRecord('evt_1', 500)).toBe(true);
    // Just past TTL — GC drops evt_1 and the call is accepted as new.
    expect(dedup.checkAndRecord('evt_1', 2_000)).toBe(false);
    expect(dedup.size()).toBe(1);
  });

  it('GC during checkAndRecord shrinks size for stale entries', () => {
    const ttlMs = 1_000;
    const dedup = inMemoryDeduplicator(ttlMs);
    dedup.checkAndRecord('evt_old', 0);
    dedup.checkAndRecord('evt_recent', 500);
    expect(dedup.size()).toBe(2);
    // Insert at t=2000 — both prior entries are past TTL, get GC'd.
    dedup.checkAndRecord('evt_new', 2_000);
    expect(dedup.size()).toBe(1);
  });
});
