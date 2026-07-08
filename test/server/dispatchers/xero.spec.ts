import { describe, it, expect, vi } from 'vitest';
import { cents } from '../../../src/money.js';
import { toXero } from '../../../src/exporters/xero.js';
import type { XeroAccountMap } from '../../../src/exporters/types.js';
import { xeroDispatcher } from '../../../src/server/dispatchers/xero.js';
import type { SavedScheduledEntry } from '../../../src/server/storage/types.js';

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
  '6200': { accountCode: '6200' },
  '7000': { accountCode: '7000' },
};

function makeEntry(overrides: Partial<SavedScheduledEntry> = {}): SavedScheduledEntry {
  return {
    id: 42,
    eventId: 'evt_test_001',
    subscriptionId: 'sub_test_001',
    status: 'pending',
    attempts: 0,
    lastAttemptedAt: null,
    nextAttemptAt: null,
    lastError: null,
    entry: {
      date: '2025-02-15',
      currency: 'USD',
      memo: 'Test recognition entry',
      sourceEventId: 'evt_test_001',
      sourceEventType: 'invoice.payment_succeeded',
      sourceObjectId: 'in_test_001',
      lines: [
        { accountCode: '2100', side: 'debit', amount: cents(10000), memo: 'Recognize from deferred' },
        { accountCode: '4000', side: 'credit', amount: cents(10000), memo: 'Subscription revenue' },
      ],
    },
    ...overrides,
  };
}

interface MockResponseInit {
  status?: number;
  body?: string;
  retryAfter?: string | null;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const body =
    init.body ?? '{"ManualJournals":[{"ManualJournalID":"abc","UpdatedDateUTC":"2025-02-15"}]}';
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (init.retryAfter !== undefined && init.retryAfter !== null) {
    headers.set('Retry-After', init.retryAfter);
  }
  return new Response(body, { status, headers });
}

