import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { consoleLogger, silentLogger } from '../../src/server/logger.js';

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
