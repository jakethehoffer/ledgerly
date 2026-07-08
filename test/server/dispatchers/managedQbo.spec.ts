import { describe, it, expect, vi } from 'vitest';
import { cents } from '../../../src/money.js';
import type { QboAccountMap } from '../../../src/exporters/types.js';
import { managedQboDispatcher } from '../../../src/server/dispatchers/managedQbo.js';
import { inMemoryStorage } from '../../../src/server/storage/inMemory.js';
import type { OAuthClientConfig } from '../../../src/server/oauth/types.js';
import type { SavedScheduledEntry, Storage } from '../../../src/server/storage/types.js';

const accountMap: QboAccountMap = {
  '1000': { qboId: 'qbo-1000', name: 'Cash' },
  '1010': { qboId: 'qbo-1010', name: 'Stripe Clearing' },
  '1100': { qboId: 'qbo-1100', name: 'AR' },
  '1200': { qboId: 'qbo-1200', name: 'Disputes Receivable' },
  '2000': { qboId: 'qbo-2000', name: 'Sales Tax Payable' },
  '2100': { qboId: 'qbo-2100', name: 'Deferred Revenue' },
  '4000': { qboId: 'qbo-4000', name: 'Subscription Revenue' },
  '4100': { qboId: 'qbo-4100', name: 'App Fee Revenue' },
  '4900': { qboId: 'qbo-4900', name: 'Refunds' },
  '6000': { qboId: 'qbo-6000', name: 'Stripe Fees' },
  '6100': { qboId: 'qbo-6100', name: 'Payment Disputes' },
  '6200': { qboId: 'qbo-6200', name: 'Bad Debt Expense' },
  '7000': { qboId: 'qbo-7000', name: 'FX' },
};

const oauthClient: OAuthClientConfig = {
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri: 'https://example.com/oauth/qbo/callback',
};

function makeEntry(): SavedScheduledEntry {
  return {
    id: 100,
    eventId: 'evt_x',
    subscriptionId: 'sub_x',
    status: 'pending',
    attempts: 0,
    lastAttemptedAt: null,
    nextAttemptAt: null,
    lastError: null,
    entry: {
      date: '2026-05-16',
      currency: 'USD',
      memo: 'managed-qbo-test',
      sourceEventId: 'evt_x',
      sourceEventType: 'invoice.payment_succeeded',
      sourceObjectId: 'in_x',
      lines: [
        { accountCode: '2100', side: 'debit', amount: cents(10000) },
        { accountCode: '4000', side: 'credit', amount: cents(10000) },
      ],
    },
  };
}

