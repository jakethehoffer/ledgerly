import { describe, it, expect, vi } from 'vitest';
import {
  buildXeroAuthUrl,
  exchangeXeroCode,
  getXeroConnections,
  refreshXeroTokens,
} from '../../../src/server/oauth/xero.js';
import { OAuthError } from '../../../src/server/oauth/types.js';
import type { OAuthClientConfig } from '../../../src/server/oauth/types.js';

const config: OAuthClientConfig = {
  clientId: 'xero-client',
  clientSecret: 'xero-secret',
  redirectUri: 'https://example.com/oauth/xero/callback',
};

function mockJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockErrorResponse(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

describe('buildXeroAuthUrl', () => {
  it('points at the Xero authorize endpoint with the right query params', () => {
    const url = new URL(buildXeroAuthUrl(config, 'STATE-X'));
    expect(url.origin + url.pathname).toBe(
      'https://login.xero.com/identity/connect/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('xero-client');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://example.com/oauth/xero/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(
      'accounting.transactions accounting.settings offline_access',
    );
    expect(url.searchParams.get('state')).toBe('STATE-X');
  });
});

describe('exchangeXeroCode', () => {
  it('POSTs to the token endpoint with Basic auth + form body and parses the response', async () => {
    const tokenBody = {
      access_token: 'x-access-1',
      refresh_token: 'x-refresh-1',
      expires_in: 1800,
      token_type: 'Bearer',
      scope: 'accounting.transactions accounting.settings offline_access',
    };
    const fetchImpl = vi.fn().mockResolvedValue(mockJsonResponse(200, tokenBody));

    const tokens = await exchangeXeroCode(config, 'CODE-X', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] ?? [];
    expect(calledUrl).toBe('https://identity.xero.com/connect/token');

    const init = calledInit as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    const expectedBasic = 'Basic ' + Buffer.from('xero-client:xero-secret').toString('base64');
    expect(headers['Authorization']).toBe(expectedBasic);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('CODE-X');
    expect(sent.get('redirect_uri')).toBe('https://example.com/oauth/xero/callback');

    expect(tokens.accessToken).toBe('x-access-1');
    expect(tokens.refreshToken).toBe('x-refresh-1');
    expect(tokens.scope).toBe(
      'accounting.transactions accounting.settings offline_access',
    );
  });

  it('throws OAuthError on a 400 response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockErrorResponse(400, '{"error":"invalid_grant"}'));
    await expect(exchangeXeroCode(config, 'CODE', fetchImpl)).rejects.toThrow(OAuthError);
  });

  it('throws OAuthError on a 5xx response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockErrorResponse(503, 'boom'));
    await expect(exchangeXeroCode(config, 'CODE', fetchImpl)).rejects.toThrow(/503/);
  });
});

describe('refreshXeroTokens', () => {
  it('POSTs grant_type=refresh_token and returns the rotated refresh token', async () => {
    const tokenBody = {
      access_token: 'x-access-2',
      refresh_token: 'x-refresh-2-rotated',
      expires_in: 1800,
      scope: 'accounting.transactions accounting.settings offline_access',
    };
    const fetchImpl = vi.fn().mockResolvedValue(mockJsonResponse(200, tokenBody));

    const tokens = await refreshXeroTokens(config, 'x-refresh-1', fetchImpl);

    const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
    const sent = new URLSearchParams((calledInit as RequestInit).body as string);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('x-refresh-1');

    expect(tokens.accessToken).toBe('x-access-2');
    // CRITICAL for Xero: refresh tokens rotate. The new value must be
    // returned and persisted by the caller.
    expect(tokens.refreshToken).toBe('x-refresh-2-rotated');
  });

  it('throws OAuthError with stage="token-refresh" on failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockErrorResponse(400, '{"error":"invalid_grant"}'));
    try {
      await refreshXeroTokens(config, 'rt', fetchImpl);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).stage).toBe('token-refresh');
    }
  });
});

describe('getXeroConnections', () => {
  it('GETs the connections endpoint with bearer auth and returns parsed rows', async () => {
    const rows = [
      {
        id: 'conn-1',
        authEventId: 'auth-1',
        tenantId: 'tnt-1',
        tenantType: 'ORGANISATION',
        tenantName: 'Demo Co',
        createdDateUtc: '2024-01-01',
        updatedDateUtc: '2024-01-01',
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(mockJsonResponse(200, rows));

    const result = await getXeroConnections('access-1', fetchImpl);

    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] ?? [];
    expect(calledUrl).toBe('https://api.xero.com/connections');
    const headers = (calledInit as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer access-1');

    expect(result).toEqual([
      {
        id: 'conn-1',
        tenantId: 'tnt-1',
        tenantType: 'ORGANISATION',
        tenantName: 'Demo Co',
      },
    ]);
  });

  it('returns multiple connections when present', async () => {
    const rows = [
      {
        id: 'c1',
        tenantId: 't1',
        tenantType: 'ORGANISATION',
        tenantName: 'A',
      },
      {
        id: 'c2',
        tenantId: 't2',
        tenantType: 'PRACTICEMANAGER',
        tenantName: 'B',
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(mockJsonResponse(200, rows));
    const result = await getXeroConnections('access', fetchImpl);
    expect(result).toHaveLength(2);
    expect(result[1]?.tenantId).toBe('t2');
  });

  it('throws OAuthError stage="connections" on non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockErrorResponse(401, 'Unauthorized'));
    try {
      await getXeroConnections('access', fetchImpl);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).stage).toBe('connections');
    }
  });

  it('throws OAuthError when the response is not an array', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockJsonResponse(200, { unexpected: 'shape' }));
    await expect(getXeroConnections('access', fetchImpl)).rejects.toThrow(/not an array/);
  });

  it('throws OAuthError when a row is missing required fields', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockJsonResponse(200, [{ id: 'only-id' }]));
    await expect(getXeroConnections('access', fetchImpl)).rejects.toThrow(/Malformed/);
  });
});
