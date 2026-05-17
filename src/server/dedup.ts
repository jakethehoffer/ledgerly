/**
 * Thin re-export layer for backwards compatibility. The deduplicator interface
 * and in-memory implementation now live in `./storage/`. Existing imports of
 * `inMemoryDedup` and `Deduplicator` keep working.
 */
export { inMemoryDeduplicator as inMemoryDedup } from './storage/inMemory.js';
export type { Deduplicator } from './storage/types.js';
