import { describe, expect, it, vi } from 'vitest';
import { cents } from '../../../src/money.js';
import { silentLogger } from '../../../src/server/logger.js';
import { qboDispatcher } from '../../../src/server/dispatchers/qbo.js';
import { xeroDispatcher } from '../../../src/server/dispatchers/xero.js';
import type { SavedScheduledEntry } from '../../../src/server/storage/types.js';
import { TEST_QBO_ACCOUNT_MAP, TEST_XERO_ACCOUNT_MAP } from '../../fixtures/test-account-maps.js';

function entry(id = 1, date = '2025-01-15', sourceEventId = 'evt_payment'): SavedScheduledEntry {
  return {
    id,
    eventId: sourceEventId,
    subscriptionId: 'sub_test',
    status: 'pending',
    attempts: 0,
    lastAttemptedAt: null,
    nextAttemptAt: null,
    lastError: null,
    entry: {
      date,
      currency: 'USD',
      memo: 'Monthly revenue',
      sourceEventId,
      sourceEventType: 'invoice.payment_succeeded',
      sourceObjectId: 'in_payment',
      lines: [
        { accountCode: '2100', side: 'debit', amount: cents(100) },
        { accountCode: '4000', side: 'credit', amount: cents(100) },
      ],
    },
  };
}

describe('dispatch retry protection', () => {
  it('keeps QBO request IDs across a restore but separates months and unrelated payments', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    const dispatch = qboDispatcher({
      accessToken: 'local',
      realmId: 'local',
      accountMap: TEST_QBO_ACCOUNT_MAP,
      fetch,
      log: silentLogger(),
    });
    for (const item of [
      entry(),
      entry(99),
      entry(1, '2025-02-15'),
      entry(1, '2025-01-15', 'evt_other'),
    ]) {
      await dispatch(item);
    }
    const keys = fetch.mock.calls.map(([url]) =>
      new URL(String(url)).searchParams.get('requestid'),
    );
    expect(keys[0]).toBe(keys[1]);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toMatch(/^[a-f0-9]{40}$/);
  });

  it('finds an earlier Xero send after its short retry key has expired', async () => {
    let saved: { Narration: string; ManualJournalID: string } | null = null;
    let writes = 0;
    const fetch = vi.fn(
      (url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
        if (init?.method === 'GET') {
          if (saved)
            expect(new URL(String(url)).searchParams.get('where')).toBe(
              `Narration==${JSON.stringify(saved.Narration)}`,
            );
          return Promise.resolve(
            new Response(JSON.stringify({ ManualJournals: saved ? [saved] : [] })),
          );
        }
        writes++;
        const body = JSON.parse(String(init?.body)) as { ManualJournals: { Narration: string }[] };
        saved = { Narration: body.ManualJournals[0]!.Narration, ManualJournalID: 'remote_saved' };
        throw new Error('Connection lost after Xero saved the journal');
      },
    );
    const config = {
      accessToken: 'local',
      tenantId: 'local',
      accountMap: TEST_XERO_ACCOUNT_MAP,
      fetch,
      log: silentLogger(),
    };
    await expect(xeroDispatcher(config)(entry())).rejects.toThrow('Connection lost');
    // A fresh dispatcher and changed database row ID cannot rely on a local cache.
    await expect(xeroDispatcher(config)(entry(77))).resolves.toBeUndefined();
    expect(writes).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([500, 200])(
    'refuses to send when the Xero duplicate check is unavailable or invalid (%s)',
    async (status) => {
      const fetch = vi.fn().mockResolvedValue(new Response('{}', { status }));
      await expect(
        xeroDispatcher({
          accessToken: 'local',
          tenantId: 'local',
          accountMap: TEST_XERO_ACCOUNT_MAP,
          fetch,
          log: silentLogger(),
        })(entry()),
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    },
  );

  it('does not count a Xero validation error in a successful HTTP response as a saved journal', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"ManualJournals":[]}'))
      .mockResolvedValueOnce(new Response('{"ManualJournals":[{"HasErrors":true}]}'));
    await expect(
      xeroDispatcher({
        accessToken: 'local',
        tenantId: 'local',
        accountMap: TEST_XERO_ACCOUNT_MAP,
        fetch,
        log: silentLogger(),
      })(entry()),
    ).rejects.toThrow('did not confirm');
  });
});
