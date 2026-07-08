import { describe, it, expect, vi } from 'vitest';
import { cents } from '../../../src/money.js';
import { toQbo } from '../../../src/exporters/qbo.js';
import type { QboAccountMap } from '../../../src/exporters/types.js';
import { qboDispatcher } from '../../../src/server/dispatchers/qbo.js';
import type { SavedScheduledEntry } from '../../../src/server/storage/types.js';

const accountMap: QboAccountMap = {
  '1000': { qboId: 'qbo-1000', name: 'Cash' },
  '1010': { qboId: 'qbo-1010', name: 'Stripe Clearing' },
  '1100': { qboId: 'qbo-1100', name: 'AR' },
  '1200': { qboId: 'qbo-1200', name: 'Disputes Receivable' },
  '2000': { qboId: 'qbo-2000', name: 'Sales Tax Payable' },
  '2100': { qboId: 'qbo-2100', name: 'Deferred Revenue' },
  '2200': { qboId: 'qbo-2200', name: 'Customer Credit Balance' },
  '4000': { qboId: 'qbo-4000', name: 'Subscription Revenue' },
  '4100': { qboId: 'qbo-4100', name: 'App Fee Revenue' },
  '4900': { qboId: 'qbo-4900', name: 'Refunds' },
  '6000': { qboId: 'qbo-6000', name: 'Stripe Fees' },
  '6100': { qboId: 'qbo-6100', name: 'Payment Disputes' },
  '6200': { qboId: 'qbo-6200', name: 'Bad Debt Expense' },
  '7000': { qboId: 'qbo-7000', name: 'FX' },
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
  const body = init.body ?? '{"JournalEntry":{"Id":"abc","SyncToken":"0"}}';
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (init.retryAfter !== undefined && init.retryAfter !== null) {
    headers.set('Retry-After', init.retryAfter);
  }
  return new Response(body, { status, headers });
}

describe('qboDispatcher', () => {
  describe('successful POST', () => {
    it('posts to the correct URL with bearer + JSON headers and resolves', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = qboDispatcher({
        accessToken: 'tok_abc',
        realmId: '9341452813409184',
        accountMap,
        fetch: fetchImpl,
      });

      const entry = makeEntry();
      await dispatch(entry);

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchImpl.mock.calls[0] ?? [];

      expect(calledUrl).toBe(
        'https://quickbooks.api.intuit.com/v3/company/9341452813409184/journalentry?minorversion=70',
      );

      const init = calledInit as RequestInit;
      expect(init.method).toBe('POST');

      const headers = init.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer tok_abc');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['Accept']).toBe('application/json');

      const sentBody = JSON.parse(init.body as string) as unknown;
      expect(sentBody).toEqual(toQbo(entry.entry, accountMap));
    });
  });

  describe('URL composition', () => {
    it('URL-encodes the realm ID and respects an apiBase override', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = qboDispatcher({
        accessToken: 'tok_abc',
        // Pathological realmId with a character that needs encoding.
        realmId: 'tenant/with space',
        accountMap,
        apiBase: 'https://sandbox-quickbooks.api.intuit.com',
        fetch: fetchImpl,
      });

      await dispatch(makeEntry());

      const [calledUrl] = fetchImpl.mock.calls[0] ?? [];
      expect(calledUrl).toBe(
        'https://sandbox-quickbooks.api.intuit.com/v3/company/tenant%2Fwith%20space/journalentry?minorversion=70',
      );
    });
  });

  describe('Bearer token in Authorization header', () => {
    it('header value is exactly `Bearer ${accessToken}`', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = qboDispatcher({
        accessToken: 'ya29.a0AfH6SLong.Token',
        realmId: 'rlm',
        accountMap,
        fetch: fetchImpl,
      });

      await dispatch(makeEntry());

      const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
      const headers = (calledInit as RequestInit).headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer ya29.a0AfH6SLong.Token');
    });
  });

  describe('body is toQbo(entry, accountMap) stringified', () => {
    it('JSON.parse(req.body) deep-equals direct toQbo() output', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse());
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
        accountMap,
        fetch: fetchImpl,
      });

      const entry = makeEntry();
      await dispatch(entry);

      const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
      const sent = JSON.parse((calledInit as RequestInit).body as string) as unknown;
      expect(sent).toEqual(toQbo(entry.entry, accountMap));
    });
  });

  describe('401 response', () => {
    it('throws with status and body included', async () => {
      const body = '{"Fault":{"Error":[{"code":"3200","Message":"Token expired"}]}}';
      const fetchImpl = vi
        .fn()
        .mockImplementation(() => Promise.resolve(mockResponse({ status: 401, body })));
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
        accountMap,
        fetch: fetchImpl,
      });

      await expect(dispatch(makeEntry())).rejects.toThrow(/401/);
      await expect(dispatch(makeEntry())).rejects.toThrow(/Token expired/);
    });

    it('truncates body to 500 chars with trailing ellipsis', async () => {
      const longBody = 'X'.repeat(1000);
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ status: 401, body: longBody }));
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
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
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
        accountMap,
        fetch: fetchImpl,
      });

      await expect(dispatch(makeEntry())).rejects.toThrow(/Retry-After: 30/);
    });

    it('omits Retry-After note when header is absent', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        mockResponse({ status: 429, body: 'rate limited' }),
      );
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
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
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
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
            body: '{"Fault":{"Error":[{"Message":"Invalid account ref"}]}}',
          }),
        ),
      );
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
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
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
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
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
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
      expect(meta).toMatchObject({ qboEntry: expect.any(Object) as unknown });
    });

    it('is NOT called on failure', async () => {
      const info = vi.fn();
      const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ status: 500, body: 'boom' }));
      const dispatch = qboDispatcher({
        accessToken: 'tok',
        realmId: 'rlm',
        accountMap,
        fetch: fetchImpl,
        log: { debug: vi.fn(), info, warn: vi.fn(), error: vi.fn() },
      });

      await expect(dispatch(makeEntry())).rejects.toThrow();
      expect(info).not.toHaveBeenCalled();
    });
  });
});
