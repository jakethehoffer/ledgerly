import { describe, it, expect, vi } from 'vitest';
import { cents } from '../../../src/money.js';
import type { XeroAccountMap } from '../../../src/exporters/types.js';
import { managedXeroDispatcher } from '../../../src/server/dispatchers/managedXero.js';
import { inMemoryStorage } from '../../../src/server/storage/inMemory.js';
import type { OAuthClientConfig } from '../../../src/server/oauth/types.js';
import type { SavedScheduledEntry, Storage } from '../../../src/server/storage/types.js';

const accountMap: XeroAccountMap = {
  '1000': { accountCode: '1000' },
  '1010': { accountCode: '1010' },
  '1100': { accountCode: '1100' },
  '1200': { accountCode: '1200' },
  '2000': { accountCode: '2000' },
  '2100': { accountCode: '2100' },
  '4000': { accountCode: '4000' },
  '4100': { accountCode: '4100' },
  '4900': { accountCode: '4900' },
  '6000': { accountCode: '6000' },
  '6100': { accountCode: '6100' },
  '7000': { accountCode: '7000' },
};

const oauthClient: OAuthClientConfig = {
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUri: 'https://example.com/oauth/xero/callback',
};

function makeEntry(): SavedScheduledEntry {
  return {
    id: 200,
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
      memo: 'managed-xero-test',
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
  return new Response(
    '{"ManualJournals":[{"ManualJournalID":"abc","UpdatedDateUTC":"2025-02-15"}]}',
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function api401Response(): Response {
  return new Response('{"Title":"Unauthorized","Detail":"401 expired"}', {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

function refreshResponse(accessToken: string, refreshToken: string): Response {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 1800,
      scope: 'accounting.transactions accounting.settings offline_access',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function seedStorage(
  storage: Storage,
  overrides: { accessToken?: string; refreshToken?: string; expiresAt?: number } = {},
): void {
  storage.oauth.save({
    provider: 'xero',
    tenantId: 'tnt-1',
    accessToken: overrides.accessToken ?? 'access-current',
    refreshToken: overrides.refreshToken ?? 'refresh-current',
    expiresAt: overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 1800,
    scope: 'accounting.transactions accounting.settings offline_access',
  });
}

describe('managedXeroDispatcher', () => {
  it('throws when no tokens are stored', async () => {
    const storage = inMemoryStorage();
    const dispatch = managedXeroDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: vi.fn(),
    });
    await expect(dispatch(makeEntry())).rejects.toThrow(/no Xero tokens/i);
  });

  it('calls the underlying dispatcher with the stored access_token + tenantId', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, { accessToken: 'xa-1' });
    const fetchImpl = vi.fn().mockResolvedValue(apiOkResponse());

    const dispatch = managedXeroDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] ?? [];
    expect(String(calledUrl)).toBe('https://api.xero.com/api.xro/2.0/ManualJournals');
    const headers = (calledInit as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer xa-1');
    expect(headers['Xero-Tenant-Id']).toBe('tnt-1');
  });

  it('refreshes when expires_at is in the past and persists the rotated refresh token', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, {
      accessToken: 'xa-old',
      refreshToken: 'xr-1',
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(refreshResponse('xa-new', 'xr-2'))
      .mockResolvedValueOnce(apiOkResponse());

    const dispatch = managedXeroDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    const [refreshUrl] = fetchImpl.mock.calls[0] ?? [];
    expect(refreshUrl).toBe('https://identity.xero.com/connect/token');

    const stored = storage.oauth.get('xero');
    // Xero refresh tokens rotate — verify the new one was persisted.
    expect(stored?.accessToken).toBe('xa-new');
    expect(stored?.refreshToken).toBe('xr-2');
  });

  it('refreshes when expires_at is within the safety margin', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, {
      accessToken: 'xa-near',
      refreshToken: 'xr-1',
      expiresAt: Math.floor(Date.now() / 1000) + 30,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(refreshResponse('xa-fresh', 'xr-2'))
      .mockResolvedValueOnce(apiOkResponse());

    const dispatch = managedXeroDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries once on 401 after refreshing', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage, { expiresAt: Math.floor(Date.now() / 1000) + 1800 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(api401Response())
      .mockResolvedValueOnce(refreshResponse('xa-after', 'xr-after'))
      .mockResolvedValueOnce(apiOkResponse());

    const dispatch = managedXeroDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const stored = storage.oauth.get('xero');
    expect(stored?.accessToken).toBe('xa-after');
    expect(stored?.refreshToken).toBe('xr-after');
  });

  it('does NOT retry on non-401 errors', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage);
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
    );

    const dispatch = managedXeroDispatcher({
      oauthClient,
      storage,
      accountMap,
      fetch: fetchImpl,
    });
    await expect(dispatch(makeEntry())).rejects.toThrow(/500/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('passes through the configured status (DRAFT/POSTED) to the underlying dispatcher', async () => {
    const storage = inMemoryStorage();
    seedStorage(storage);
    const fetchImpl = vi.fn().mockResolvedValue(apiOkResponse());

    const dispatch = managedXeroDispatcher({
      oauthClient,
      storage,
      accountMap,
      status: 'POSTED',
      fetch: fetchImpl,
    });
    await dispatch(makeEntry());

    const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
    const sent = JSON.parse((calledInit as RequestInit).body as string) as {
      ManualJournals: { Status: string }[];
    };
    expect(sent.ManualJournals[0]?.Status).toBe('POSTED');
  });
});
