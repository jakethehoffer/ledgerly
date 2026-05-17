/**
 * Minimal structured logger contract. Downstream consumers can wire this to
 * pino, winston, or a custom backend; ledgerly does not depend on any
 * specific logger library.
 *
 * Each method takes a message string and optional structured metadata. The
 * metadata is logger-implementation-defined — pino expects it before the
 * message, winston expects it after, etc. The default `consoleLogger`
 * formats it as a JSON object alongside the message.
 */
export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/**
 * Options for {@link consoleLogger}.
 *
 * `level` filters output below the configured threshold. Default `'info'`
 * suppresses debug-level messages. Set `'debug'` for verbose output.
 */
export interface ConsoleLoggerOptions {
  readonly level?: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Default console-backed logger. Maps levels to `console.log` / `.warn` /
 * `.error`, with `debug` going to `console.debug` (typically same as
 * `console.log` on Node).
 */
export function consoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const priority = { debug: 10, info: 20, warn: 30, error: 40 } as const;
  const threshold = priority[level];

  function emit(
    method: (msg: string, ...meta: unknown[]) => void,
    msg: string,
    meta?: unknown,
  ): void {
    if (meta === undefined) {
      method(msg);
    } else {
      method(msg, meta);
    }
  }

  return {
    debug(msg, meta): void {
      if (priority.debug >= threshold) {
        // eslint-disable-next-line no-console
        emit(console.debug.bind(console), msg, meta);
      }
    },
    info(msg, meta): void {
      if (priority.info >= threshold) {
        // eslint-disable-next-line no-console
        emit(console.log.bind(console), msg, meta);
      }
    },
    warn(msg, meta): void {
      if (priority.warn >= threshold) {
        // eslint-disable-next-line no-console
        emit(console.warn.bind(console), msg, meta);
      }
    },
    error(msg, meta): void {
      if (priority.error >= threshold) {
        // eslint-disable-next-line no-console
        emit(console.error.bind(console), msg, meta);
      }
    },
  };
}

/** A logger that discards all output. Useful in tests. */
export function silentLogger(): Logger {
  return {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
  };
}