describe('xeroDispatcher', () => {
  describe('successful POST', () => {
    it('posts to the correct URL with bearer + tenant + idempotency + JSON headers and resolves', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = xeroDispatcher({
        accessToken: 'tok_abc',
        tenantId: '70784a6d-c1c5-4f3c-bf3a-1a2b3c4d5e6f',
        accountMap,
        fetch: fetchImpl,
      });

      const entry = makeEntry();
      await dispatch(entry);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchImpl.mock.calls[0] ?? [];

      expect(calledUrl).toBe('https://api.xero.com/api.xro/2.0/ManualJournals');

      const init = calledInit as RequestInit;
      expect(init.method).toBe('POST');

      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer tok_abc');
      expect(headers['Xero-Tenant-Id']).toBe('70784a6d-c1c5-4f3c-bf3a-1a2b3c4d5e6f');
      expect(headers['Idempotency-Key']).toBe('42');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Accept']).toBe('application/json');

      const sentBody = JSON.parse(init.body as string) as unknown;
      expect(sentBody).toEqual({ ManualJournals: [toXero(entry.entry, accountMap, 'DRAFT')] });
    });
  });

  describe('URL composition', () => {
    it('respects an apiBase override (e.g., a proxy URL); no query parameters', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = xeroDispatcher({
        accessToken: 'tok_abc',
        tenantId: 'tenant-xyz',
        accountMap,
        apiBase: 'https://xero-proxy.example.com',
        fetch: fetchImpl,
      });

      await dispatch(makeEntry());

      const [calledUrl] = fetchImpl.mock.calls[0] ?? [];
      expect(calledUrl).toBe('https://xero-proxy.example.com/api.xro/2.0/ManualJournals');
    });
  });

  describe('Bearer + tenant + idempotency headers', () => {
    it('each header has its exact expected value', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = xeroDispatcher({
        accessToken: 'eyJhbGciOiJSUzI1NiIsImtpZCI6IkExQjJDMyJ9.Long.Token',
        tenantId: 'tenant-uuid-1234',
        accountMap,
        fetch: fetchImpl,
      });

      await dispatch(makeEntry({ id: 7 }));

      const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
      const headers = (calledInit as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe(
        'Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IkExQjJDMyJ9.Long.Token',
      );
      expect(headers['Xero-Tenant-Id']).toBe('tenant-uuid-1234');
      expect(headers['Idempotency-Key']).toBe('7');
    });
  });

  describe('body shape', () => {
    it('JSON.parse(req.body) deep-equals { ManualJournals: [toXero(entry, accountMap, DRAFT)] }', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
      });

      const entry = makeEntry();
      await dispatch(entry);

      const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
      const sent = JSON.parse((calledInit as RequestInit).body as string) as unknown;
      expect(sent).toEqual({ ManualJournals: [toXero(entry.entry, accountMap, 'DRAFT')] });
    });
  });

  describe('status override', () => {
    it("passing status: 'POSTED' produces a journal with Status: 'POSTED'", async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        status: 'POSTED',
        fetch: fetchImpl,
      });

      const entry = makeEntry();
      await dispatch(entry);

      const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
      const sent = JSON.parse((calledInit as RequestInit).body as string) as {
        ManualJournals: { Status: string }[];
      };
      expect(sent.ManualJournals[0]?.Status).toBe('POSTED');
      expect(sent).toEqual({ ManualJournals: [toXero(entry.entry, accountMap, 'POSTED')] });
    });
  });

  describe('401 response', () => {
    it('throws with status and body included', async () => {
      const body = '{"Title":"Unauthorized","Detail":"Token expired"}';
      const fetchImpl = vi
        .fn()
        .mockImplementation(() => Promise.resolve(mockResponse({ status: 401, body })));
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
      });

      await expect(dispatch(makeEntry())).rejects.toThrow(/401/);
      await expect(dispatch(makeEntry())).rejects.toThrow(/Token expired/);
    });

    it('truncates body to 500 chars with trailing ellipsis', async () => {
      const longBody = 'X'.repeat(1000);
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ status: 401, body: longBody }));
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
      });

      try {
        await dispatch(makeEntry());
        throw new Error('expected dispatcher to throw');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/X{500}\.\.\./);
        expect(msg).not.toMatch(/X{501}/);
      }
    });
  });

  describe('429 with Retry-After', () => {
    it('error message includes the Retry-After value', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        mockResponse({ status: 429, body: 'rate limited', retryAfter: '30' }),
      );
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
      });

      await expect(dispatch(makeEntry())).rejects.toThrow(/Retry-After: 30/);
    });

    it('omits Retry-After note when header is absent', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        mockResponse({ status: 429, body: 'rate limited' }),
      );
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
      });

      try {
        await dispatch(makeEntry());
        throw new Error('expected dispatcher to throw');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).toMatch(/429/);
        expect(msg).not.toMatch(/Retry-After/);
      }
    });
  });

  describe('5xx response', () => {
    it('throws with status and body included', async () => {
      const fetchImpl = vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            mockResponse({ status: 503, body: '<html>Service Unavailable</html>' }),
          ),
        );
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
      });

      await expect(dispatch(makeEntry())).rejects.toThrow(/503/);
      await expect(dispatch(makeEntry())).rejects.toThrow(/Service Unavailable/);
    });
  });

  describe('400 with malformed account map error', () => {
    it('throws on every retry (scheduler will continue retrying)', async () => {
      const fetchImpl = vi.fn().mockImplementation(() =>
        Promise.resolve(
          mockResponse({
            status: 400,
            body:
              '{"Title":"ValidationException","Detail":"AccountCode is not in your chart of accounts"}',
          }),
        ),
      );
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
      });

      const entry = makeEntry();
      await expect(dispatch(entry)).rejects.toThrow(/400/);
      await expect(dispatch(entry)).rejects.toThrow(/400/);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe('network error (fetch throws)', () => {
    it('propagates the underlying error to the scheduler', async () => {
      const networkErr = new Error('ECONNRESET');
      const fetchImpl = vi.fn().mockRejectedValue(networkErr);
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
      });

      await expect(dispatch(makeEntry())).rejects.toThrow(/ECONNRESET/);
    });
  });

  describe('log.info', () => {
    it('is called on success', async () => {
      const info = vi.fn();
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
        log: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
      });

      await dispatch(makeEntry());

      expect(info).toHaveBeenCalledTimes(1);
      const [msg, meta] = info.mock.calls[0] ?? [];
      expect(typeof msg).toBe('string');
      expect(msg as string).toContain('id=42');
      expect(msg as string).toContain('Test recognition entry');
      expect(meta).toMatchObject({ xeroJournal: expect.any(Object) as unknown });
    });

    it('is NOT called on failure', async () => {
      const info = vi.fn();
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ status: 500, body: 'boom' }));
      const dispatch = xeroDispatcher({
        accessToken: 'tok',
        tenantId: 'tnt',
        accountMap,
        fetch: fetchImpl,
        log: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
      });

      await expect(dispatch(makeEntry())).rejects.toThrow();
      expect(info).not.toHaveBeenCalled();
    });
  });
});