function apiOkResponse(): Response {
  return new Response('{"JournalEntry":{"Id":"abc","SyncToken":"0"}}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function api401Response(): Response {
  return new Response('{"Fault":{"Error":[{"code":"3200","Message":"401 expired"}]}}', {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function refreshResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      scope: 'com.intuit.quickbooks.accounting',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function seedStorage(
  storage: Storage,
  overrides: { accessToken?: string; refreshToken?: string; expiresAt?: number } = {},
): void {
  storage.oauth.save({
    provider: 'qbo',
    tenantId: 'realm-1',
    accessToken: overrides.accessToken ?? 'access-current',
    refreshToken: overrides.refreshToken ?? 'refresh-current',
    expiresAt: overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
    scope: 'com.intuit.quickbooks.accounting',
  });
}

describe('managedQboDispatcher', () => {
  it('throws when no tokens are stored', async () => {
    const storage = inMemoryStorage();
    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: vi.fn(),
    });
    await expect(dispatch(makeEntry())).rejects.toThrow(/no QBO tokens/i);
  });

  it('calls the underlying dispatcher with the stored access_token + realmId', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, { accessToken: 'access-1' });
    const fetchImpl = vi.fn().mockResolvedValue(apiOkResponse());

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] ?? [];
    expect(String(calledUrl)).toContain('/v3/company/realm-1/journalentry');
    const headers = (calledInit as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-1');
  });

  it('refreshes when expires_at is in the past', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, {
      accessToken: 'access-old',
      refreshToken: 'refresh-1',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(refreshResponse('access-new', 'refresh-2'))
      .mockResolvedValueOnce(apiOkResponse());

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    // First call: refresh.
    const [refreshUrl] = fetchImpl.mock.calls[0] ?? [];
    expect(refreshUrl).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');

    // Second call: API, using the new access token.
    const [, calledInit] = fetchImpl.mock.calls[1] ?? [];
    const headers = (calledInit as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-new');

    // Stored tokens updated.
    const stored = storage.oauth.get('qbo');
    expect(stored?.accessToken).toBe('access-new');
    expect(stored?.refreshToken).toBe('refresh-2');
  });

  it('refreshes when expires_at is within the default 60s safety margin', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, {
      accessToken: 'access-near-expiry',
      refreshToken: 'refresh-1',
      expiresAt: Math.floor(Date.now() / 1000) + 30,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(refreshResponse('access-fresh', 'refresh-2'))
      .mockResolvedValueOnce(apiOkResponse());

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, apiInit] = fetchImpl.mock.calls[1] ?? [];
    const headers = (apiInit as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-fresh');
  });

  it('does NOT refresh when expires_at is well past the safety margin', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, {
      accessToken: 'access-good',
      refreshToken: 'refresh-1',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const fetchImpl = vi.fn().mockResolvedValue(apiOkResponse());

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl] = fetchImpl.mock.calls[0] ?? [];
    expect(String(calledUrl)).toContain('/journalentry');
  });

  it('retries once on 401 after refreshing', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, {
      accessToken: 'access-stale',
      refreshToken: 'refresh-1',
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // valid by clock, but server says 401
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(api401Response()) // First API call: 401
      .mockResolvedValueOnce(refreshResponse('access-fresh', 'refresh-2')) // Refresh
      .mockResolvedValueOnce(apiOkResponse()); // Retry API call

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const stored = storage.oauth.get('qbo');
    expect(stored?.accessToken).toBe('access-fresh');
    expect(stored?.refreshToken).toBe('refresh-2');
  });

  it('does NOT retry on non-401 errors', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    );

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await expect(dispatch(makeEntry())).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('propagates a refresh failure during the 401 retry path', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(api401Response())
      .mockResolvedValueOnce(
        new Response('{"error":"invalid_grant"}', {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await expect(dispatch(makeEntry())).rejects.toThrow(/Token refresh failed/);
  });

  it('falls back to globalThis.fetch when config.fetch is omitted', async () => {
    // Covers the `config.fetch ?? globalThis.fetch` fallback at construction
    // AND the `config.fetch !== undefined ? { fetch } : {}` else-branch in
    // dispatchOnce (the underlying qboDispatcher gets no fetch override, so
    // it too falls back to globalThis.fetch). The global is stubbed so no
    // real network call happens. Token expiry is the seedStorage default
    // (+3600s), so ensureFresh returns early — the API POST is the only call.
    const storage = inMemoryStorage();
    seedStorage(storage);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(apiOkResponse());
    try {
      const dispatch = managedQboDispatcher({ oauthClient, storage, accountMap });
      await dispatch(makeEntry());
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0] ?? [];
      expect(String(url)).toContain('/v3/company/realm-1/journalentry');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('forwards a custom apiBase to the underlying dispatcher', async () => {
    // Covers the `config.apiBase !== undefined` true branch in dispatchOnce.
    const storage = inMemoryStorage();
    seedStorage(storage);
    const fetchImpl = vi.fn().mockResolvedValue(apiOkResponse());

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      apiBase: 'https://sandbox-quickbooks.api.intuit.com',
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(String(url)).toContain(
      'https://sandbox-quickbooks.api.intuit.com/v3/company/',
    );
  });

  it('rethrows a non-Error rejection from the underlying dispatcher', async () => {
    // Covers the `err instanceof Error ? err.message : String(err)` else
    // branch in the 401-retry catch. The catch normally sees Error objects
    // (qboDispatcher throws Error on non-ok responses), but a fetch impl
    // that rejects with a bare value exercises the String(err) fallback.
    // The coerced message contains no '401', so the wrapper rethrows the
    // original value unchanged for the scheduler's backoff.
    const storage = inMemoryStorage();
    seedStorage(storage);
    const fetchImpl = vi.fn().mockRejectedValue('network glitch');

    const dispatch = managedQboDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await expect(dispatch(makeEntry())).rejects.toBe('network glitch');
  });
});
