import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { applyMigrations } from '../../../src/server/storage/migrations.js';
import { sqliteStorage } from '../../../src/server/storage/sqlite.js';
import { runStorageSuite } from './suite.js';

runStorageSuite('sqliteStorage', () => {
  const db = new Database(':memory:');
  applyMigrations(db);
  return sqliteStorage(db);
});

// SQLite-only: verify the durability promise — entries persist across two
// store instances backed by the same Database handle, and persistMapResult
// truly rolls back on failure. We use a `:memory:` database so no temp file
// is created.
describe('sqliteStorage durability and atomicity', () => {
  it('survives a fresh store instance backed by the same Database', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    const first = sqliteStorage(db);
    first.dedup.record('evt_persist');

    const second = sqliteStorage(db);
    expect(second.dedup.has('evt_persist')).toBe(true);
    expect(second.dedup.size()).toBe(1);
  });

  it('persistMapResult is atomic — a write failure rolls back dedup record', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const storage = sqliteStorage(db);

    // Forcibly drop the journal_entries table so the insert fails mid-transaction.
    db.exec('DROP TABLE journal_entries');

    const entry = {
      date: '2026-05-16',
      currency: 'USD',
      memo: 'will fail',
      sourceEventId: 'evt_fail',
      sourceEventType: 'charge.succeeded',
      sourceObjectId: 'ch_test',
      lines: [],
    } as const;

    expect(() => {
      storage.persistMapResult('evt_fail', {
        entries: [entry],
        schedule: null,
      });
    }).toThrow();

    // Dedup must not have been recorded — the txn rolled back.
    expect(storage.dedup.has('evt_fail')).toBe(false);
  });
});
