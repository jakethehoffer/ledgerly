import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import Stripe from 'stripe';
import { createServer } from '../../src/server/index.js';
import type { OAuthServerConfig } from '../../src/server/index.js';
import { createStateSigner } from '../../src/server/oauth/state.js';
import { silentLogger } from '../../src/server/logger.js';

const STATE_SECRET = 'a'.repeat(48);

const stripe = new Stripe('sk_test_dummy');

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeOauthConfig(
  overrides: Partial<OAuthServerConfig> = {},
  fetchImpl?: typeof globalThis.fetch,
): OAuthServerConfig {
  return {
    stateSecret: STATE_SECRET,
    qbo: {
      clientId: 'qbo-cid',
      clientSecret: 'qbo-csec',
      redirectUri: 'http://localhost:3000/oauth/qbo/callback',
    },
    xero: {
      clientId: 'xero-cid',
      clientSecret: 'xero-csec',
      redirectUri: 'http://localhost:3000/oauth/xero/callback',
    },
    ...(fetchImpl !== undefined ? { fetch: fetchImpl } : {}),
    ...overrides,
  };
}

describe('OAuth endpoints', () => {
  describe('GET /oauth/qbo/start', () => {
    it('302-redirects to Intuit with a signed state', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig(),
      });
      const res = await request(app).get('/oauth/qbo/start');
      expect(res.status).toBe(302);
      const loc = res.headers['location'];
      expect(loc).toBeTruthy();
      const url = new URL(loc ?? '');
      expect(url.origin + url.pathname).toBe('https://appcenter.intuit.com/connect/oauth2');
      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();
      // The receiver's signer verifies its own state.
      const signer = createStateSigner(STATE_SECRET);
      const payload = signer.verify(state ?? '');
      expect(payload.provider).toBe('qbo');
    });
  });

  describe('GET /oauth/qbo/callback', () => {
    it('200 + persists tokens with a valid state, code, and realmId', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          scope: 'com.intuit.quickbooks.accounting',
        }),
      );
      const { app, storage } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig({}, fetchImpl),
      });
      const signer = createStateSigner(STATE_SECRET);
      const state = signer.sign({ provider: 'qbo' });

      const res = await request(app)
        .get('/oauth/qbo/callback')
        .query({ code: 'AUTH-CODE', state, realmId: 'realm-9' });

      expect(res.status).toBe(200);
      expect(res.text).toContain('QBO connected');
      const stored = storage.oauth.get('qbo');
      expect(stored?.tenantId).toBe('realm-9');
      expect(stored?.accessToken).toBe('a');
      expect(stored?.refreshToken).toBe('r');
    });

    it('escapes a malicious realmId in the success page (no reflected XSS)', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(
        jsonResponse(200, {
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 3600,
          scope: 'com.intuit.quickbooks.accounting',
        }),
      );
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig({}, fetchImpl),
      });
      const signer = createStateSigner(STATE_SECRET);
      const state = signer.sign({ provider: 'qbo' });
      const evil = '<script>alert(1)</script>';

      const res = await request(app)
        .get('/oauth/qbo/callback')
        .query({ code: 'AUTH-CODE', state, realmId: evil });

      expect(res.status).toBe(200);
      // The raw script tag must not appear; the escaped form must.
      expect(res.text).not.toContain('<script>alert(1)</script>');
      expect(res.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    });

    it('400 when state is missing', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig(),
      });
      const res = await request(app)
        .get('/oauth/qbo/callback')
        .query({ code: 'C', realmId: 'r' });
      expect(res.status).toBe(400);
    });

    it('400 when state is invalid (tampered)', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig(),
      });
      const res = await request(app)
        .get('/oauth/qbo/callback')
        .query({ code: 'C', state: 'not-a-valid-state', realmId: 'r' });
      expect(res.status).toBe(400);
    });

    it('400 when state is expired', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig(),
      });
      const signer = createStateSigner(STATE_SECRET);
      const expiredState = signer.sign({ provider: 'qbo' }, -10);
      const res = await request(app)
        .get('/oauth/qbo/callback')
        .query({ code: 'C', state: expiredState, realmId: 'r' });
      expect(res.status).toBe(400);
    });

    it('400 when realmId is missing', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig(),
      });
      const signer = createStateSigner(STATE_SECRET);
      const state = signer.sign({ provider: 'qbo' });
      const res = await request(app)
        .get('/oauth/qbo/callback')
        .query({ code: 'C', state });
      expect(res.status).toBe(400);
    });

    it('400 when state is for the wrong provider (xero state on qbo callback)', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig(),
      });
      const signer = createStateSigner(STATE_SECRET);
      const xeroState = signer.sign({ provider: 'xero' });
      const res = await request(app)
        .get('/oauth/qbo/callback')
        .query({ code: 'C', state: xeroState, realmId: 'r' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /oauth/xero/start', () => {
    it('302-redirects to Xero with a signed state', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig(),
      });
      const res = await request(app).get('/oauth/xero/start');
      expect(res.status).toBe(302);
      const loc = res.headers['location'];
      const url = new URL(loc ?? '');
      expect(url.origin + url.pathname).toBe(
        'https://login.xero.com/identity/connect/authorize',
      );
      const signer = createStateSigner(STATE_SECRET);
      const payload = signer.verify(url.searchParams.get('state') ?? '');
      expect(payload.provider).toBe('xero');
    });
  });

  describe('GET /oauth/xero/callback', () => {
    it('200 + persists tokens with a valid state, code, and fetched tenant', async () => {
      // First fetch: token exchange. Second fetch: connections.
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, {
            access_token: 'xa',
            refresh_token: 'xr',
            expires_in: 1800,
            scope: 'accounting.transactions accounting.settings offline_access',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, [
            {
              id: 'c1',
              tenantId: 'tnt-7',
              tenantType: 'ORGANISATION',
              tenantName: 'Demo Co',
            },
          ]),
        );

      const { app, storage } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig({}, fetchImpl),
      });
      const signer = createStateSigner(STATE_SECRET);
      const state = signer.sign({ provider: 'xero' });

      const res = await request(app)
        .get('/oauth/xero/callback')
        .query({ code: 'CODE', state });

      expect(res.status).toBe(200);
      expect(res.text).toContain('XERO connected');
      const stored = storage.oauth.get('xero');
      expect(stored?.tenantId).toBe('tnt-7');
      expect(stored?.accessToken).toBe('xa');
      expect(stored?.refreshToken).toBe('xr');
    });

    it('400 on invalid state', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig(),
      });
      const res = await request(app)
        .get('/oauth/xero/callback')
        .query({ code: 'C', state: 'bogus' });
      expect(res.status).toBe(400);
    });

    it('502 when token exchange fails', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('nope', {
            status: 400,
            headers: { 'Content-Type': 'text/plain' },
          }),
        );
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig({}, fetchImpl),
      });
      const signer = createStateSigner(STATE_SECRET);
      const state = signer.sign({ provider: 'xero' });
      const res = await request(app)
        .get('/oauth/xero/callback')
        .query({ code: 'C', state });
      expect(res.status).toBe(502);
    });

    it('502 when connections lookup returns empty array', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, {
            access_token: 'xa',
            refresh_token: 'xr',
            expires_in: 1800,
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, []));
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig({}, fetchImpl),
      });
      const signer = createStateSigner(STATE_SECRET);
      const state = signer.sign({ provider: 'xero' });
      const res = await request(app)
        .get('/oauth/xero/callback')
        .query({ code: 'C', state });
      expect(res.status).toBe(502);
    });

    it('uses the first tenant when Xero returns multiple connections', async () => {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, {
            access_token: 'xa',
            refresh_token: 'xr',
            expires_in: 1800,
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, [
            { id: 'c1', tenantId: 'first', tenantType: 'ORGANISATION', tenantName: 'A' },
            { id: 'c2', tenantId: 'second', tenantType: 'ORGANISATION', tenantName: 'B' },
          ]),
        );
      const { app, storage } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: makeOauthConfig({}, fetchImpl),
      });
      const signer = createStateSigner(STATE_SECRET);
      const state = signer.sign({ provider: 'xero' });
      const res = await request(app)
        .get('/oauth/xero/callback')
        .query({ code: 'C', state });
      expect(res.status).toBe(200);
      expect(storage.oauth.get('xero')?.tenantId).toBe('first');
    });
  });

  describe('routes not mounted without config', () => {
    it('returns 404 when oauth config is absent', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
      });
      const a = await request(app).get('/oauth/qbo/start');
      expect(a.status).toBe(404);
      const b = await request(app).get('/oauth/xero/start');
      expect(b.status).toBe(404);
    });

    it('returns 404 for an unconfigured provider when only the other is set', async () => {
      const { app } = createServer({
        stripe,
        webhookSecret: 'whsec_',
        log: silentLogger(),
        oauth: {
          stateSecret: STATE_SECRET,
          qbo: {
            clientId: 'qbo',
            clientSecret: 's',
            redirectUri: 'http://localhost/oauth/qbo/callback',
          },
        },
      });
      const a = await request(app).get('/oauth/qbo/start');
      expect(a.status).toBe(302);
      const b = await request(app).get('/oauth/xero/start');
      expect(b.status).toBe(404);
    });
  });
});
