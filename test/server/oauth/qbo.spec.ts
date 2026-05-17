import { describe, it, expect, vi } from 'vitest';
import {
  buildQboAuthUrl,
  exchangeQboCode,
  refreshQboTokens,
} from '../../../src/server/oauth/qbo.js';
import { OAuthError } from '../../../src/server/oauth/types.js';
import type { OAuthClientConfig } from '../../../src/server/oauth/types.js';

const config: OAuthClientConfig = {
  clientId: 'client-id-xyz',
  clientSecret: 'client-secret-abc',
  redirectUri: 'https://example.com/oauth/qbo/callback',
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

describe('buildQboAuthUrl', () => {
  it('points at the QBO authorize endpoint with the right query params', () => {
    const url = new URL(buildQboAuthUrl(config, 'STATE-TOKEN'));
    expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
    expect(url.searchParams.get('client_id')).toBe('client-id-xyz');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://example.com/oauth/qbo/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('com.intuit.quickbooks.accounting');
    expect(url.searchParams.get('state')).toBe('STATE-TOKEN');
  });

  it('URL-encodes the state parameter', () => {
    const url = new URL(buildQboAuthUrl(config, 'a b/c=d'));
    expect(url.searchParams.get('state')).toBe('a b/c=d');
  });
});

describe('exchangeQboCode', () => {
  it('POSTs to the token endpoint with Basic auth + form body and parses the response', async () => {
    const tokenBody = {
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expires_in: 3600,
      token_type: 'bearer',
      scope: 'com.intuit.quickbooks.accounting',
    };
    const fetchImpl = vi.fn().mockResolvedValue(mockJsonResponse(200, tokenBody));

    const before = Math.floor(Date.now() / 1000);
    const tokens = await exchangeQboCode(config, 'AUTH-CODE', fetchImpl);
    const after = Math.floor(Date.now() / 1000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] ?? [];
    expect(calledUrl).toBe('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer');

    const init = calledInit as RequestInit;
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    const expectedBasic =
      'Basic ' + Buffer.from('client-id-xyz:client-secret-abc').toString('base64');
    expect(headers['Authorization']).toBe(expectedBasic);
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');

    // Body is URL-encoded; parse it back so order doesn't matter.
    const sent = new URLSearchParams(init.body as string);
    expect(sent.get('grant_type')).toBe('authorization_code');
    expect(sent.get('code')).toBe('AUTH-CODE');
    expect(sent.get('redirect_uri')).toBe('https://example.com/oauth/qbo/callback');

    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    // expires_in=3600, safety margin 30s → expiresAt is ~now+3570
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 3600 - 30 - 1);
    expect(tokens.expiresAt).toBeLessThanOrEqual(after + 3600 - 30);
    expect(tokens.scope).toBe('com.intuit.quickbooks.accounting');
  });

  it('throws OAuthError on a 400 response', async () => {
    // Each call needs a fresh Response — the body stream can only be read once
    // and exchangeQboCode reads it to build the error message.
    const fetchImpl = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(mockErrorResponse(400, '{"error":"invalid_grant"}')),
      );
    await expect(exchangeQboCode(config, 'BAD-CODE', fetchImpl)).rejects.toThrow(OAuthError);
    await expect(exchangeQboCode(config, 'BAD-CODE', fetchImpl)).rejects.toThrow(/400/);
    await expect(exchangeQboCode(config, 'BAD-CODE', fetchImpl)).rejects.toThrow(
      /invalid_grant/,
    );
  });

  it('throws OAuthError on a 401 response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockErrorResponse(401, 'Unauthorized'));
    await expect(exchangeQboCode(config, 'CODE', fetchImpl)).rejects.toThrow(OAuthError);
  });

  it('throws OAuthError on a 5xx response', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockErrorResponse(503, 'Service Unavailable'));
    await expect(exchangeQboCode(config, 'CODE', fetchImpl)).rejects.toThrow(/503/);
  });

  it('throws OAuthError on a malformed success response (missing fields)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockJsonResponse(200, { access_token: 'only-this' }));
    await expect(exchangeQboCode(config, 'CODE', fetchImpl)).rejects.toThrow(/Malformed/);
  });

  it('error stage is "token-exchange"', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockErrorResponse(400, 'nope'));
    try {
      await exchangeQboCode(config, 'CODE', fetchImpl);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).provider).toBe('qbo');
      expect((err as OAuthError).stage).toBe('token-exchange');
    }
  });
});

describe('refreshQboTokens', () => {
  it('POSTs grant_type=refresh_token and parses the response', async () => {
    const tokenBody = {
      access_token: 'access-2',
      refresh_token: 'refresh-2-rotated',
      expires_in: 3600,
      token_type: 'bearer',
      scope: 'com.intuit.quickbooks.accounting',
    };
    const fetchImpl = vi.fn().mockResolvedValue(mockJsonResponse(200, tokenBody));

    const tokens = await refreshQboTokens(config, 'refresh-1', fetchImpl);

    const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
    const sent = new URLSearchParams((calledInit as RequestInit).body as string);
    expect(sent.get('grant_type')).toBe('refresh_token');
    expect(sent.get('refresh_token')).toBe('refresh-1');

    expect(tokens.accessToken).toBe('access-2');
    expect(tokens.refreshToken).toBe('refresh-2-rotated');
  });

  it('throws OAuthError with stage="token-refresh" on failure', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockErrorResponse(400, '{"error":"invalid_grant"}'));
    try {
      await refreshQboTokens(config, 'refresh', fetchImpl);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthError);
      expect((err as OAuthError).stage).toBe('token-refresh');
    }
  });
});
