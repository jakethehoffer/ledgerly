import { describe, it, expect } from 'vitest';
import { inMemoryDedup } from '../../src/server/dedup.js';

describe('inMemoryDedup', () => {
  it('returns false on first sighting and true on second', () => {
    const dedup = inMemoryDedup();
    expect(dedup.checkAndRecord('evt_1')).toBe(false);
    expect(dedup.checkAndRecord('evt_1')).toBe(true);
  });

  it('treats distinct event IDs independently', () => {
    const dedup = inMemoryDedup();
    expect(dedup.checkAndRecord('evt_1')).toBe(false);
    expect(dedup.checkAndRecord('evt_2')).toBe(false);
    expect(dedup.checkAndRecord('evt_1')).toBe(true);
    expect(dedup.checkAndRecord('evt_2')).toBe(true);
  });

  it('size() reflects current state', () => {
    const dedup = inMemoryDedup();
    expect(dedup.size()).toBe(0);
    dedup.checkAndRecord('evt_1');
    expect(dedup.size()).toBe(1);
    dedup.checkAndRecord('evt_2');
    expect(dedup.size()).toBe(2);
    // Re-recording a known id does not grow the map.
    dedup.checkAndRecord('evt_1');
    expect(dedup.size()).toBe(2);
  });

  it('evicts entries past the TTL window', () => {
    const ttlMs = 1_000;
    const dedup = inMemoryDedup(ttlMs);
    expect(dedup.checkAndRecord('evt_1', 0)).toBe(false);
    expect(dedup.checkAndRecord('evt_1', 500)).toBe(true);
    // Just past TTL — GC drops evt_1 and we accept it as new.
    expect(dedup.checkAndRecord('evt_1', 2_000)).toBe(false);
    expect(dedup.size()).toBe(1);
  });

  it('GC during checkAndRecord shrinks size for stale entries', () => {
    const ttlMs = 1_000;
    const dedup = inMemoryDedup(ttlMs);
    dedup.checkAndRecord('evt_old', 0);
    dedup.checkAndRecord('evt_recent', 500);
    expect(dedup.size()).toBe(2);
    // Insert at t=2000 — evt_old (age 2000) is past TTL, evt_recent (age 1500)
    // is also past TTL. Both get GC'd, only the new one remains.
    dedup.checkAndRecord('evt_new', 2_000);
    expect(dedup.size()).toBe(1);
  });
});
