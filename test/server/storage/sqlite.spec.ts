import Database from 'better-sqlite3';
import { afterEach, describe, it, expect } from 'vitest';
import { applyMigrations } from '../../../src/server/storage/migrations.js';
import { sqliteStorage } from '../../../src/server/storage/sqlite.js';
import { cents } from '../../../src/money.js';
import { runStorageSuite } from './suite.js';

const databases: Database.Database[] = [];

function testDatabase(): Database.Database {
  const db = new Database(':memory:');
  databases.push(db);
  return db;
}

afterEach(() => {
  // Release each test's native database even when an assertion fails.
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
});

runStorageSuite('sqliteStorage', () => {
  const db = testDatabase();
  applyMigrations(db);
  return sqliteStorage(db);
});

// SQLite-only: verify the durability promise — entries persist across two
// store instances backed by the same Database handle, and persistMapResult
// truly rolls back on failure. We use a `:memory:` database so no temp file
// is created.
describe('sqliteStorage durability and atomicity', () => {
  it('holds ambiguous legacy sends once without holding new sends on later opens', () => {
    const db = testDatabase();
    applyMigrations(db);
    db.prepare("DELETE FROM storage_metadata WHERE key = 'dispatch_identity'").run();
    db.prepare(`INSERT INTO scheduled_entries (event_id, subscription_id, scheduled_date, payload, attempts)
      VALUES ('evt_old', 'sub_old', '2025-01-01', '{}', 1),
      ('evt_fresh', 'sub_fresh', '2025-01-01', '{}', 0)`).run();
    applyMigrations(db);
    expect(db.prepare('SELECT status FROM scheduled_entries WHERE event_id = ?').get('evt_old')).toEqual({ status: 'held' });
    expect(db.prepare('SELECT status FROM scheduled_entries WHERE event_id = ?').get('evt_fresh')).toEqual({ status: 'pending' });
    db.prepare("UPDATE scheduled_entries SET attempts = 1 WHERE event_id = 'evt_fresh'").run();
    applyMigrations(db);
    expect(db.prepare('SELECT status FROM scheduled_entries WHERE event_id = ?').get('evt_fresh')).toEqual({ status: 'pending' });
    db.close();
  });

  it('survives a fresh store instance backed by the same Database', () => {
    const db = testDatabase();
    applyMigrations(db);

    const first = sqliteStorage(db);
    first.dedup.record('evt_persist');

    const second = sqliteStorage(db);
    expect(second.dedup.has('evt_persist')).toBe(true);
    expect(second.dedup.size()).toBe(1);
  });

  it('keeps a subscription end across fresh store instances', () => {
    const db = testDatabase();
    applyMigrations(db);
    sqliteStorage(db).persistSubscriptionCancellation('evt_end', {
      subscriptionId: 'sub_ended',
      effectiveEndDate: '2026-07-15',
    });

    const fresh = sqliteStorage(db);
    fresh.persistMapResult('evt_late_invoice', {
      entries: [],
      schedule: {
        subscriptionId: 'sub_ended',
        sourceEventId: 'evt_late_invoice',
        entries: [
          {
            date: '2026-08-15',
            currency: 'USD',
            memo: 'late month',
            sourceEventId: 'evt_late_invoice',
            sourceEventType: 'invoice.payment_succeeded',
            sourceObjectId: 'in_late',
            lines: [
              { accountCode: '2100', side: 'debit', amount: cents(100) },
              { accountCode: '4000', side: 'credit', amount: cents(100) },
            ],
          },
        ],
      },
    });

    expect(fresh.entries.findScheduledBySubscription('sub_ended')[0]?.status).toBe('held');
  });

  it('migrates a legacy v0 scheduled_entries table (CHECK + missing retry columns)', () => {
    // Simulate a pre-existing v0 database: original CHECK constraint, no
    // retry-tracking columns. Seed a few rows to verify they survive the rebuild.
    const db = testDatabase();
    db.exec(`
      CREATE TABLE processed_events (
        event_id TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );
      CREATE TABLE journal_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        posted_at INTEGER NOT NULL,
        date TEXT NOT NULL,
        currency TEXT NOT NULL,
        memo TEXT NOT NULL,
        source_event_type TEXT NOT NULL,
        source_object_id TEXT,
        payload TEXT NOT NULL
      );
      CREATE TABLE scheduled_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'posted', 'cancelled')) DEFAULT 'pending',
        posted_at INTEGER,
        payload TEXT NOT NULL
      );
      CREATE INDEX idx_scheduled_pending ON scheduled_entries(status, scheduled_date);
      INSERT INTO scheduled_entries (event_id, subscription_id, scheduled_date, payload)
        VALUES ('evt_legacy', 'sub_legacy', '2026-05-01', '{"legacy":true}');
    `);

    applyMigrations(db);

    // Row preserved.
    const rows = db
      .prepare<
        [],
        { id: number; status: string; attempts: number; payload: string }
      >('SELECT id, status, attempts, payload FROM scheduled_entries')
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('pending');
    expect(rows[0]?.attempts).toBe(0);
    expect(rows[0]?.payload).toBe('{"legacy":true}');

    // CHECK gone — newer states can be inserted without another rebuild.
    expect(() => {
      db.exec(
        `INSERT INTO scheduled_entries
           (event_id, subscription_id, scheduled_date, status, payload, attempts)
         VALUES ('evt_fail', 'sub_fail', '2026-05-01', 'held', '{}', 10)`,
      );
    }).not.toThrow();

    // Index rebuilt — sanity check that the typical filter still uses it.
    const planRow = db
      .prepare<[], { detail: string }>(
        `EXPLAIN QUERY PLAN
           SELECT id FROM scheduled_entries
            WHERE status = 'pending' AND scheduled_date <= '2026-05-16'`,
      )
      .get();
    expect(planRow?.detail ?? '').toContain('idx_scheduled_pending');
  });

  it('persistMapResult is atomic — a write failure rolls back dedup record', () => {
    const db = testDatabase();
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
