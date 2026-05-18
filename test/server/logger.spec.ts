import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Writable } from 'node:stream';
import { consoleLogger, jsonLogger, silentLogger } from '../../src/server/logger.js';

describe('consoleLogger', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    debugSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("default level ('info')", () => {
    it('suppresses debug', () => {
      const log = consoleLogger();
      log.debug('hidden');
      expect(debugSpy).not.toHaveBeenCalled();
    });

    it('forwards info, warn, error', () => {
      const log = consoleLogger();
      log.info('hi');
      log.warn('careful');
      log.error('boom');
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("level: 'debug'", () => {
    it('forwards all levels', () => {
      const log = consoleLogger({ level: 'debug' });
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("level: 'warn'", () => {
    it('forwards only warn + error', () => {
      const log = consoleLogger({ level: 'warn' });
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("level: 'error'", () => {
    it('forwards only error', () => {
      const log = consoleLogger({ level: 'error' });
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('meta forwarding', () => {
    it('forwards meta to the underlying console method when provided', () => {
      const log = consoleLogger({ level: 'debug' });
      const meta = { eventId: 'evt_123', count: 4 };
      log.info('processed', meta);
      expect(logSpy).toHaveBeenCalledWith('processed', meta);
    });

    it('does NOT pass undefined as a second argument when meta is omitted', () => {
      const log = consoleLogger({ level: 'debug' });
      log.info('no meta');
      expect(logSpy).toHaveBeenCalledTimes(1);
      const args = logSpy.mock.calls[0] ?? [];
      // Only one argument: the message. Don't pass `undefined` through to
      // console.log; pino/winston adapters would see a stray slot.
      expect(args.length).toBe(1);
      expect(args[0]).toBe('no meta');
    });

    it('forwards meta on debug / warn / error too', () => {
      const log = consoleLogger({ level: 'debug' });
      log.debug('d', { x: 1 });
      log.warn('w', { x: 2 });
      log.error('e', { x: 3 });
      expect(debugSpy).toHaveBeenCalledWith('d', { x: 1 });
      expect(warnSpy).toHaveBeenCalledWith('w', { x: 2 });
      expect(errorSpy).toHaveBeenCalledWith('e', { x: 3 });
    });
  });
});

describe('silentLogger', () => {
  let debugSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    debugSpy.mockRestore();
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('discards everything (all 4 methods are no-ops)', () => {
    const log = silentLogger();
    log.debug('d', { x: 1 });
    log.info('i', { x: 1 });
    log.warn('w', { x: 1 });
    log.error('e', { x: 1 });
    expect(debugSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not throw when called without meta', () => {
    const log = silentLogger();
    expect(() => {
      log.debug('d');
      log.info('i');
      log.warn('w');
      log.error('e');
    }).not.toThrow();
  });
});

/**
 * Capture writes to an in-memory stream so the tests can read back what the
 * logger emitted without touching the real process.stdout/stderr.
 */
function captureStream(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb): void {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((l) => l.length > 0),
  };
}

describe('jsonLogger', () => {
  let out: ReturnType<typeof captureStream>;
  let err: ReturnType<typeof captureStream>;

  beforeEach(() => {
    out = captureStream();
    err = captureStream();
  });

  it('emits one JSON object per line to stdout for info', () => {
    const log = jsonLogger({ out: out.stream, err: err.stream });
    log.info('hello', { eventId: 'evt_1' });
    const lines = out.lines();
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(parsed['msg']).toBe('hello');
    expect(parsed['level']).toBe('info');
    expect(parsed['eventId']).toBe('evt_1');
    expect(typeof parsed['ts']).toBe('string');
    expect((parsed['ts'] as string).match(/^\d{4}-\d{2}-\d{2}T/)).toBeTruthy();
  });

  it('routes debug/info to out, warn/error to err', () => {
    const log = jsonLogger({ level: 'debug', out: out.stream, err: err.stream });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(
      out.lines().map((l) => (JSON.parse(l) as { level: string }).level),
    ).toEqual(['debug', 'info']);
    expect(
      err.lines().map((l) => (JSON.parse(l) as { level: string }).level),
    ).toEqual(['warn', 'error']);
  });

  it('respects the level threshold', () => {
    const log = jsonLogger({ level: 'warn', out: out.stream, err: err.stream });
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(out.lines()).toEqual([]);
    expect(
      err.lines().map((l) => (JSON.parse(l) as { level: string }).level),
    ).toEqual(['warn', 'error']);
  });

  it('serializes Error instances inside meta (name, message, stack)', () => {
    const log = jsonLogger({ out: out.stream, err: err.stream });
    const boom = new Error('boom');
    log.error('failed', { eventId: 'evt_1', err: boom });
    const parsed = JSON.parse(err.lines()[0] ?? '') as Record<string, unknown>;
    const errField = parsed['err'] as Record<string, unknown>;
    expect(errField['name']).toBe('Error');
    expect(errField['message']).toBe('boom');
    expect(typeof errField['stack']).toBe('string');
  });

  it('serializes a top-level Error meta under an `err` key', () => {
    const log = jsonLogger({ out: out.stream, err: err.stream });
    const boom = new TypeError('bad cast');
    log.error('failed', boom);
    const parsed = JSON.parse(err.lines()[0] ?? '') as Record<string, unknown>;
    const errField = parsed['err'] as Record<string, unknown>;
    expect(errField['name']).toBe('TypeError');
    expect(errField['message']).toBe('bad cast');
  });

  it('preserves non-object meta under a `meta` key', () => {
    const log = jsonLogger({ out: out.stream, err: err.stream });
    log.info('count', 42);
    const parsed = JSON.parse(out.lines()[0] ?? '') as Record<string, unknown>;
    expect(parsed['meta']).toBe(42);
  });

  it('protects standard fields from meta-key shadowing', () => {
    const log = jsonLogger({ out: out.stream, err: err.stream });
    // Caller carelessly names a meta key 'level' — the standard level wins.
    log.warn('uh oh', { level: 'looks-like-debug', ts: 'fake-timestamp' });
    const parsed = JSON.parse(err.lines()[0] ?? '') as Record<string, unknown>;
    expect(parsed['level']).toBe('warn');
    expect((parsed['ts'] as string).match(/^\d{4}-\d{2}-\d{2}T/)).toBeTruthy();
  });

  it('emits valid JSON even with no meta', () => {
    const log = jsonLogger({ out: out.stream, err: err.stream });
    log.info('plain');
    const parsed = JSON.parse(out.lines()[0] ?? '') as Record<string, unknown>;
    expect(parsed['msg']).toBe('plain');
    expect(parsed['level']).toBe('info');
  });
});
