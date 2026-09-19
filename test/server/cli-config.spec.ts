import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ start: vi.fn(), scheduler: vi.fn(), listen: vi.fn() }));
vi.mock('dotenv/config', () => ({}));
vi.mock('../../src/server/index.js', () => ({
  createServer: () => ({ app: { listen: mocks.listen } }),
}));
vi.mock('../../src/server/scheduler.js', () => ({
  createScheduler: mocks.scheduler.mockImplementation(() => ({
    start: mocks.start,
    stop: vi.fn(),
  })),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.scheduler.mockImplementation(() => ({ start: mocks.start, stop: vi.fn() }));
  for (const name of Object.keys(process.env)) {
    if (/^(LEDGERLY_|STRIPE_|PORT$)/.test(name)) vi.stubEnv(name, '');
  }
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_local_only');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_local_only');
  vi.stubEnv('LEDGERLY_LOG_LEVEL', 'error');
  vi.stubEnv('LEDGERLY_SCHEDULER_ENABLED', 'true');
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${String(code)}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('CLI dispatch setup', () => {
  it.each(['QBO', 'XERO'])(
    'refuses incomplete %s setup before starting the scheduler',
    async (provider) => {
      vi.stubEnv(`LEDGERLY_${provider}_ACCESS_TOKEN`, 'local-token');
      await expect(import('../../src/server/cli.js')).rejects.toThrow('exit:1');
      expect(mocks.scheduler).not.toHaveBeenCalled();
      expect(mocks.start).not.toHaveBeenCalled();
    },
  );

  it.each(['QBO', 'XERO'])('refuses %s OAuth without an account map', async (provider) => {
    vi.stubEnv(`LEDGERLY_${provider}_CLIENT_ID`, 'local-id');
    vi.stubEnv(`LEDGERLY_${provider}_CLIENT_SECRET`, 'local-secret');
    vi.stubEnv(`LEDGERLY_${provider}_REDIRECT_URI`, 'http://localhost/callback');
    vi.stubEnv('LEDGERLY_OAUTH_STATE_SECRET', 'local-state-secret-32-characters-long');
    vi.stubEnv('LEDGERLY_ADMIN_TOKEN', 'local-admin-token-32-characters-long');
    await expect(import('../../src/server/cli.js')).rejects.toThrow('exit:1');
    expect(mocks.scheduler).not.toHaveBeenCalled();
  });

  it('requires an explicit choice before marking console-only output posted', async () => {
    await expect(import('../../src/server/cli.js')).rejects.toThrow('exit:1');
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it('allows explicitly requested console-only development', async () => {
    vi.stubEnv('LEDGERLY_DISPATCHER', 'console');
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    await import('../../src/server/cli.js');
    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.listen).toHaveBeenCalledOnce();
    on.mockRestore();
  });
});
